/**
 * `dp apply` / `verify` / `rollback` 接上 systemd 之后的接线测试。
 *
 * 四类覆盖，缺一不可：
 *  1. **unitDir 推导** —— 三级优先级、scope 分候选、canWrite 缺键即不可写。
 *     推导错了不会报编译错，只会把 unit 写到一台你没收过权的目录上。
 *  2. **顺序** —— install 的影子校验必须在 deploy 之前，activate 的 restart 在最后。
 *     顺序错了不会报编译错，只会「坏 unit 已经落到 unitDir 里」。
 *  3. **失败语义** —— install 失败不跑 deploy；activate 失败**不回滚 release**，
 *     但必须说清机器现在是「unit 没生效」还是「unit 生效了但服务没起来」。
 *  4. **零回归** —— 没配 target.systemd 时的行为与接入前逐字一致。
 *
 * 全程不碰网络、不起真 systemd：exec 走注入的 FakeRunner，部署走 fake transfer。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DpError, type ExecOptions, type ExecResult, type Facts, type FileStat, type Runner, type TargetContext } from '@dp/ports'
import { defineProject, type SystemdConfig } from '@dp/schema'
import { assertExecInvariants, type ExecCall, linuxFacts as baseFacts } from '@dp/testkit'
import { main } from './index.js'
import { resolveUnitDir, systemdConfigFor, type UnitDirSource } from './systemd-config.js'
import type { ApplyDeps } from './deps.js'

// ------------------------------------------------------------
// 夹具
// ------------------------------------------------------------

interface ExecDecision {
  readonly code: number
  readonly stdout?: string
  readonly stderr?: string
}

const UNIT_DIR = '/etc/systemd/system'
const UNIT_FILE = `${UNIT_DIR}/web.service`

class FakeRunner implements Runner {
  readonly id = 'fake'
  readonly facts: Facts
  /** 事件时间线。顺序类断言只看它 */
  readonly events: string[] = []
  /** 每次 exec 的 argv + options。元素级断言用它，不用事件串；铁律 0 的检查也读它 */
  readonly execs: ExecCall[] = []
  private readonly tree = new Map<string, string | null>()
  /** 命中 argv 时强制给一个结论（优先于默认） */
  failWhen: (argv: readonly string[]) => ExecDecision | undefined = () => undefined
  /** is-active 的 stdout。默认 active */
  isActive: () => ExecDecision = () => ({ code: 0, stdout: 'active\n' })

  constructor(facts: Facts) {
    this.facts = facts
    this.tree.set('/', null)
  }

  async exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.events.push(`exec ${argv.join(' ')}`)
    this.execs.push({ argv: [...argv], ...(options !== undefined ? { options } : {}) })
    const forced = this.failWhen(argv)
    if (forced !== undefined) return { code: forced.code, stdout: forced.stdout ?? '', stderr: forced.stderr ?? '' }
    if (argv.includes('is-active')) {
      const d = this.isActive()
      return { code: d.code, stdout: d.stdout ?? '', stderr: d.stderr ?? '' }
    }
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
    // unitDir 里的写单独记一类：混进 write 事件里，「install 写了影子候选」与
    // 「activate 换了生效 unit」就会挤在同一条时间线上，顺序断言再也分不开
    this.events.push(path.startsWith(UNIT_DIR) ? `unit-write ${path}` : `write ${path}`)
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
    // 换向也记一条事件：current 的切换在不同策略下走 rename 或 symlink，
    // 只记其中一条的话，「指针与服务谁先动」这类顺序断言会漏掉一半的情况
    this.events.push(`rename ${from} -> ${to}`)
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

  /** unitDir 之下留下的**任何**东西，含目录 */
  unitDirResidue(): string[] {
    return [...this.tree.keys()].filter((k) => k.startsWith(UNIT_DIR))
  }

  /** 单元事件（`transfer N`）在时间线上的位置。deploy 的传输是它的第一手 */
  deployAt(runner: FakeRunner): number {
    return runner.events.findIndex((e) => e.startsWith('transfer '))
  }

  peek(path: string): string | null {
    const v = this.tree.get(path)
    return v === undefined ? null : v
  }

  /** 手工播种一份「已经部署过」的机器：给 verify / rollback 一个 current 可查 */
  async seedRelease(root: string, releases: readonly string[], current: string): Promise<void> {
    for (const id of releases) {
      await this.mkdir(`${root}/releases/${id}`)
      await this.writeFile(`${root}/releases/${id}/index.html`, 'x')
    }
    await this.mkdir(`${root}/.dp`)
    await this.writeFile(`${root}/.dp/index.json`, JSON.stringify({ current, releases: [...releases], history: [] }, null, 2))
    await this.symlink(`${root}/releases/${current}`, `${root}/current`)
  }
}

function linuxFacts(canWrite: Readonly<Record<string, boolean>>, overrides: Partial<Facts> = {}): Facts {
  return baseFacts({
    host: 'prod',
    homedir: '/home/deployer',
    capabilities: { canWrite: { '/srv/app': true, ...canWrite } },
    tools: { ssh: '/usr/bin/ssh', rsync: '/usr/bin/rsync', tar: '/bin/tar', scp: '/usr/bin/scp' },
    ...overrides,
  })
}

const CTX: TargetContext = { host: 'prod', root: '/srv/app', releaseId: 'r9', keep: 5 }

/** 经 schema 归一化的 systemd 段。用 define* 而不是手搓字面量：夹具与用户写的东西同形 */
function systemdSpec(overrides: Partial<SystemdConfig> = {}): SystemdConfig {
  const spec = defineProject({
    source: { root: './dist' },
    target: {
      type: ['systemd'],
      systemd: { unitDir: UNIT_DIR, execStart: '/usr/bin/node ${release.current}/server.js', ...overrides },
    },
  }).target?.systemd
  assert.ok(spec !== undefined, '夹具自身坏了：target.systemd 缺失')
  return spec
}

/**
 * 「调用方没给 unitDir」的那种形状。
 *
 * schema 把 unitDir 列成**必填**，所以配置文件那条路上它一定在 —— 推导那两级只在
 * 不经过 schema 的调用方（零配置装配、夹具）上才可能触发。这个夹具刻意造出那条形状，
 * 它是那两级唯一真实的使用场景。
 */
function derivable(scope?: 'system' | 'user'): UnitDirSource {
  return { ...(scope !== undefined ? { systemd: { scope } } : {}) }
}

interface SystemdOptions {
  readonly systemd?: boolean
  /** type 链。默认 ['systemd'] */
  readonly type?: readonly string[]
  readonly unitDir?: string
  readonly scope?: 'system' | 'user'
  readonly execStart?: string
  readonly extra?: Record<string, unknown>
  readonly canWrite?: Readonly<Record<string, boolean>>
  readonly platform?: Facts['platform']
  readonly homedir?: string
}

function remoteDeps(runner: FakeRunner): ApplyDeps {
  return {
    acquireFacts: async () => ({ facts: runner.facts, probeNotes: [], close: async () => {}, runner }),
    probeLocalFacts: async () => linuxFacts({}),
    transfer: async (req) => {
      runner.events.push(`transfer ${req.entries.length}`)
      await runner.mkdir(req.remoteRoot)
      for (const e of req.entries) {
        const parts = e.split('/')
        for (let i = 1; i < parts.length; i += 1) await runner.mkdir(`${req.remoteRoot}/${parts.slice(0, i).join('/')}`)
        await runner.writeFile(`${req.remoteRoot}/${e}`, 'payload')
      }
      return { kind: 'rsync-ssh' as const, filesTransferred: req.entries.length, command: ['rsync', '-a'], exitCode: 0, warnings: [] }
    },
  }
}

interface Workspace {
  readonly runner: FakeRunner
  /** stdout 与 stderr 分开：配置期失败在结果文档产生**之前**就抛了，只落在 stderr 上 */
  readonly run: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>
}

async function withWorkspace(fn: (ws: Workspace) => Promise<void>, options: SystemdOptions = {}): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-systemd-'))
  try {
    await fs.mkdir(join(dir, 'dist'), { recursive: true })
    await fs.writeFile(join(dir, 'dist', 'index.html'), '<h1>v1</h1>', 'utf8')

    const facts = linuxFacts(options.canWrite ?? { [UNIT_DIR]: true }, {
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
      ...(options.homedir !== undefined ? { homedir: options.homedir } : {}),
    })
    const runner = new FakeRunner(facts)

    const project: Record<string, unknown> = { source: { root: './dist' }, release: { root: '/srv/app' } }
    if (options.systemd === true) {
      // unitDir **必填**（schema 的 str() 不是 opt）—— 配置文件那条路上它一定在，
      // 所以 `canWrite` 命中与否只影响「用户写的那条路有没有必要」，见 ④ 里那条用例
      const segment: Record<string, unknown> = {
        unitDir: options.unitDir ?? UNIT_DIR,
        execStart: options.execStart ?? '/usr/bin/node ${release.current}/server.js',
      }
      if (options.scope !== undefined) segment['scope'] = options.scope
      for (const [k, v] of Object.entries(options.extra ?? {})) segment[k] = v
      project['target'] = { type: options.type ?? ['systemd'], systemd: segment }
    }
    await fs.writeFile(
      join(dir, 'deploy.config.json'),
      JSON.stringify({ hosts: { prod: { ssh: 'deployer@10.0.0.7' } }, projects: { web: project } }, null, 2),
      'utf8',
    )

    const run = async (command: string, args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
      const out: string[] = []
      const err: string[] = []
      const code = await main([command, ...args], {
        cwd: dir,
        env: {},
        deps: remoteDeps(runner),
        write: (t) => out.push(t),
        writeErr: (t) => err.push(t),
        isTTY: false,
      })
      // 铁律 0 的收尾检查：这一趟发出去的每条命令都带了 timeoutMs、没喂 stdin
      assertExecInvariants(runner)
      return { code, stdout: out.join(''), stderr: err.join('') }
    }
    await fn({ runner, run })
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function resultOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>
}

function systemctlExecs(runner: FakeRunner): readonly (readonly string[])[] {
  return runner.execs.filter((e) => e.argv[0] === 'systemctl' || e.argv[0] === 'systemd-analyze').map((e) => e.argv)
}

// ------------------------------------------------------------
// ① unitDir 推导
// ------------------------------------------------------------

describe('resolveUnitDir 的三级优先级', () => {
  it('显式 unitDir 赢过 canWrite 里可写的候选 —— 否则「显式覆盖」是一句空话', () => {
    const dir = resolveUnitDir({
      facts: linuxFacts({ [UNIT_DIR]: true }),
      target: { systemd: { unitDir: '/opt/units' } },
    })
    assert.equal(dir, '/opt/units')
  })

  it('scope=system：canWrite 命中 /etc/systemd/system 时用它', () => {
    assert.equal(resolveUnitDir({ facts: linuxFacts({ [UNIT_DIR]: true }), target: derivable() }), UNIT_DIR)
  })

  it('scope=user：候选是 <homedir>/.config/systemd/user，不是 system 那一个', () => {
    const facts = linuxFacts({ '/home/deployer/.config/systemd/user': true, [UNIT_DIR]: true })
    const dir = resolveUnitDir({ facts, target: derivable('user') })
    // system scope 那条同样可写，而 user scope 必须赢 —— 两者作用域不同，
    // 选错的后果是 `systemctl --user` 永远读不到这份 unit
    assert.equal(dir, '/home/deployer/.config/systemd/user')
  })

  it('scope=user 且没探到 homedir → 报错，不返回 /.config/systemd/user', () => {
    const facts = linuxFacts({ '/.config/systemd/user': true }, { homedir: '' })
    assert.throws(
      () => resolveUnitDir({ facts, target: derivable('user') }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.PERM.UNIT_DIR_NOT_WRITABLE',
    )
  })

  it('canWrite 里没有那个键 = 不可写（不是「可能可写」）→ DP.PERM.UNIT_DIR_NOT_WRITABLE', () => {
    assert.throws(
      () => resolveUnitDir({ facts: linuxFacts({ '/srv/app': true }), target: derivable() }),
      (err: unknown) => {
        if (!(err instanceof DpError)) return false
        assert.equal(err.code, 'DP.PERM.UNIT_DIR_NOT_WRITABLE')
        assert.equal(err.path, 'projects.*.target.systemd.unitDir')
        assert.match(err.message, /都不可写/, '要说清实测过哪些')
        assert.ok(err.hint !== undefined && /unitDir/.test(err.hint), '提示要告诉用户显式配置怎么写')
        assert.ok(err.hint !== undefined && /become/.test(err.hint), '不可写是权限问题，提示要指向提权')
        // 判据是「有没有建议 chmod」，不是「有没有出现 chmod」：提示里要**明写禁止**
        assert.match(err.hint ?? '', /不要 chmod 777/)
        assert.doesNotMatch(err.hint ?? '', /(建议|请|可以|试试).{0,4}chmod 777/)
        return true
      },
    )
  })

  it('canWrite 明确为 false 与缺键同义', () => {
    assert.throws(
      () => resolveUnitDir({ facts: linuxFacts({ [UNIT_DIR]: false }), target: derivable() }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.PERM.UNIT_DIR_NOT_WRITABLE',
    )
  })

  it('非 linux 平台不给候选：显式给了就用，没给就报错', () => {
    const facts = linuxFacts({ [UNIT_DIR]: true }, { platform: 'darwin' })
    assert.equal(resolveUnitDir({ facts, target: { systemd: { unitDir: '/opt/units' } } }), '/opt/units')
    assert.throws(
      () => resolveUnitDir({ facts, target: derivable() }),
      (err: unknown) => {
        if (!(err instanceof DpError)) return false
        assert.equal(err.code, 'DP.PERM.UNIT_DIR_NOT_WRITABLE')
        // 「这台机器上有没有默认值」与「实测过但不可写」是两回事，报错要分得开
        assert.match(err.message, /darwin/)
        assert.doesNotMatch(err.message, /都不可写/)
        return true
      },
    )
  })
})

// ------------------------------------------------------------
// ② systemdConfigFor 的字段映射
// ------------------------------------------------------------

describe('systemdConfigFor 的字段映射', () => {
  it('必填项 + render 上下文（release.id / release.current 来自 ctx）', () => {
    const config = systemdConfigFor({
      project: 'web',
      env: '',
      envVars: {},
      targetCtx: CTX,
      now: new Date(0),
      systemd: systemdSpec(),
      unitDir: UNIT_DIR,
    })
    assert.equal(config.unitDir, UNIT_DIR)
    assert.equal(config.execStart, '/usr/bin/node ${release.current}/server.js')
    assert.equal(config.render.project, 'web')
    assert.equal(config.render.release?.id, 'r9')
    assert.equal(config.render.release?.current, '/srv/app/current')
  })

  it('可选字段条件展开：没配的键根本不存在，不是 undefined 值', () => {
    const config = systemdConfigFor({
      project: 'web',
      env: '',
      envVars: {},
      targetCtx: CTX,
      now: new Date(0),
      systemd: systemdSpec(),
      unitDir: UNIT_DIR,
    })
    for (const key of ['unit', 'description', 'execReload', 'workingDirectory', 'user', 'group', 'environment', 'after', 'requires', 'extra']) {
      assert.ok(!(key in config), `${key} 不该出现：schema 的默认值由执行器兜，不该在这里补一个 undefined`)
    }
  })

  it('配了的可选字段逐个搬过去', () => {
    const config = systemdConfigFor({
      project: 'web',
      env: 'prod',
      envVars: { PORT: '8080' },
      targetCtx: CTX,
      now: new Date(0),
      systemd: systemdSpec({
        unit: '${project}-${env}.service',
        description: 'web ${env}',
        execReload: '/bin/kill -HUP $MAINPID',
        workingDirectory: '${release.current}',
        user: 'www-data',
        group: 'www-data',
        environment: { PORT: '${env.PORT}' },
        restart: 'always',
        restartSec: 3,
        after: ['network.target'],
        requires: ['network-online.target'],
        wantedBy: 'graphical.target',
        extra: ['LimitNOFILE=65535'],
      }),
      unitDir: UNIT_DIR,
    })
    assert.equal(config.unit, '${project}-${env}.service')
    assert.equal(config.description, 'web ${env}')
    assert.equal(config.execReload, '/bin/kill -HUP $MAINPID')
    assert.equal(config.workingDirectory, '${release.current}')
    assert.equal(config.user, 'www-data')
    assert.equal(config.group, 'www-data')
    assert.deepEqual(config.environment, { PORT: '${env.PORT}' })
    assert.equal(config.restart, 'always')
    assert.equal(config.restartSec, 3)
    assert.deepEqual(config.after, ['network.target'])
    assert.deepEqual(config.requires, ['network-online.target'])
    assert.equal(config.wantedBy, 'graphical.target')
    assert.deepEqual(config.extra, ['LimitNOFILE=65535'])
    assert.equal(config.render.env, 'prod')
    assert.equal(config.render.envVars?.['PORT'], '8080')
  })

  it('模板串**原样**搬给执行器：渲染由 @dp/template 做，不在 CLI 这层预展开', () => {
    // 预展开会让 `${env.NAME}` 拿不到 envVars，而 dry-run 里的 render.now 也会跟着错
    const config = systemdConfigFor({
      project: 'web',
      env: 'prod',
      envVars: { PORT: '8080' },
      targetCtx: CTX,
      now: new Date(0),
      systemd: systemdSpec({ unit: '${project}-${env}.service', environment: { PORT: '${env.PORT}' } }),
      unitDir: UNIT_DIR,
    })
    assert.equal(config.unit, '${project}-${env}.service')
    assert.deepEqual(config.environment, { PORT: '${env.PORT}' })
  })
})

// ------------------------------------------------------------
// ③ 顺序与副作用
// ------------------------------------------------------------

describe('apply 里 systemd 的顺序', () => {
  it('install 的影子校验在 deploy 之前，restart 在最后', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        const shadowCheck = runner.events.findIndex((e) => e.startsWith('exec systemd-analyze verify'))
        const deploy = runner.deployAt(runner)
        const restart = runner.events.lastIndexOf('exec systemctl restart web.service')
        assert.ok(shadowCheck >= 0, '影子校验没跑')
        assert.ok(deploy >= 0, 'deploy 没跑传输')
        assert.ok(shadowCheck < deploy, '坏 unit 会在碰发布根之后才被发现')
        assert.ok(restart > deploy, 'restart 必须晚于 deploy：unit 指向 current 软链')
        // daemon-reload 必须在 restart 之前 —— 否则 restart 用的是 systemd 缓存里的旧 unit
        const reload = runner.events.findIndex((e) => e === 'exec systemctl daemon-reload')
        assert.ok(reload >= 0 && reload < restart, 'daemon-reload 必须早于 restart')
      },
      { systemd: true },
    )
  })

  it('install 阶段一个字节都不碰 unitDir 里正在生效的 unit', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        // 影子候选写在 <release 目录>/.dp/ 下，不在 unitDir 下 ——
        // systemd 会递归扫描 unit 路径，放那儿等于塞一份同名重复 unit
        const shadow = runner.events.find((e) => e.includes('/.dp/') && e.includes('web.service'))
        assert.ok(shadow !== undefined, '影子候选没写出来')
        assert.ok(!shadow.startsWith(`unit-write ${UNIT_DIR}`), `影子候选落到了 unitDir 下：${shadow}`)

        // install 阶段（transfer 之前）的每一次写都必须在发布根之外
        const deploy = runner.deployAt(runner)
        const earlyWrites = runner.events.slice(0, deploy).filter((e) => e.startsWith('write ') || e.startsWith('unit-write '))
        assert.ok(earlyWrites.length > 0, 'install 一个写都没做，那影子校验验的是什么')
        for (const e of earlyWrites) {
          assert.ok(!e.includes(UNIT_DIR), `install 碰了生效 unit：${e}`)
        }
      },
      { systemd: true },
    )
  })

  it('unit 内容：带 managed 标记、ExecStart 指向 current 软链、落点就是推导出的 unitDir', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.equal(code, 0)
        const unit = runner.peek(UNIT_FILE)
        assert.ok(unit !== null, 'unit 没被写进 unitDir')
        assert.match(unit, /^# managed by dp/)
        assert.match(unit, /ExecStart=\/usr\/bin\/node \/srv\/app\/current\/server\.js/)
        // 钉死在具体版本目录上的 unit 会在下一次部署后指向一个已被 prune 的目录
        assert.doesNotMatch(unit, /ExecStart=.*\/srv\/app\/releases\//)
        assert.match(unit, /Restart=on-failure/)

        const section = resultOf(stdout)['systemd'] as Record<string, unknown>
        assert.equal(section['unitDir'], UNIT_DIR)
        assert.equal(section['file'], UNIT_FILE)
        assert.equal(section['unitName'], 'web.service')
        assert.equal(section['reloaded'], true)
        assert.equal(section['restarted'], true)
        assert.equal(section['dryRun'], false)
        assert.deepEqual(section['ownership'], { action: 'create', reason: '目标 unit 不存在', backup: false })
        // 首次部署没有上一份 unit 可备份，那一步在机器上什么都没留下 → skipped。
        // 把它报成 ran 就等于声称「备份过了」，而盘上根本没有 .dp-backup
        assert.deepEqual(section['skipped'], ['systemd.backup'])
        assert.equal(runner.peek(`${UNIT_FILE}.dp-backup`), null)
      },
      { systemd: true },
    )
  })

  it('已有带标记的 unit 时判 replace 并先备份', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.writeFile(UNIT_FILE, '# managed by dp\n[Service]\nExecStart=/bin/old\n')
        const { code, stdout } = await run('apply', ['--json'])
        assert.equal(code, 0)
        const section = resultOf(stdout)['systemd'] as Record<string, unknown>
        assert.deepEqual(section['ownership'], {
          action: 'replace',
          reason: '带 managed 标记，属于 dp 管理的 unit',
          backup: true,
        })
        // 备份里必须是**替换前**那一份；替换后写的是新内容
        assert.match(runner.peek(`${UNIT_FILE}.dp-backup`) ?? '', /ExecStart=\/bin\/old/)
        assert.doesNotMatch(runner.peek(UNIT_FILE) ?? '', /ExecStart=\/bin\/old/)
      },
      { systemd: true },
    )
  })

  it('pretty 输出把 systemd 段渲染出来（JSON 侧由每条 --json 用例覆盖）', async () => {
    await withWorkspace(
      async ({ run }) => {
        const { code, stdout } = await run('apply', [])
        assert.equal(code, 0)
        assert.match(stdout, /systemd · web\.service/)
        assert.match(stdout, /unitDir:\s+\/etc\/systemd\/system/)
        assert.match(stdout, /daemon-reload: 已发出/)
        assert.match(stdout, /restart:\s+已发出/)
        // skipped 的判据是「机器上有没有留下作用」，标记要跟着出现
        assert.match(stdout, /- \[activate\] systemd\.backup（未在机器上留下作用）/)
      },
      { systemd: true },
    )
  })

  it('scope=user 时所有 systemctl 命令都带 --user（范围错 = 换一个 unit 库去 restart）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        const execs = systemctlExecs(runner)
        assert.ok(execs.length > 0, '没有发任何 systemctl / systemd-analyze 命令')
        for (const argv of execs) {
          assert.equal(argv[1], '--user', `argv 少了 --user：${argv.join(' ')}`)
        }
      },
      { systemd: true, scope: 'user', canWrite: { '/home/deployer/.config/systemd/user': true } },
    )
  })
})

// ------------------------------------------------------------
// ④ 失败路径
// ------------------------------------------------------------

describe('systemd 失败时的收场', () => {
  it('install 失败（影子校验不过）→ 不跑 deploy，unitDir 零残留', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        runner.failWhen = (argv) =>
          argv[0] === 'systemd-analyze' ? { code: 1, stderr: 'web.service: Unknown key name "ExecStar"' } : undefined
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0)
        const result = resultOf(stdout)
        assert.equal((result['error'] as Record<string, unknown>)['code'], 'DP.SYSD.TEST_FAILED')
        assert.equal(result['filesWritten'], 0)
        assert.equal(result['rolledBack'], false, '什么都没写，没东西可回滚')
        assert.ok(!runner.events.some((e) => e.startsWith('transfer ')), 'install 失败后不得部署')
        assert.equal(runner.peek('/srv/app/current'), null)
        assert.deepEqual(runner.unitDirResidue(), [], '生效 unit 一个字节都不该被碰')
        // systemd 的原话必须进 hint，否则用户只能自己上机器复现一遍
        assert.match(String((result['error'] as Record<string, unknown>)['hint']), /ExecStar|已收回|原话/)
      },
      { systemd: true },
    )
  })

  it('activate 失败（restart 起不来）→ 不回滚 release，且说清「新 unit + 无服务」', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        runner.failWhen = (argv) =>
          argv.includes('restart') ? { code: 1, stderr: 'Job for web.service failed: listen EADDRINUSE :8080' } : undefined
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0, '服务没起来不能报成功')

        const result = resultOf(stdout)
        assert.equal(result['rolledBack'], false, 'unit 的问题不该退掉一次成功的发布')
        assert.ok(String(runner.peek('/srv/app/current')).includes('releases/'), 'current 必须仍指向新版本')
        assert.equal((result['error'] as Record<string, unknown>)['code'], 'DP.SYSD.RESTART_FAILED')

        const warnings = (result['warnings'] as string[]).join('\n')
        assert.match(warnings, /新 unit \+ 无服务/, '必须说清机器现在的状态')
        assert.match(warnings, /EADDRINUSE/, 'systemd 的原话要带出来')
        assert.match(warnings, /systemctl restart/, '要给出能直接敲的下一步')
        // unit 仍应是 activate 写上去的那份：执行器没撤销就是没撤销
        assert.match(runner.peek(UNIT_FILE) ?? '', /ExecStart=/)
      },
      { systemd: true },
    )
  })

  it('daemon-reload 失败 → 说清「unit 已落盘但 systemd 还没读到」，与 restart 失败分开', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        runner.failWhen = (argv) =>
          argv.includes('daemon-reload') ? { code: 1, stderr: 'Failed to reload manager: Permission denied' } : undefined
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0)
        assert.equal((resultOf(stdout)['error'] as Record<string, unknown>)['code'], 'DP.SYSD.DAEMON_RELOAD_FAILED')

        const warnings = (resultOf(stdout)['warnings'] as string[]).join('\n')
        assert.match(warnings, /daemon-reload 失败/)
        assert.match(warnings, /生效的仍是上一份 unit/)
        // restart 根本没发出去：说「服务没起来」是撒谎
        assert.ok(!runner.events.some((e) => e.includes('systemctl restart')), 'daemon-reload 失败后不得 restart')
      },
      { systemd: true },
    )
  })

  it('目标 unit 不带 managed 标记 → DP.SYSD.UNIT_NOT_MANAGED，且一个字都不改它', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const before = '# 手写的 unit\n[Service]\nExecStart=/bin/mine\n'
        await runner.writeFile(UNIT_FILE, before)
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0)
        const error = resultOf(stdout)['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.SYSD.UNIT_NOT_MANAGED')
        assert.match(String(error['hint']), /managed by dp|force/, '提示要给出保住自己文件的三条路')
        assert.equal(runner.peek(UNIT_FILE), before, '用户自己的 unit 不得被改写')
        assert.ok(!runner.events.some((e) => e.startsWith('transfer ')), '判定不过就不该部署')
        assert.equal(runner.peek('/srv/app/current'), null)
      },
      { systemd: true },
    )
  })

  it('显式 unitDir 赢过 canWrite 里可写的候选（端到端）—— 否则「显式覆盖」是一句空话', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.equal(code, 0)
        const section = resultOf(stdout)['systemd'] as Record<string, unknown>
        assert.equal(section['unitDir'], '/opt/units')
        assert.equal(section['file'], '/opt/units/web.service')
        assert.ok(runner.peek('/opt/units/web.service') !== null)
        // canWrite 说 /etc/systemd/system 可写，但推导值没被误用
        assert.deepEqual(runner.unitDirResidue(), [])
      },
      // canWrite 里 /etc/systemd/system 明确可写，显式配置必须赢
      { systemd: true, unitDir: '/opt/units', canWrite: { [UNIT_DIR]: true } },
    )
  })

  it('execStart 是空白 → DP.CONFIG.INVALID（schema 期就拒，不进执行器）', async () => {
    await withWorkspace(
      async ({ run }) => {
        // 空白 execStart 在 loadConfig 阶段就炸了 —— 那时还没有「每个目标一份结果」，
        // 所以错误只能落在 stderr 的错误文档上，而不是 apply 的结果里
        const { code, stdout, stderr } = await run('apply', ['--json'])
        assert.notEqual(code, 0)
        assert.equal(stdout, '', '没有结果文档就不该假装有')
        const error = JSON.parse(stderr)['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.CONFIG.INVALID')
        assert.match(String(error['path']), /execStart/)
      },
      { systemd: true, execStart: '   ' },
    )
  })
})

// ------------------------------------------------------------
// ⑤ dry-run
// ------------------------------------------------------------

describe('--dry-run 的 systemd 阶段', () => {
  it('unitDir 零残留、没发 reload / restart、deploy 没跑，但影子校验照跑', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--dry-run', '--json'])
        assert.equal(code, 0)
        const result = resultOf(stdout)
        assert.equal(result['filesWritten'], 0)
        assert.deepEqual(runner.unitDirResidue(), [], 'dryRun 承诺 unitDir 零残留')
        assert.ok(!runner.events.some((e) => e.includes('daemon-reload')), 'dryRun 不得发 daemon-reload')
        assert.ok(!runner.events.some((e) => e.includes('systemctl restart')), 'dryRun 不得 restart')
        assert.ok(!runner.events.some((e) => e.startsWith('transfer ')), 'dryRun 不得部署')
        assert.equal(runner.peek('/srv/app/current'), null)
        // 影子校验是只读的：它给的结论是真的，所以照跑、记 ran
        assert.ok(runner.events.some((e) => e.startsWith('exec systemd-analyze verify')))

        const section = result['systemd'] as Record<string, unknown>
        assert.equal(section['dryRun'], true)
        assert.equal(section['reloaded'], false, 'dryRun 不得声称 reload 过')
        assert.equal(section['restarted'], false, 'dryRun 不得声称 restart 过')
        // skipped 的判据是「机器上有没有留下作用」：写候选那步跑了但已被撤销 → skipped
        const skipped = section['skipped'] as string[]
        assert.ok(skipped.includes('systemd.write-candidate'), '写过又撤销的步骤必须记 skipped')
        assert.ok(!skipped.includes('systemd.validate-shadow'), '影子校验真跑了，结论是真的，不能记 skipped')
      },
      { systemd: true },
    )
  })

  it('is-active 读出「不 active」时记告警而不是把 --dry-run 打成红的', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        runner.isActive = () => ({ code: 3, stdout: 'inactive\n' })
        const { code, stdout } = await run('apply', ['--dry-run', '--json'])
        assert.equal(code, 0, 'dry-run 第一次在没部署过的机器上跑必红的话，就没人再跑它了')
        const result = resultOf(stdout)
        assert.equal(result['error'], undefined)
        const warnings = (result['warnings'] as string[]).join('\n')
        assert.match(warnings, /DP\.SYSD\.NOT_ACTIVE/, '但那条事实必须说出来')
        assert.match(warnings, /--dry-run/)
      },
      { systemd: true },
    )
  })
})

// ------------------------------------------------------------
// ⑥ verify / rollback / status
// ------------------------------------------------------------

describe('dp verify', () => {
  it('is-active 不通过 → 报错退出非 0，且说清是哪一种 not-active', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        runner.isActive = () => ({ code: 3, stdout: 'failed\n' })
        const { code, stdout } = await run('verify', ['--json'])
        assert.notEqual(code, 0, '服务没活着就不能放行')
        const error = resultOf(stdout)['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.SYSD.NOT_ACTIVE')
        // 三种 not-active 的排查路径完全不同，提示必须分开说
        assert.match(String(error['hint']), /not-found/)
        assert.match(String(error['hint']), /journalctl/)
      },
      { systemd: true },
    )
  })

  it('is-active 通过 → 退出 0', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        const { code } = await run('verify', ['--json'])
        assert.equal(code, 0)
      },
      { systemd: true },
    )
  })
})

describe('dp rollback', () => {
  it('还原备份 unit → daemon-reload → restart → 复验，然后把 current 切回上一版', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1', 'r2'], 'r2')
        await runner.writeFile(UNIT_FILE, '# managed by dp\n[Service]\nExecStart=/usr/bin/node /srv/app/current/new.js\n')
        await runner.writeFile(`${UNIT_FILE}.dp-backup`, '# managed by dp\n[Service]\nExecStart=/usr/bin/node /srv/app/current/old.js\n')
        const { code, stdout } = await run('rollback', ['--json'])
        assert.equal(code, 0, stdout)
        // current 指回 r1
        assert.equal(runner.peek('/srv/app/current'), '/srv/app/releases/r1')
        // 盘上的 unit 必须是**备份那份**，不是当前版本的
        assert.match(runner.peek(UNIT_FILE) ?? '', /old\.js/)
        assert.ok(runner.peek(`${UNIT_FILE}.dp-backup`) === null, '备份被 rename 消耗掉了，不该同时还在')

        const execs = systemctlExecs(runner).map((a) => a.join(' '))
        const reload = execs.findIndex((a) => a === 'systemctl daemon-reload')
        const restart = execs.findIndex((a) => a === 'systemctl restart web.service')
        const isActive = execs.findIndex((a) => a === 'systemctl is-active web.service')
        assert.ok(reload >= 0 && restart >= 0 && isActive >= 0, JSON.stringify(execs))
        assert.ok(reload < restart && restart < isActive, 'reload → restart → 复验，顺序不能乱')
      },
      { systemd: true },
    )
  })

  it('**先切 current 再动服务**：unit 里烘的是 ${release.current} 软链，先 restart 会起在新版本上', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1', 'r2'], 'r2')
        await runner.writeFile(UNIT_FILE, '# managed by dp\n[Service]\nExecStart=/usr/bin/node /srv/app/current/new.js\n')
        await runner.writeFile(`${UNIT_FILE}.dp-backup`, '# managed by dp\n[Service]\nExecStart=/usr/bin/node /srv/app/current/old.js\n')
        const { code, stdout } = await run('rollback', ['--json'])
        assert.equal(code, 0, stdout)
        const at = (needle: string): number => runner.events.findIndex((e) => e.includes(needle))
        const switchAt = Math.max(at('/srv/app/current -> '), at('-> /srv/app/current'))
        const restartAt = at('systemctl restart web.service')
        assert.ok(switchAt >= 0, `没看到切 current 的动作：${JSON.stringify(runner.events)}`)
        assert.ok(restartAt >= 0, `没看到 restart：${JSON.stringify(runner.events)}`)
        assert.ok(switchAt < restartAt, `必须先切 current 再 restart：${JSON.stringify(runner.events)}`)
      },
      { systemd: true },
    )
  })

  it('没有备份 unit → DP.SYSD.NO_PREVIOUS，不谎报成功', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1', 'r2'], 'r2')
        const { code, stdout } = await run('rollback', ['--json'])
        assert.notEqual(code, 0, '没有可还原的 unit 却报成功 = 用户以为线上还是上一版')
        const error = resultOf(stdout)['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.SYSD.NO_PREVIOUS')
        assert.match(String(error['hint']), /daemon-reload/, '提示要给出「手动撤掉」的具体做法')
        assert.ok(!runner.events.some((e) => e.includes('systemctl restart')), '没还原成之前不许 restart')
        // 指针先切、服务后动，所以这次 current 已经指到上一版了 —— 那就是留在机器上的改动
        assert.equal(runner.peek('/srv/app/current'), '/srv/app/releases/r1')
        assert.equal(resultOf(stdout)['to'], 'r1')
        assert.equal(resultOf(stdout)['needsHealing'], true, 'current 已经切过去了，必须让人上机器看一眼')
      },
      { systemd: true },
    )
  })

  it('复验不过 → 说清「上一版本身就是坏的」，并把已切过去的 current 报成待收拾', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1', 'r2'], 'r2')
        await runner.writeFile(`${UNIT_FILE}.dp-backup`, '# managed by dp\n[Service]\nExecStart=/bin/broken\n')
        runner.isActive = () => ({ code: 3, stdout: 'failed\n' })
        const { code, stdout } = await run('rollback', ['--json'])
        assert.notEqual(code, 0)
        const result = resultOf(stdout)
        assert.equal((result['error'] as Record<string, unknown>)['code'], 'DP.SYSD.NOT_ACTIVE')
        assert.match(String((result['error'] as Record<string, unknown>)['hint']), /上一版/)
        // 顺序是「先切指针、后动服务」，所以到这里 current 已经是上一版了：
        // 指针动过、服务没起来，两件事都得报出来，不能只报一半
        assert.equal(runner.peek('/srv/app/current'), '/srv/app/releases/r1')
        assert.equal(result['to'], 'r1')
        // unit 已经从备份还原到盘上（只是没 reload / restart 成功），机器确实动过 ——
        // 报 needsHealing: false 会让调用方以为「这次失败没留下要收拾的东西」
        assert.equal(result['needsHealing'], true, '目标侧已经把 unit 换回去，必须有人上机器确认')
        assert.match((result['warnings'] as string[]).join('\n'), /current 已切到/)
      },
      { systemd: true },
    )
  })
})

describe('dp status', () => {
  it('服务不 active 时只进 warnings，status 不因此变红（它的职责是报告事实）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        runner.isActive = () => ({ code: 3, stdout: 'inactive\n' })
        const { code, stdout } = await run('status', ['--json'])
        assert.equal(code, 0, 'status 查到坏消息不该让整条命令变红')
        const result = resultOf(stdout)
        assert.match((result['warnings'] as string[]).join('\n'), /读不到 systemd 服务状态/)
        // 没有可搬的服务状态可报，所以不造新字段
        assert.equal(result['services'], undefined)
        assert.equal(result['composeRead'], undefined)
      },
      { systemd: true },
    )
  })

  it('服务活着时不产生任何 systemd 相关告警', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease('/srv/app', ['r1'], 'r1')
        const { code, stdout } = await run('status', ['--json'])
        assert.equal(code, 0)
        assert.deepEqual(resultOf(stdout)['warnings'], [])
      },
      { systemd: true },
    )
  })
})

// ------------------------------------------------------------
// ⑦ 零回归
// ------------------------------------------------------------

describe('没配 target.systemd 时', () => {
  it('行为与接入前一致：不碰 unitDir、不执行 systemctl、结果里没有 systemd 段', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.equal(code, 0)
        const result = resultOf(stdout)
        assert.equal(result['ok'], true)
        assert.equal(result['systemd'], undefined, '没配 systemd 就不该出现这一段')
        assert.deepEqual(systemctlExecs(runner), [], '不该执行任何 systemctl / systemd-analyze 命令')
        assert.deepEqual(runner.unitDirResidue(), [])
        assert.ok(runner.peek('/srv/app/current') !== null, '部署本身要照常发生')
      },
      { systemd: false },
    )
  })

  it('只写 target.systemd 而不含在 type 链里，仍然跑（段存在即接线）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', ['--json'])
        assert.equal(code, 0)
        assert.ok(runner.execs.some((e) => e.argv.includes('restart')))
      },
      { systemd: true, type: ['static'] },
    )
  })
})
