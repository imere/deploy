/**
 * `dp apply` / `verify` / `rollback` 接上 docker 之后的接线测试。
 *
 * 三类覆盖，缺一不可：
 *  1. **顺序** —— docker 的 install（stat 确认文件）必须在 deploy 传输**之后**。
 *     顺序错了不会报编译错，只会「compose 文件还没传上去就被判定不存在」。
 *  2. **失败语义** —— up 失败**不做任何补偿**，但必须把 healing 带出来；
 *     读不出结论一律当失败，绝不判通过。
 *  3. **零回归** —— 没配 target.docker 时的行为与接入前逐字一致。
 *
 * 全程不碰网络、不起真 docker：exec 走注入的 FakeRunner，部署走 fake transfer。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DpError, type ExecResult, type Facts, type FileStat, type Runner } from '@dp/ports'
import { main } from './index.js'
import type { ApplyDeps } from './deps.js'

// ------------------------------------------------------------
// 夹具
// ------------------------------------------------------------

interface ExecDecision {
  readonly code: number
  readonly stdout?: string
  readonly stderr?: string
}

/** 一份「全绿」的 ps 输出。默认给这份，让「不通过」必须是显式指定才发生 */
function healthyPs(services: readonly string[] = ['api']): string {
  return services
    .map((s) => JSON.stringify({ Service: s, State: 'running', Health: 'healthy', Status: 'Up 2 minutes' }))
    .join('\n')
}

class FakeRunner implements Runner {
  readonly id = 'fake'
  readonly facts: Facts
  /** 事件时间线。顺序类断言只看它 */
  readonly events: string[] = []
  /** 每次 exec 的 argv + cwd。元素级断言用它，不用事件串 */
  readonly execs: { readonly argv: readonly string[]; readonly cwd: string | undefined }[] = []
  private readonly tree = new Map<string, string | null>()
  /** 命中 argv 时强制给一个结论（优先于默认） */
  failWhen: (argv: readonly string[]) => ExecDecision | undefined = () => undefined
  /** ps 输出的内容。默认全绿 */
  psStdout: () => string = () => healthyPs()

  constructor(facts: Facts) {
    this.facts = facts
    this.tree.set('/', null)
  }

  async exec(argv: readonly string[], options?: { readonly cwd?: string }): Promise<ExecResult> {
    this.events.push(`exec ${argv.join(' ')}`)
    this.execs.push({ argv: [...argv], cwd: options?.cwd })
    const forced = this.failWhen(argv)
    if (forced !== undefined) return { code: forced.code, stdout: forced.stdout ?? '', stderr: forced.stderr ?? '' }
    // ps 是只读查询，给一份可解析的输出；其余命令成功且无输出
    if (argv.includes('ps')) return { code: 0, stdout: this.psStdout(), stderr: '' }
    return { code: 0, stdout: '', stderr: '' }
  }

  async stat(path: string): Promise<FileStat | null> {
    this.events.push(`stat ${path}`)
    if (!this.tree.has(path)) return null
    return { isDirectory: this.tree.get(path) === null, isSymbolicLink: false, size: 0, mtimeMs: 0 }
  }

  async listDir(path: string): Promise<readonly string[]> {
    const out: string[] = []
    for (const key of this.tree.keys()) {
      if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) out.push(key.slice(path.length + 1))
    }
    return out
  }

  async mkdir(path: string): Promise<void> {
    this.tree.set(path, null)
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.events.push(`write ${path}`)
    this.tree.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
  }

  async readFile(path: string): Promise<string> {
    const v = this.tree.get(path)
    if (v === undefined) throw new DpError('DP.PATH.NOT_WRITABLE', `不存在：${path}`)
    return v ?? ''
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path))
  }

  async remove(path: string): Promise<void> {
    for (const key of [...this.tree.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.tree.delete(key)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const moved = [...this.tree.entries()].filter(([k]) => k === from || k.startsWith(`${from}/`))
    await this.remove(to)
    for (const [k, v] of moved) {
      this.tree.set(to + k.slice(from.length), v)
      this.tree.delete(k)
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.events.push(`symlink ${linkPath} -> ${target}`)
    this.tree.set(linkPath, target)
  }

  async readlink(path: string): Promise<string | null> {
    return this.tree.get(path) ?? null
  }

  async realpath(path: string): Promise<string> {
    return path
  }

  peek(path: string): string | null {
    const v = this.tree.get(path)
    return v === undefined ? null : v
  }

  /** 手动播种一个「已经部署过」的机器：给 verify / rollback 一个 current 可查 */
  async seedRelease(root: string, releases: readonly string[], current: string): Promise<void> {
    for (const id of releases) {
      await this.mkdir(`${root}/releases/${id}`)
      await this.writeFile(`${root}/releases/${id}/index.html`, 'x')
      await this.writeFile(`${root}/releases/${id}/docker-compose.yml`, 'services: {}\n')
    }
    await this.mkdir(`${root}/.dp`)
    await this.writeFile(
      `${root}/.dp/index.json`,
      JSON.stringify({ current, releases: [...releases], history: [] }, null, 2),
    )
    await this.symlink(`${root}/releases/${current}`, `${root}/current`)
  }
}

function remoteFacts(): Facts {
  return {
    host: 'prod',
    platform: 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: '/home/deployer',
    tmpdir: '/tmp',
    env: {},
    capabilities: {
      canWrite: { '/srv/app': true },
      canChown: [],
      canSymlink: true,
      systemdScope: 'system',
      lingerEnabled: false,
      canBindPrivilegedPort: false,
      sudoAllowlist: [],
    },
    tools: { ssh: '/usr/bin/ssh', rsync: '/usr/bin/rsync', tar: '/bin/tar', scp: '/usr/bin/scp' },
  }
}

interface DockerOptions {
  readonly docker?: boolean
  /** type 链。默认 ['static', 'docker'] */
  readonly type?: readonly string[]
  readonly composeFiles?: readonly string[]
  readonly projectName?: string
  readonly envFile?: string
  readonly pull?: boolean
  readonly wait?: boolean
  readonly healthcheck?: Record<string, unknown>
  /** compose 文件不进 source —— 模拟「没上传」 */
  readonly omitComposeFromSource?: boolean
}

function remoteDeps(runner: FakeRunner): ApplyDeps {
  return {
    acquireFacts: async () => ({ facts: runner.facts, probeNotes: [], close: async () => {}, runner }),
    probeLocalFacts: async () => remoteFacts(),
    transfer: async (req) => {
      runner.events.push(`transfer ${req.entries.length}`)
      await runner.mkdir(req.remoteRoot)
      for (const e of req.entries) {
        const parts = e.split('/')
        for (let i = 1; i < parts.length; i += 1) await runner.mkdir(`${req.remoteRoot}/${parts.slice(0, i).join('/')}`)
        await runner.writeFile(`${req.remoteRoot}/${e}`, 'payload')
      }
      return {
        kind: 'rsync-ssh' as const,
        filesTransferred: req.entries.length,
        command: ['rsync', '-a'],
        exitCode: 0,
        warnings: [],
      }
    },
  }
}

interface Workspace {
  readonly dir: string
  readonly runner: FakeRunner
  readonly run: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string }>
}

async function withWorkspace(fn: (ws: Workspace) => Promise<void>, options: DockerOptions = {}): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-docker-'))
  try {
    await fs.mkdir(join(dir, 'dist'), { recursive: true })
    await fs.writeFile(join(dir, 'dist', 'index.html'), '<h1>v1</h1>', 'utf8')
    // compose 文件默认**在** source 里：它随 release 上传，install 才有东西可 stat
    if (options.omitComposeFromSource !== true) {
      await fs.writeFile(join(dir, 'dist', 'docker-compose.yml'), 'services: {}\n', 'utf8')
    }
    // envFile 同样随 release 上传。不建它的话 install 的 stat 必然失败 ——
    // 那是对的：配置指向一个没人上传的文件本来就该被拒
    if (options.envFile !== undefined) {
      await fs.writeFile(join(dir, 'dist', options.envFile), 'FOO=bar\n', 'utf8')
    }

    const runner = new FakeRunner(remoteFacts())
    // `./dist/**`（内容模式）而不是 `./dist`（目录模式）：compose 文件要落在
    // release 目录**根部**，`-f` 指的正是那里。写成 `./dist` 会把它传成
    // `<release>/dist/docker-compose.yml`，与配置里的相对路径对不上 ——
    // 这正是 install 该报 FILE_MISSING 的那类配置错误
    const project: Record<string, unknown> = { source: { root: './dist/**' }, release: { root: '/srv/app' } }
    if (options.docker === true) {
      const compose: Record<string, unknown> = {
        files: options.composeFiles ?? ['docker-compose.yml'],
        projectName: options.projectName ?? 'api',
      }
      if (options.envFile !== undefined) compose['envFile'] = options.envFile
      if (options.pull !== undefined) compose['pull'] = options.pull
      if (options.wait !== undefined) compose['wait'] = options.wait
      const docker: Record<string, unknown> = { compose }
      if (options.healthcheck !== undefined) docker['healthcheck'] = options.healthcheck
      project['target'] = { type: options.type ?? ['static', 'docker'], docker }
    }

    await fs.writeFile(
      join(dir, 'deploy.config.json'),
      JSON.stringify({ hosts: { prod: { ssh: 'deployer@10.0.0.7' } }, projects: { web: project } }, null, 2),
      'utf8',
    )

    const run = async (command: string, args: readonly string[]): Promise<{ code: number; stdout: string }> => {
      const out: string[] = []
      const code = await main([command, ...args], {
        cwd: dir,
        env: {},
        deps: remoteDeps(runner),
        write: (t) => out.push(t),
        writeErr: () => {},
        isTTY: false,
      })
      return { code, stdout: out.join('') }
    }
    await fn({ dir, runner, run })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function resultOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>
}

/** compose 那些 exec（pull / up / ps），元素级断言用 */
function composeExecs(runner: FakeRunner): { readonly argv: readonly string[]; readonly cwd: string | undefined }[] {
  return runner.execs.filter((e) => e.argv[0] === 'docker')
}

// ------------------------------------------------------------
// ① 顺序：install 在 deploy 之后
// ------------------------------------------------------------

describe('apply 里 docker 的顺序', () => {
  it('transfer 早于 install 的 stat —— compose 文件是随 release 传的', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        const transfer = runner.events.findIndex((e) => e.startsWith('transfer '))
        const firstStat = runner.events.findIndex((e) => e.startsWith('stat '))
        assert.ok(transfer >= 0, 'deploy 没跑传输')
        assert.ok(firstStat >= 0, 'docker 的 install 没 stat')
        assert.ok(transfer < firstStat, 'install 排在传输之前 = 永远判定文件不存在')
      },
      { docker: true },
    )
  })

  it('顺序是 install → pull → up → ps', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await run('apply', [])
        const docker = composeExecs(runner).map((e) => e.argv.join(' '))
        const pull = docker.findIndex((a) => a.endsWith(' pull'))
        const up = docker.findIndex((a) => a.endsWith(' up -d --wait'))
        const ps = docker.findIndex((a) => a.endsWith(' ps --format json'))
        assert.ok(pull >= 0, '没有 pull')
        assert.ok(up >= 0, '没有 up')
        assert.ok(ps >= 0, '没有 ps')
        assert.ok(pull < up, '先 up 后 pull = 本次验的是上一轮的镜像')
        assert.ok(up < ps, '验收必须在起完之后')
      },
      { docker: true },
    )
  })
})

// ------------------------------------------------------------
// ② 成功链路：argv 元素级 + cwd
// ------------------------------------------------------------

describe('apply 的 docker 成功链路', () => {
  it('pull / up 的 argv 逐元素正确，cwd 是 release 目录', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.equal(code, 0)
        const docker = composeExecs(runner)
        const pull = docker.find((e) => e.argv.includes('pull'))
        const up = docker.find((e) => e.argv.includes('up'))
        assert.ok(pull !== undefined && up !== undefined)

        // 元素级：`docker compose -f <abs> -p <name> pull`
        assert.deepEqual(pull.argv, [
          'docker',
          'compose',
          '-f',
          pull.argv[3]!,
          '-p',
          'api',
          'pull',
        ])
        assert.match(pull.argv[3]!, /^\/srv\/app\/releases\/[^/]+\/docker-compose\.yml$/)
        assert.deepEqual(up.argv, ['docker', 'compose', '-f', up.argv[3]!, '-p', 'api', 'up', '-d', '--wait'])

        // cwd 必须是 release 目录：compose 里的相对路径按项目目录解析，cwd 不对
        // 就是「同一个 compose 在两台机器上挂载了不同目录」，而且是静默的
        assert.equal(pull.cwd, pull.argv[3]!.replace(/\/docker-compose\.yml$/, ''))
        assert.equal(up.cwd, pull.cwd)

        const section = resultOf(stdout)['docker'] as Record<string, unknown>
        assert.equal(section['pulled'], true)
        assert.equal(section['started'], true)
        assert.equal(section['dryRun'], false)
        assert.deepEqual(section['skipped'], [])
      },
      { docker: true },
    )
  })

  it('envFile 变成 --env-file，仍是独立元素', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        const pull = composeExecs(runner).find((e) => e.argv.includes('pull'))
        const i = pull?.argv.indexOf('--env-file') ?? -1
        assert.ok(i > 0, '没带 --env-file')
        assert.match(String(pull?.argv[i + 1]), /\.env\.prod$/)
      },
      { docker: true, envFile: '.env.prod' },
    )
  })

  it('pull: false 时不发 pull，但 up 照跑', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        const docker = composeExecs(runner).map((e) => e.argv.join(' '))
        assert.ok(!docker.some((a) => a.endsWith(' pull')), 'pull: false 仍发了 pull')
        assert.ok(docker.some((a) => a.endsWith(' up -d --wait')))
      },
      { docker: true, pull: false },
    )
  })

  it('healthcheck.services 收窄判定范围（ps 照跑，解析在 target 包里）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.equal(code, 0)
        const section = resultOf(stdout)['docker'] as Record<string, unknown>
        const services = section['services'] as { service: string }[]
        assert.equal(services.length, 1)
        assert.equal(services[0]?.service, 'api')
        assert.ok(composeExecs(runner).some((e) => e.argv.includes('ps')))
      },
      { docker: true, healthcheck: { services: ['api'] } },
    )
  })
})

// ------------------------------------------------------------
// ③ install 失败
// ------------------------------------------------------------

describe('compose 文件没上传时', () => {
  it('DP.DOCKER.FILE_MISSING，且一条 pull / up 都没发出去', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0)
        const result = resultOf(stdout)
        const error = result['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.DOCKER.FILE_MISSING')
        // 提示要说清「文件没随 release 传上去」，而不是让用户去查 compose 的写法
        assert.match(String(error['hint']), /source\.root|source\.include|source\.exclude/)

        const docker = composeExecs(runner)
        assert.ok(!docker.some((e) => e.argv.includes('pull')), '文件都没在就不该拉镜像')
        assert.ok(!docker.some((e) => e.argv.includes('up')), '文件都没在就不该起容器')
        // 没起任何东西 = 没有 docker 段可说。不造一个空段是为了不谎报「拉过了起过了」
        assert.equal(result['docker'], undefined)
      },
      { docker: true, omitComposeFromSource: true },
    )
  })
})

// ------------------------------------------------------------
// ④ activate 失败
// ------------------------------------------------------------

describe('up 失败时的收场', () => {
  it('退出码非 0、输出带 healing、没有任何补偿命令', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        runner.failWhen = (argv) => (argv.includes('up') ? { code: 1, stderr: 'service api failed: port is already allocated' } : undefined)
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0, '服务没起来不能报成功')

        const result = resultOf(stdout)
        // 版本本身是好的（deploy 过了健康检查），所以**不回滚**发布
        assert.equal(result['rolledBack'], false)
        const warnings = (result['warnings'] as string[]).join('\n')
        assert.match(warnings, /healing|下一步/, '必须给出人工下一步')

        // docker 的原话要进结果，否则用户只能自己上机器复现一遍。
        // 它挂在失败现场的 output 上，所以查 warnings（不是 message/hint）
        assert.match(warnings, /port is already allocated/)
        // 没有任何自动补偿：既不 down，也不自动 up 上一版
        const docker = composeExecs(runner).map((e) => e.argv.join(' '))
        assert.ok(!docker.some((a) => a.endsWith(' down')), '不许自动 down')
        assert.ok(!docker.some((a) => a.endsWith(' down --build')))
        const error = result['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.ACTIVATE.START_FAILED')
      },
      { docker: true },
    )
  })

  it('pull 失败时也不做任何补偿', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        runner.failWhen = (argv) => (argv.includes('pull') ? { code: 1, stderr: 'Error response from daemon: manifest unknown' } : undefined)
        const { code } = await run('apply', ['--json'])
        assert.notEqual(code, 0)
        const docker = composeExecs(runner).map((e) => e.argv.join(' '))
        assert.ok(!docker.some((a) => a.includes(' up')), 'pull 失败就不该 up')
        assert.ok(!docker.some((a) => a.endsWith(' down')), 'pull 失败不该 down')
      },
      { docker: true },
    )
  })
})

// ------------------------------------------------------------
// ⑤ dry-run
// ------------------------------------------------------------

describe('--dry-run 的 docker 阶段', () => {
  it('pull / up 不跑、ps 跑、skipped 说清「机器上没留下作用」', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--dry-run', '--json'])
        assert.equal(code, 0)
        const result = resultOf(stdout)
        assert.equal(result['filesWritten'], 0)

        const docker = composeExecs(runner).map((e) => e.argv.join(' '))
        assert.ok(!docker.some((a) => a.endsWith(' pull')), 'dry-run 不得拉镜像')
        assert.ok(!docker.some((a) => a.endsWith(' up -d --wait')), 'dry-run 不得起容器')
        // ps 是只读的：dry-run 跑它给出的结论是真的，所以它要 ran 而不是 skipped
        assert.ok(docker.some((a) => a.endsWith(' ps --format json')), 'dry-run 也该读一次 ps')

        const section = result['docker'] as Record<string, unknown>
        assert.equal(section['dryRun'], true)
        const skipped = section['skipped'] as string[]
        assert.ok(skipped.includes('docker.pull'), '没跑的 pull 必须记 skipped')
        assert.ok(skipped.includes('docker.up'), '没跑的 up 必须记 skipped')
        assert.ok(!skipped.includes('docker.ps'), 'ps 真跑了，不能记 skipped')
        assert.ok(!skipped.includes('docker.check-compose-files'), 'stat 真跑了，结论是真的')
        assert.equal(section['pulled'], false, 'dry-run 不得声称拉过了')
        assert.equal(section['started'], false, 'dry-run 不得声称起过了')
      },
      { docker: true },
    )
  })

  it('没配 healthcheck 时，wait: false 的告警要出现（up 不带 --wait 只说明容器被创建）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--dry-run', '--json'])
        assert.equal(code, 0)
        const section = resultOf(stdout)['docker'] as Record<string, unknown>
        const warnings = (section['warnings'] as string[]).join('\n')
        assert.match(warnings, /wait/)
        const up = composeExecs(runner).find((e) => e.argv.includes('up'))
        // dry-run 下 up 不发，但 argv 仍在结果里（来自 plan），这里只确认没有真发
        assert.equal(up, undefined)
      },
      { docker: true, wait: false },
    )
  })
})

// ------------------------------------------------------------
// ⑥ verify / rollback
// ------------------------------------------------------------

describe('dp verify', () => {
  it('ps 不通过退 2（CI 用），并说清哪个服务不健康', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        runner.psStdout = () => JSON.stringify({ Service: 'api', State: 'exited', Health: '', Status: 'Exited (1)' })
        const { code, stdout } = await run('verify', ['--json'])
        assert.equal(code, 2, '验证失败必须是 2（CI 的闸）')
        const result = resultOf(stdout)
        assert.equal(result['ok'], false)
        const error = result['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.VERIFY.FAILED')
        assert.match(String(error['message']), /api|exited/)
      },
      { docker: true },
    )
  })

  it('全绿时退出 0', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        const { code } = await run('verify', ['--json'])
        assert.equal(code, 0)
      },
      { docker: true },
    )
  })

  it('ps 输出读不出来（空）→ 报错，绝不判通过', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        runner.psStdout = () => ''
        const { code, stdout } = await run('verify', ['--json'])
        assert.notEqual(code, 0, '读不出结论就不能放行')
        const error = resultOf(stdout)['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.DOCKER.PS_PARSE_FAILED')
      },
      { docker: true },
    )
  })
})

describe('dp rollback', () => {
  it('没有上一版时不谎报成功', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        const { code, stdout } = await run('rollback', ['--json'])
        assert.notEqual(code, 0, '没有上一版却报成功 = 用户以为线上还有东西在跑')
        const result = resultOf(stdout)
        assert.equal(result['ok'], false)
        const error = result['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.VERIFY.FAILED')
        // 指针不能动
        assert.equal(runner.peek('/srv/app/current'), '/srv/app/releases/r1')
      },
      { docker: true },
    )
  })

  it('有两个版本时用上一版的 compose 重新 up，且不 pull', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1', 'r2'], 'r2')
        const { code, stdout } = await run('rollback', ['--json'])
        assert.equal(code, 0, stdout)
        const docker = composeExecs(runner).map((e) => e.argv.join(' '))
        const ups = docker.filter((a) => a.includes(' up -d --wait'))
        assert.equal(ups.length, 1, `应有且仅有一次 up，实际：${JSON.stringify(docker)}`)
        assert.match(ups[0]!, /releases\/r1\/docker-compose\.yml/, 'up 必须用上一版的 compose 文件')
        // 回滚不 pull：浮动 tag 再拉一次会把上一版换成新镜像，那就不是回滚了
        assert.ok(!docker.some((a) => a.endsWith(' pull')), '回滚不得 pull')
      },
      { docker: true },
    )
  })
})

describe('dp status', () => {
  it('读 compose 状态填进结果（ps 是只读的，不违反零副作用）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        const { code, stdout } = await run('status', ['--json'])
        assert.equal(code, 0)
        const result = resultOf(stdout)
        assert.equal(result['composeRead'], true)
        const services = result['services'] as { service: string; state: string }[]
        assert.equal(services[0]?.service, 'api')
        assert.equal(services[0]?.state, 'running')
      },
      { docker: true },
    )
  })

  it('ps 读失败不让 status 整个失败 —— 说清「读不到 compose 状态」', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        runner.failWhen = (argv) => (argv.includes('ps') ? { code: 1, stderr: 'docker: command not found' } : undefined)
        const { code, stdout } = await run('status', ['--json'])
        assert.equal(code, 0, 'status 查不到不该让整条命令变红')
        const result = resultOf(stdout)
        const warnings = (result['warnings'] as string[]).join('\n')
        assert.match(warnings, /读不到 compose 状态/)
        assert.equal(result['composeRead'], undefined, '没读到就不能说读过')
      },
      { docker: true },
    )
  })

  it('--env 进 docker 的渲染上下文：projectName 里的 ${env} 不能算成空', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        const { code } = await run('status', ['--json', '--env', 'prod'])
        assert.equal(code, 0)
        const ps = composeExecs(runner).find((e) => e.argv.includes('ps'))
        assert.ok(ps !== undefined, '没跑 ps')
        // projectName 与 compose 路径都过渲染，status 里把 ${env} 算成空串会让
        // ps 去查另一个项目名，然后「读不到 compose 状态」—— 看起来像机器坏了
        assert.ok(ps.argv.includes('prod-api'), `projectName 没按 --env 渲染：${ps.argv.join(' ')}`)
      },
      { docker: true, projectName: '${env}-api' },
    )
  })
})

// ------------------------------------------------------------
// ⑦ 零回归
// ------------------------------------------------------------

describe('没配 target.docker 时', () => {
  it('行为与接入前一致：不发任何 docker 命令、结果里没有 docker 段', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.equal(code, 0)
        const result = resultOf(stdout)
        assert.equal(result['ok'], true)
        assert.equal(result['docker'], undefined, '没配 docker 就不该出现这一段')
        assert.deepEqual(composeExecs(runner), [], '不该执行任何 docker 命令')
        assert.ok(runner.peek('/srv/app/current') !== null, '部署本身要照常发生')
      },
      { docker: false },
    )
  })

  it('只写 target.docker 而不含在 type 链里，仍然跑（docker 段存在即接线）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', ['--json'])
        assert.equal(code, 0)
        assert.ok(composeExecs(runner).some((e) => e.argv.includes('up')))
      },
      { docker: true, type: ['static'] },
    )
  })
})
