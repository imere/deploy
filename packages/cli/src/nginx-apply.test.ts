/**
 * `dp apply` 接上 nginx 之后的接线测试。
 *
 * 三类覆盖，缺一不可：
 *  1. **顺序** —— install 的影子校验必须在 deploy 写文件之前，reload 在最后。
 *     顺序错了不会报错，只会「发布成功但 conf 没生效」或「conf 已换但版本没就绪」。
 *  2. **失败语义** —— install 失败不跑 deploy；activate 失败**不回滚 release**。
 *     后者是本仓最容易搞反的一条：conf 失败而版本是好的，退掉发布是雪上加霜。
 *  3. **零回归** —— 没配 target.nginx 时的行为与接入前逐字一致。
 *
 * 全程不碰网络、不起真 nginx：exec 走注入的 FakeRunner，部署走 fake transfer。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DpError, type ExecResult, type Facts, type FileStat, type Runner } from '@dp/ports'
import { main } from './index.js'
import { defaultApplyDeps, type ApplyDeps } from './deps.js'

// ------------------------------------------------------------
// 夹具
// ------------------------------------------------------------

interface ExecDecision {
  readonly code: number
  readonly stdout?: string
  readonly stderr?: string
}

class FakeRunner implements Runner {
  readonly id = 'fake'
  readonly facts: Facts
  /** 事件时间线。顺序类断言只看它 */
  readonly events: string[] = []
  private readonly tree = new Map<string, string | null>()
  private execCount = 0
  /** 按调用次序给出结论；undefined = 一律成功 */
  execDecisions: readonly (ExecDecision | undefined)[] = []
  /** 命中 argv 时强制失败（优先于 execDecisions） */
  failWhen: (argv: readonly string[]) => ExecDecision | undefined = () => undefined

  constructor(facts: Facts) {
    this.facts = facts
    this.tree.set('/', null)
  }

  async exec(argv: readonly string[]): Promise<ExecResult> {
    this.events.push(`exec ${argv.join(' ')}`)
    const decision = this.failWhen(argv) ?? this.execDecisions[this.execCount]
    this.execCount += 1
    const d = decision ?? { code: 0 }
    return { code: d.code, stdout: d.stdout ?? '', stderr: d.stderr ?? '' }
  }

  async stat(path: string): Promise<FileStat | null> {
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
    // 只记「发布根之外」的写：confd 的写由 nginx 步骤的 argv 断言，
    // 这里记了反而让两个阶段的顺序混在一条线里
    if (!path.startsWith('/etc/nginx')) this.events.push(`write ${path}`)
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
    this.tree.set(linkPath, target)
  }

  async readlink(path: string): Promise<string | null> {
    return this.tree.get(path) ?? null
  }

  async realpath(path: string): Promise<string> {
    return path
  }

  /** confd 之下**一个字节都没写**：包括目录 */
  confdResidue(): string[] {
    return [...this.tree.keys()].filter((k) => k.startsWith('/etc/nginx/conf.d'))
  }

  peek(path: string): string | null {
    const v = this.tree.get(path)
    return v === undefined ? null : v
  }
}

function remoteFacts(canWrite: Readonly<Record<string, boolean>> = {}): Facts {
  return {
    host: 'prod',
    platform: 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: '/home/deployer',
    tmpdir: '/tmp',
    env: {},
    capabilities: {
      canWrite: { '/srv/app': true, ...canWrite },
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

const NGINX_BLOCK = {
  serverName: ['web.example.com'],
  root: '${release.current}',
  index: ['index.html'],
  locations: [{ path: '/', tryFiles: '$uri $uri/ /index.html' }],
}

function remoteDeps(runner: FakeRunner): ApplyDeps {
  return {
    acquireFacts: async () => ({ facts: runner.facts, probeNotes: [], close: async () => {}, runner }),
    probeLocalFacts: async () => remoteFacts(),
    transfer: async (req) => {
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
  readonly run: (args: readonly string[]) => Promise<{ code: number; stdout: string }>
}

async function withWorkspace(
  fn: (ws: Workspace) => Promise<void>,
  options: {
    readonly nginx?: boolean
    readonly confd?: string
    readonly canWrite?: Readonly<Record<string, boolean>>
    /** 写进 target.nginx.reload */
    readonly reload?: readonly string[] | false
  } = {},
): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-nginx-'))
  try {
    await fs.mkdir(join(dir, 'dist'), { recursive: true })
    await fs.writeFile(join(dir, 'dist', 'index.html'), '<h1>v1</h1>', 'utf8')
    const runner = new FakeRunner(remoteFacts(options.canWrite))
    const project: Record<string, unknown> = { source: { root: './dist' }, release: { root: '/srv/app' } }
    if (options.nginx === true) {
      const nginx: Record<string, unknown> = { server: NGINX_BLOCK }
      if (options.reload !== undefined) nginx['reload'] = options.reload
      const target: Record<string, unknown> = { type: ['nginx'], nginx }
      if (options.confd !== undefined) target['confd'] = options.confd
      project['target'] = target
    }
    await fs.writeFile(
      join(dir, 'deploy.config.json'),
      JSON.stringify({ hosts: { prod: { ssh: 'deployer@10.0.0.7' } }, projects: { web: project } }, null, 2),
      'utf8',
    )

    const run = async (args: readonly string[]): Promise<{ code: number; stdout: string }> => {
      const out: string[] = []
      const code = await main(['apply', ...args], {
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

// ------------------------------------------------------------
// ① 顺序
// ------------------------------------------------------------

describe('apply 的三段顺序', () => {
  it('install 的影子校验在 deploy 写文件之前，reload 在最后', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run([])
        assert.equal(code, 0)
        const shadowCheck = runner.events.findIndex((e) => e.startsWith('exec nginx -t -c '))
        const firstWrite = runner.events.findIndex((e) => e.startsWith('write '))
        const reload = runner.events.lastIndexOf('exec nginx -s reload')
        assert.ok(shadowCheck >= 0, '影子校验没跑')
        assert.ok(firstWrite >= 0, 'deploy 没写文件')
        assert.ok(shadowCheck < firstWrite, '坏 conf 会在碰发布根之后才被发现')
        assert.equal(reload, runner.events.length - 1, 'reload 必须是最后一个动作')
        // reload 之前必须已经写过发布文件，否则又是「conf 先换、版本没就绪」
        assert.ok(runner.events.slice(0, reload).some((e) => e.startsWith('write /srv/app')))
      },
      { nginx: true, canWrite: { '/etc/nginx/conf.d': true } },
    )
  })

  it('conf 里的 root 指向 current 软链，而不是具体版本目录', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await run([])
        const conf = runner.peek('/etc/nginx/conf.d/web.conf')
        assert.ok(conf !== null, 'conf 没被写进 confd')
        assert.match(conf, /root \/srv\/app\/current;/)
        assert.doesNotMatch(conf, /root \/srv\/app\/releases\//)
      },
      { nginx: true, canWrite: { '/etc/nginx/conf.d': true } },
    )
  })
})

// ------------------------------------------------------------
// ② dryRun
// ------------------------------------------------------------

describe('--dry-run 的 nginx 阶段', () => {
  it('confd 一个字节都没写、没发 reload、deploy 没跑', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run(['--dry-run', '--json'])
        assert.equal(code, 0)
        const result = resultOf(stdout)
        assert.equal(result['filesWritten'], 0)
        assert.deepEqual(runner.confdResidue(), [], 'dryRun 承诺 confd 零残留')
        assert.ok(!runner.events.some((e) => e === 'exec nginx -s reload'), 'dryRun 不得发 reload')
        assert.ok(!runner.events.some((e) => e.startsWith('write /srv/app')), 'dryRun 不得部署')
        // 影子校验照跑：它给的结论是真的
        assert.ok(runner.events.some((e) => e.startsWith('exec nginx -t -c ')))

        const nginx = result['nginx'] as Record<string, unknown>
        assert.equal(nginx['dryRun'], true)
        assert.equal(nginx['reloaded'], false)
        assert.equal(nginx['confd'], '/etc/nginx/conf.d')
        // skipped 的判据是「机器上有没有留下作用」：写候选那步跑了但已被撤销 → skipped
        const skipped = nginx['skipped'] as string[]
        assert.ok(skipped.includes('nginx.write-candidate'), '写过又撤销的步骤必须记 skipped')
        assert.ok(!skipped.includes('nginx.validate-shadow'), '影子校验真跑了，结论是真的，不能记 skipped')
      },
      { nginx: true, canWrite: { '/etc/nginx/conf.d': true } },
    )
  })
})

// ------------------------------------------------------------
// ③ activate 失败
// ------------------------------------------------------------

describe('activate 失败时的收场', () => {
  it('不回滚 release：current 仍指向新版本，退出码非 0，且说清状态', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        // 只让 reload 失败：盘上的 conf 已通过 -t，是 nginx 没收到信号。
        // 这种情况最不该回滚发布
        runner.failWhen = (argv) => (argv.join(' ') === 'nginx -s reload' ? { code: 1, stderr: 'nginx: [emerg] reload' } : undefined)
        const { code, stdout } = await run(['--json'])
        assert.notEqual(code, 0, 'conf 没换就不能报成功')

        const result = resultOf(stdout)
        assert.equal(result['rolledBack'], false, 'conf 失败不退掉一次成功的发布')
        const current = runner.peek('/srv/app/current')
        assert.ok(current !== null && current.includes('releases/'), 'current 必须仍指向新版本')

        const warnings = (result['warnings'] as string[]).join('\n')
        assert.match(warnings, /版本已切到/)
        assert.match(warnings, /conf 未更新/)
        assert.match(warnings, /服务没有中断/)
        assert.match(warnings, /重跑 dp apply/)
        // 说清「旧的 conf 的 root 指向哪里」时，**那个路径必须是真的**。
        // 曾经写成 `${confd}/current`：confd 是 /etc/nginx/conf.d，那里没有 current
        // 这种东西 —— 报一个不存在的路径，比不说更难查（用户会照着它去 ls）
        assert.ok(!warnings.includes('conf.d/current'), `提示里出现了不存在的路径：${warnings}`)
        assert.ok(warnings.includes('/srv/app/current'), `提示没给出真实的软链位置：${warnings}`)
        assert.equal((result['error'] as Record<string, unknown>)['code'], 'DP.NGX.RELOAD_FAILED')
        // conf 仍应是 activate 之后的那份：执行器没撤销就是没撤销
        assert.ok(runner.peek('/etc/nginx/conf.d/web.conf') !== null)
      },
      { nginx: true, canWrite: { '/etc/nginx/conf.d': true } },
    )
  })

  it('reload: false 时不发任何重载命令', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run([])
        assert.equal(code, 0)
        assert.ok(!runner.events.some((e) => e.includes('reload')))
        assert.ok(runner.peek('/etc/nginx/conf.d/web.conf') !== null)
      },
      {
        nginx: true,
        reload: false,
        confd: '/etc/nginx/conf.d',
        canWrite: { '/etc/nginx/conf.d': true },
      },
    )
  })
})

// ------------------------------------------------------------
// ④ install 失败
// ------------------------------------------------------------

describe('install 失败时的收场', () => {
  it('不跑 deploy：一个文件都没写', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        runner.failWhen = (argv) => (argv[0] === 'nginx' && argv[1] === '-t' ? { code: 1, stderr: 'nginx: [emerg] unknown directive' } : undefined)
        const { code, stdout } = await run(['--json'])
        assert.notEqual(code, 0)
        const result = resultOf(stdout)
        assert.equal(result['filesWritten'], 0)
        assert.equal(result['rolledBack'], false, '没写任何东西，没东西可回滚')
        assert.ok(!runner.events.some((e) => e.startsWith('write /srv/app')), 'install 失败后不得部署')
        assert.ok(!runner.events.includes('exec nginx -s reload'))
        assert.equal((result['error'] as Record<string, unknown>)['code'], 'DP.NGX.TEST_FAILED')
      },
      { nginx: true, canWrite: { '/etc/nginx/conf.d': true } },
    )
  })
})

// ------------------------------------------------------------
// ⑤ confd 推导
// ------------------------------------------------------------

describe('confd 推导', () => {
  it('canWrite 命中时用它', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run(['--json'])
        assert.equal(code, 0)
        assert.equal((resultOf(stdout)['nginx'] as Record<string, unknown>)['confd'], '/etc/nginx/conf.d')
        assert.equal((resultOf(stdout)['nginx'] as Record<string, unknown>)['file'], '/etc/nginx/conf.d/web.conf')
        assert.ok(runner.peek('/etc/nginx/conf.d/web.conf') !== null)
      },
      { nginx: true, canWrite: { '/etc/nginx/conf.d': true } },
    )
  })

  it('canWrite 里没有它（没测过或不可写）→ DP.PERM.CONFD_NOT_WRITABLE，且提示不提 chmod', async () => {
    await withWorkspace(
      async ({ run }) => {
        const { code, stdout } = await run(['--json'])
        assert.notEqual(code, 0)
        const result = resultOf(stdout)
        const error = result['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.PERM.CONFD_NOT_WRITABLE')
        assert.equal(error['path'], 'projects.*.target.confd')
        const hint = String(error['hint'])
        assert.match(hint, /target\.confd/, '必须告诉用户显式配置怎么写')
        assert.match(hint, /become/, '不可写是权限问题，提示要指向提权')
        // 判据是「有没有建议 chmod」，不是「有没有出现 chmod」：提示里要**明写禁止**，
        // 只断言字符串不出现，等于逼着把这条禁令也删掉
        assert.match(hint, /不要 chmod 777/)
        assert.doesNotMatch(hint, /(建议|请|可以|试试).{0,4}chmod 777/)
        assert.equal(result['filesWritten'], 0)
      },
      { nginx: true, canWrite: { '/etc/nginx/conf.d': false } },
    )
  })

  it('显式 target.confd 优先于推导', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run(['--json'])
        assert.equal(code, 0)
        const nginx = resultOf(stdout)['nginx'] as Record<string, unknown>
        assert.equal(nginx['confd'], '/opt/nginx/conf.d')
        assert.ok(runner.peek('/opt/nginx/conf.d/web.conf') !== null)
        // 推导值没被误用：不该在 /etc 下留下任何东西
        assert.deepEqual(runner.confdResidue(), [])
      },
      // canWrite 里 /etc 明确可写，但显式配置必须赢 —— 否则「显式覆盖」是一句空话
      { nginx: true, confd: '/opt/nginx/conf.d', canWrite: { '/etc/nginx/conf.d': true } },
    )
  })
})

// ------------------------------------------------------------
// ⑥ 零回归
// ------------------------------------------------------------

describe('没配 target.nginx 时', () => {
  it('行为与接入前一致：不碰 confd、不执行 nginx、结果里没有 nginx 段', async () => {
    await withWorkspace(async ({ runner, run }) => {
      const { code, stdout } = await run(['--json'])
      assert.equal(code, 0)
      const result = resultOf(stdout)
      assert.equal(result['ok'], true)
      assert.equal(result['nginx'], undefined, '没配 nginx 就不该出现这一段')
      assert.ok(!runner.events.some((e) => e.includes('nginx')), '不该出现任何 nginx 动作')
      assert.deepEqual(runner.confdResidue(), [])
      assert.ok(runner.peek('/srv/app/current') !== null, '部署本身要照常发生')
    })
  })
})

// ------------------------------------------------------------
// 装配期：nginx 依赖仍在（defaultApplyDeps 真的带得上）
// ------------------------------------------------------------

describe('装配', () => {
  it('deps 里真的有 acquireFacts / transfer（生产装配未被改坏）', () => {
    const deps = defaultApplyDeps()
    assert.equal(typeof deps.acquireFacts, 'function')
    assert.equal(typeof deps.transfer, 'function')
  })
})
