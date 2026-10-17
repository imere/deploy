/**
 * `dp apply` / `verify` / `rollback` 接上 process 之后的接线测试。
 *
 * 四类覆盖，缺一不可：
 *  1. **顺序** —— install 必须在 deploy **之后**（脚本写在 deploy 造出来的版本目录里）。
 *     顺序错了不会报编译错，只会「脚本写在一个随后被清掉的目录里」。
 *  2. **停不可撤销** —— activate 是「先停后起」，起失败就是**服务空窗**。
 *     报成「部署失败」会让人以为线上还在跑旧版本，那是本仓最不能接受的一种误导。
 *  3. **回滚语义** —— 回滚跑的是**上一版目录里那份脚本**，不是当前配置重新渲染出来的。
 *  4. **零回归** —— 没配 target.process 时的行为与接入前逐字一致。
 *
 * 全程不碰网络、不起真进程：exec 走注入的 FakeRunner，部署走 fake transfer。
 * FakeRunner 会模拟启动脚本唯一的外部可见副作用 —— 把 pid 写进 pidfile ——
 * 否则 verify 的 `kill -0` 永远读不到 pid，而那正是真实机器上的情形。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DpError, type ExecOptions, type ExecResult, type Facts, type FileStat, type Runner, type TargetContext } from '@dp/ports'
import { defineProject, type ProcessConfig } from '@dp/schema'
import { assertExecInvariants, type ExecCall, linuxFacts } from '@dp/testkit'
import { main } from './index.js'
import { processConfigFor } from './process-config.js'
import type { ApplyDeps } from './deps.js'

// ------------------------------------------------------------
// 夹具
// ------------------------------------------------------------

interface ExecDecision {
  readonly code: number
  readonly stdout?: string
  readonly stderr?: string
}

const RELEASE_ROOT = '/srv/app'
/** pidfile 与日志落在发布根下的固定位置，跨版本只有一份 */
const PID_FILE = `${RELEASE_ROOT}/.dp/process.pid`

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
  /** kill -0 的结论。默认进程活着 */
  alive: () => ExecDecision = () => ({ code: 0 })
  /** 模拟脚本写入的 pidfile 位置。pidFile 配成别的路径时要跟着改 */
  pidFile = PID_FILE

  constructor(facts: Facts) {
    this.facts = facts
    this.tree.set('/', null)
  }

  async exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.events.push(`exec ${argv.join(' ')}`)
    this.execs.push({ argv: [...argv], ...(options !== undefined ? { options } : {}) })
    const forced = this.failWhen(argv)
    if (forced !== undefined) return { code: forced.code, stdout: forced.stdout ?? '', stderr: forced.stderr ?? '' }
    // 存活断言走 `kill -0 <pid>`，argv[0] 是 sh、argv[2] 是那条脚本（多行，所以按包含判断）
    if (argv.some((part) => part.includes('kill -0 "$1"'))) {
      const d = this.alive()
      return { code: d.code, stdout: d.stdout ?? '', stderr: d.stderr ?? '' }
    }
    // 模拟脚本唯一的外部可见副作用。真实机器上启动脚本自己写 pidfile、
    // 停止脚本自己删它；不模拟的话 verify 永远读不到 pid，而那不是真机器的行为
    const script = argv.length === 2 && argv[0] === 'sh' ? argv[1] : undefined
    if (script !== undefined && script.endsWith('/start.sh')) {
      this.tree.set(this.pidFile, '4242')
      return { code: 0, stdout: '', stderr: '' }
    }
    if (script !== undefined && script.endsWith('/stop.sh')) {
      this.tree.delete(this.pidFile)
      return { code: 0, stdout: '', stderr: '' }
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

  /** `sh <...>/<name>.sh` 的 argv。脚本类断言只看它 */
  scriptExecs(name: 'start.sh' | 'stop.sh'): (readonly string[])[] {
    return this.execs
      .filter((e) => e.argv[0] === 'sh' && e.argv.length === 2 && e.argv[1]?.endsWith(`/${name}`))
      .map((e) => e.argv)
  }

  /** 盘上现存的脚本文件。dryRun 的「零残留」断言看它 */
  scriptFiles(): string[] {
    return [...this.tree.keys()].filter((k) => k.endsWith('.sh'))
  }

  deployAt(): number {
    return this.events.findIndex((e) => e.startsWith('transfer '))
  }

  peek(path: string): string | null {
    const v = this.tree.get(path)
    return v === undefined ? null : v
  }

  /** 手工播种一份「已经部署过、进程在跑」的机器 */
  async seedRelease(root: string, releases: readonly string[], current: string): Promise<void> {
    for (const id of releases) {
      await this.mkdir(`${root}/releases/${id}`)
      await this.writeFile(`${root}/releases/${id}/index.html`, 'x')
      // 每一版都带上自己那份启动脚本：回滚要跑的正是它
      await this.mkdir(`${root}/releases/${id}/.dp`)
      await this.writeFile(`${root}/releases/${id}/.dp/start.sh`, `#!/bin/sh\n# ${id}\n`)
      await this.writeFile(`${root}/releases/${id}/.dp/stop.sh`, `#!/bin/sh\n# ${id}\n`)
    }
    await this.mkdir(`${root}/.dp`)
    await this.writeFile(`${root}/.dp/index.json`, JSON.stringify({ current, releases: [...releases], history: [] }, null, 2))
    await this.symlink(`${root}/releases/${current}`, `${root}/current`)
    await this.writeFile(this.pidFile, '4242')
  }
}

function remoteFacts(): Facts {
  return linuxFacts({
    host: 'prod',
    homedir: '/home/deployer',
    capabilities: { canWrite: { '/srv/app': true } },
    tools: { ssh: '/usr/bin/ssh', rsync: '/usr/bin/rsync', tar: '/bin/tar', scp: '/usr/bin/scp' },
  })
}

const CTX: TargetContext = { host: 'prod', root: RELEASE_ROOT, releaseId: 'r9', keep: 5 }

/** 经 schema 归一化的 process 段。用 define* 而不是手搓字面量：夹具与用户写的东西同形 */
function processSpec(overrides: Partial<ProcessConfig> = {}): ProcessConfig {
  const spec = defineProject({
    source: { root: './dist' },
    target: { type: ['process'], process: { command: '/usr/bin/node', args: ['${release.current}/server.js'], ...overrides } },
  }).target?.process
  assert.ok(spec !== undefined, '夹具自身坏了：target.process 缺失')
  return spec
}

interface ProcessOptions {
  readonly process?: boolean
  readonly type?: readonly string[]
  readonly command?: string
  readonly args?: readonly string[]
  readonly workingDirectory?: string
  readonly env?: Record<string, string>
  readonly stopSignal?: string
  readonly stopTimeoutMs?: number
  readonly pidFile?: string
  readonly stdoutLog?: string
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
      return { kind: 'rsync-ssh' as const, filesTransferred: req.entries.length, command: ['rsync', '-a'], exitCode: 0, warnings: [] }
    },
  }
}

interface Workspace {
  readonly runner: FakeRunner
  /** stdout 与 stderr 分开：配置期失败在结果文档产生**之前**就抛了，只落在 stderr 上 */
  readonly run: (command: string, args: readonly string[]) => Promise<{ code: number; stdout: string; stderr: string }>
}

async function withWorkspace(fn: (ws: Workspace) => Promise<void>, options: ProcessOptions = {}): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-process-'))
  try {
    await fs.mkdir(join(dir, 'dist'), { recursive: true })
    await fs.writeFile(join(dir, 'dist', 'index.html'), '<h1>v1</h1>', 'utf8')

    const runner = new FakeRunner(remoteFacts())
    if (options.pidFile !== undefined) runner.pidFile = `${RELEASE_ROOT}/${options.pidFile}`
    const project: Record<string, unknown> = { source: { root: './dist' }, release: { root: RELEASE_ROOT } }
    if (options.process === true) {
      const segment: Record<string, unknown> = { command: options.command ?? '/usr/bin/node' }
      if (options.args !== undefined) segment['args'] = options.args
      if (options.workingDirectory !== undefined) segment['workingDirectory'] = options.workingDirectory
      if (options.env !== undefined) segment['env'] = options.env
      if (options.stopSignal !== undefined) segment['stopSignal'] = options.stopSignal
      if (options.stopTimeoutMs !== undefined) segment['stopTimeoutMs'] = options.stopTimeoutMs
      if (options.pidFile !== undefined) segment['pidFile'] = options.pidFile
      if (options.stdoutLog !== undefined) segment['stdoutLog'] = options.stdoutLog
      project['target'] = { type: options.type ?? ['process'], process: segment }
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

// ------------------------------------------------------------
// ① processConfigFor 的字段映射
// ------------------------------------------------------------

describe('processConfigFor 的字段映射', () => {
  it('必填项 + render 上下文（release.id / release.current 来自 ctx）', () => {
    const config = processConfigFor({
      project: 'web',
      env: '',
      envVars: {},
      targetCtx: CTX,
      now: new Date(0),
      process: processSpec(),
    })
    assert.equal(config.command, '/usr/bin/node')
    assert.deepEqual(config.args, ['${release.current}/server.js'])
    assert.equal(config.render.project, 'web')
    assert.equal(config.render.release?.id, 'r9')
    assert.equal(config.render.release?.current, '/srv/app/current')
  })

  it('schema 没给默认值的字段：键根本不存在，不是 undefined 值', () => {
    const config = processConfigFor({
      project: 'web',
      env: '',
      envVars: {},
      targetCtx: CTX,
      now: new Date(0),
      process: processSpec(),
    })
    for (const key of ['workingDirectory', 'env', 'pidFile', 'stdoutLog']) {
      assert.ok(!(key in config), `${key} 不该出现：schema 没给默认值，执行器自己兜，不该在这里补一个 undefined`)
    }
  })

  it('schema 补了默认值的字段（stopSignal / stopTimeoutMs）原样带过去', () => {
    const config = processConfigFor({
      project: 'web',
      env: '',
      envVars: {},
      targetCtx: CTX,
      now: new Date(0),
      process: processSpec(),
    })
    // CLI 不在这里另定一套默认值：schema 已经定了，两处各写一份必然会漂
    assert.equal(config.stopSignal, 'SIGTERM')
    assert.equal(config.stopTimeoutMs, 10_000)
  })

  it('配了的可选字段逐个搬过去', () => {
    const config = processConfigFor({
      project: 'web',
      env: 'prod',
      envVars: { PORT: '8080' },
      targetCtx: CTX,
      now: new Date(0),
      process: processSpec({
        workingDirectory: '${release.current}',
        env: { NODE_ENV: '${env}' },
        stopSignal: 'SIGINT',
        stopTimeoutMs: 5_000,
        pidFile: '.dp/web.pid',
        stdoutLog: '.dp/web.log',
      }),
    })
    assert.equal(config.workingDirectory, '${release.current}')
    assert.deepEqual(config.env, { NODE_ENV: '${env}' })
    assert.equal(config.stopSignal, 'SIGINT')
    assert.equal(config.stopTimeoutMs, 5_000)
    assert.equal(config.pidFile, '.dp/web.pid')
    assert.equal(config.stdoutLog, '.dp/web.log')
    assert.equal(config.render.env, 'prod')
    assert.equal(config.render.envVars?.['PORT'], '8080')
  })
})

// ------------------------------------------------------------
// ② 顺序与副作用
// ------------------------------------------------------------

describe('apply 里 process 的顺序', () => {
  it('install 在 deploy 之后（脚本写在 deploy 造出来的版本目录里）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        const deploy = runner.deployAt()
        const writeScripts = runner.events.findIndex((e) => e.includes('/.dp/start.sh'))
        assert.ok(deploy >= 0, 'deploy 没跑传输')
        assert.ok(writeScripts >= 0, '脚本没写出来')
        assert.ok(writeScripts > deploy, 'install 排在 deploy 之前 = 脚本写进一个还没建出来的版本目录')
      },
      { process: true },
    )
  })

  it('install 阶段不起任何进程：只写脚本，不发 sh <start.sh>', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.equal(code, 0)
        // 一次部署只应有一次 start —— 来自 activate。两次就意味着 install 也去起了一遍
        assert.equal(runner.scriptExecs('start.sh').length, 1, JSON.stringify(runner.execs))
        assert.equal(runner.scriptExecs('stop.sh').length, 0, '首次部署没有 pidfile，不该有停止动作')

        const section = resultOf(stdout)['process'] as Record<string, unknown>
        assert.equal(section['pidFile'], PID_FILE)
        assert.equal(section['started'], true)
        // 首次部署没有可停的东西 → 那一步在机器上什么都没留下 → skipped
        assert.deepEqual(section['skipped'], ['process.stop-current'])
        assert.equal(section['stopped'], false)
      },
      { process: true },
    )
  })

  it('已有 pidfile 时 activate 是「先停后起」—— 反过来两个实例抢同一个端口', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease(RELEASE_ROOT, ['r1'], 'r1')
        // deploy 之后的 releaseId 与 r1 不同，所以 current 这次会指向新版本
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        const execs = runner.execs.map((e) => e.argv.join(' '))
        const stop = execs.findIndex((a) => a.includes('/stop.sh'))
        const start = execs.findIndex((a) => a.includes('/start.sh'))
        assert.ok(stop >= 0 && start >= 0, JSON.stringify(execs))
        assert.ok(stop < start, '先起新的会让两个实例同时占着同一个端口')
        // 停用的是**当前在跑的那一版**的脚本
        assert.match(String(runner.scriptExecs('stop.sh')[0]?.[1]), /releases\/.+\/\.dp\/stop\.sh$/)
      },
      { process: true },
    )
  })

  it('脚本内容：command / args / 工作目录烘进脚本，pidfile 落在发布根的固定位置', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        const script = runner.scriptExecs('start.sh')[0]
        assert.ok(script !== undefined)
        const text = runner.peek(String(script[1])) ?? ''
        assert.match(text, /^#!\/bin\/sh/)
        assert.match(text, /# managed by dp/)

        // workingDirectory 过渲染：默认的 ${release.current} 落成真实软链位置，
        // 于是不管哪个版本写的脚本，跑起来都在服务**当前**版本
        assert.match(text, /cd '\/srv\/app\/current' \|\| exit 1/)
        // pidfile 跨版本只有一份 —— 激活时要停的「当前那个」才找得到
        assert.match(text, /'\/srv\/app\/\.dp\/process\.pid'/)
        assert.match(text, /exec >>'\/srv\/app\/\.dp\/process\.log' 2>&1/)
        // command / args 也过渲染：dp 里所有字符串配置值都走渲染，只有这里不渲染的话
        // `${release.current}` 会静默变成字面文本 —— 不报错、能写进脚本，
        // 只在目标机 exec 时才以 not found 的形式炸出来，而那时错误指向机器而不是配置
        assert.match(text, /'\/usr\/bin\/node' '\/srv\/app\/current\/server\.js'/)
        assert.doesNotMatch(text, /\$\{release\.current\}/, '渲染后不该还在脚本里留下未展开的模板')

        const stop = runner.peek(`${RELEASE_ROOT}/releases/${currentIdOf(runner)}/.dp/stop.sh`)
        assert.ok(stop !== null, '停止脚本没写出来')
        assert.match(stop, /DP_SIGNAL='SIGTERM'/)
        assert.match(stop, /DP_PIDFILE='\/srv\/app\/\.dp\/process\.pid'/)
      },
      { process: true, args: ['${release.current}/server.js'] },
    )
  })

  it('stopSignal / stopTimeoutMs / pidFile / stdoutLog 进脚本（而不是停在配置里没人读）', async () => {    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', [])
        assert.equal(code, 0)
        const start = runner.peek(String(runner.scriptExecs('start.sh')[0]?.[1])) ?? ''
        const stop = runner.peek(`${RELEASE_ROOT}/releases/${currentIdOf(runner)}/.dp/stop.sh`) ?? ''
        assert.match(start, /'\/srv\/app\/\.dp\/web\.pid'/)
        assert.match(start, /'\/srv\/app\/\.dp\/web\.log'/)
        assert.match(start, /export NODE_ENV='prod'/)
        assert.match(stop, /DP_SIGNAL='SIGINT'/)
        // 优雅期换算成整秒并保底 1：传 0 会让轮询一次都不跑，那时「等它退出」是假的
        assert.match(stop, /DP_GRACE="3"/)
      },
      {
        process: true,
        stopSignal: 'SIGINT',
        stopTimeoutMs: 2_500,
        pidFile: '.dp/web.pid',
        stdoutLog: '.dp/web.log',
        env: { NODE_ENV: 'prod' },
      },
    )
  })
  it('pretty 输出把 process 段渲染出来（JSON 侧由每条 --json 用例覆盖）', async () => {
    await withWorkspace(
      async ({ run }) => {
        const { code, stdout } = await run('apply', [])
        assert.equal(code, 0)
        assert.match(stdout, /process · \/srv\/app\/\.dp\/process\.pid/)
        assert.match(stdout, /启动新进程: 已启动/)
        // 首次部署没有可停的：说成「已停」就是谎报
        assert.match(stdout, /停止旧进程: 没有可停的（首次部署）/)
        assert.match(stdout, /- \[activate\] process\.stop-current（未在机器上留下作用）/)
      },
      { process: true },
    )
  })
})

/** 部署完成后 current 指向的版本 id。从软链读，而不是从时间戳猜 */
function currentIdOf(runner: FakeRunner): string {
  const target = runner.peek(`${RELEASE_ROOT}/current`)
  assert.ok(target !== null, 'current 不存在：部署没成功')
  return target.split('/').pop() ?? ''
}

// ------------------------------------------------------------
// ③ 失败路径
// ------------------------------------------------------------

describe('process 失败时的收场', () => {
  it('启动失败 → 退出码非 0、不回滚 release、且明说「服务现在是空窗的」', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        runner.failWhen = (argv) => (argv[1]?.endsWith('/start.sh') ? { code: 1, stderr: 'Error: listen EADDRINUSE :8080' } : undefined)
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0, '服务没起来不能报成功')

        const result = resultOf(stdout)
        assert.equal(result['rolledBack'], false, '版本本身是好的，不该退掉')
        assert.ok(String(runner.peek(`${RELEASE_ROOT}/current`)).includes('releases/'), 'current 必须仍指向新版本')
        assert.equal((result['error'] as Record<string, unknown>)['code'], 'DP.PROC.START_FAILED')

        const warnings = (result['warnings'] as string[]).join('\n')
        assert.match(warnings, /空窗/, '必须说清不是「还在跑旧的」')
        assert.match(warnings, /EADDRINUSE/, '子进程的原话要带出来')
        assert.match(warnings, new RegExp(PID_FILE.replace(/\//g, '\\/')), '要说清 pidfile 在哪，人才能自己看')
      },
      { process: true },
    )
  })

  it('停不掉旧进程 → 新版本**没有启动**（不是空窗，是旧进程还在跑）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease(RELEASE_ROOT, ['r1'], 'r1')
        runner.failWhen = (argv) => (argv[1]?.endsWith('/stop.sh') ? { code: 1, stderr: 'dp: 进程 4242 在优雅期与强杀之后仍然存活' } : undefined)
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0)
        assert.equal((resultOf(stdout)['error'] as Record<string, unknown>)['code'], 'DP.PROC.STOP_FAILED')

        // 起了新版本就等于让两个实例抢同一个端口 —— 那比停不掉的进程更难收拾
        assert.deepEqual(runner.scriptExecs('start.sh'), [], '停不掉就不许起')
        const warnings = (resultOf(stdout)['warnings'] as string[]).join('\n')
        assert.match(warnings, /新版本没有启动|没有启动新版本/)
        assert.doesNotMatch(warnings, /空窗/, '旧进程还在跑，不是空窗')
      },
      { process: true },
    )
  })

  it('pidFile 写成绝对路径 → DP.PROC.COMMAND_INVALID（发布根之外就是任意文件写入）', async () => {
    await withWorkspace(
      async ({ run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0)
        const error = resultOf(stdout)['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.PROC.COMMAND_INVALID')
        assert.match(String(error['path']), /pidFile/)
        assert.match(String(error['hint']), /发布根/)
      },
      { process: true, pidFile: '/tmp/evil.pid' },
    )
  })

  it('command 含控制字符 → DP.PROC.COMMAND_INVALID，脚本一个都没落下', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.notEqual(code, 0)
        assert.equal((resultOf(stdout)['error'] as Record<string, unknown>)['code'], 'DP.PROC.COMMAND_INVALID')
        // install 抛在写脚本之前：一次写都没发生
        assert.deepEqual(runner.scriptFiles(), [])
      },
      { process: true, args: ['server.js\necho pwned'] },
    )
  })
})

// ------------------------------------------------------------
// ④ dry-run
// ------------------------------------------------------------

describe('--dry-run 的 process 阶段', () => {
  it('不部署、不停、不起；脚本写完即撤，pidfile 与 current 都不出现', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--dry-run', '--json'])
        assert.equal(code, 0)
        const result = resultOf(stdout)
        assert.equal(result['filesWritten'], 0)
        assert.equal(runner.peek(`${RELEASE_ROOT}/current`), null, 'dryRun 不得部署')

        // 停进程不可撤销，dryRun 连「试一下」都不做
        assert.deepEqual(runner.scriptExecs('stop.sh'), [], 'dryRun 不得停任何进程')
        assert.deepEqual(runner.scriptExecs('start.sh'), [], 'dryRun 不得起任何进程')
        assert.equal(runner.peek(PID_FILE), null)

        const section = result['process'] as Record<string, unknown>
        assert.equal(section['dryRun'], true)
        assert.equal(section['started'], false, 'dryRun 不得声称起过了')
        assert.equal(section['stopped'], false)
        const skipped = section['skipped'] as string[]
        assert.ok(skipped.includes('process.write-scripts'), '写过又撤销的步骤必须记 skipped')
        assert.ok(skipped.includes('process.stop-current'), '没执行的停止必须记 skipped')
        assert.ok(skipped.includes('process.start-new'), '没执行的启动必须记 skipped')
        // 断言只到「脚本不在」为止：install 的 mkdir 是递归的，dryRun 只撤销脚本目录本身，
        // 于是空的 releases/<id>/ 会留下 —— 那是 @dp/target-process 的残留，不是 dp 的承诺。
        // 把这条写成「一个目录都不许留」等于替另一个包背书，而背错了比不背更糟
        assert.deepEqual(runner.scriptFiles(), [], 'dryRun 不该留下任何脚本')
      },
      { process: true },
    )
  })

  it('pidfile 读不到时记告警而不是把 --dry-run 打成红的', async () => {
    await withWorkspace(
      async ({ run }) => {
        const { code, stdout } = await run('apply', ['--dry-run', '--json'])
        assert.equal(code, 0, 'dry-run 在没部署过的机器上必红的话，就没人再跑它了')
        const result = resultOf(stdout)
        assert.equal(result['error'], undefined)
        assert.match((result['warnings'] as string[]).join('\n'), /DP\.PROC\.NOT_RUNNING/)
      },
      { process: true },
    )
  })
})

// ------------------------------------------------------------
// ⑤ verify / rollback / status
// ------------------------------------------------------------

describe('dp verify', () => {
  it('进程不在了 → DP.PROC.NOT_RUNNING，且说清「它启动后自己退出了，不是被 dp 杀的」', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease(RELEASE_ROOT, ['r1'], 'r1')
        runner.alive = () => ({ code: 1 })
        const { code, stdout } = await run('verify', ['--json'])
        assert.notEqual(code, 0, '进程没活着就不能放行')
        const error = resultOf(stdout)['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.PROC.NOT_RUNNING')
        assert.match(String(error['hint']), /端口|工作目录|权限|stdoutLog/)
        // 读的是 pidfile 里的 pid，不是 ps 的命令行 —— 同名进程会被误判成我们的
        assert.ok(runner.execs.some((e) => e.argv.some((part) => part.includes('kill -0 "$1"'))))
      },
      { process: true },
    )
  })

  it('pidfile 干脆没有 → 同一个错误码，但指向的是「启动时就退了」', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease(RELEASE_ROOT, ['r1'], 'r1')
        await runner.remove(runner.pidFile)
        const { code, stdout } = await run('verify', ['--json'])
        assert.notEqual(code, 0)
        const error = resultOf(stdout)['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.PROC.NOT_RUNNING')
        assert.match(String(error['message']), /pidfile/)
      },
      { process: true },
    )
  })

  it('进程活着 → 退出 0', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease(RELEASE_ROOT, ['r1'], 'r1')
        const { code } = await run('verify', ['--json'])
        assert.equal(code, 0)
      },
      { process: true },
    )
  })
})

describe('dp rollback', () => {
  it('跑的是**上一版目录里那份脚本**，不是当前配置重新渲染出来的', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease(RELEASE_ROOT, ['r1', 'r2'], 'r2')
        const { code, stdout } = await run('rollback', ['--json'])
        assert.equal(code, 0, stdout)
        // current 指回 r1
        assert.equal(runner.peek(`${RELEASE_ROOT}/current`), `${RELEASE_ROOT}/releases/r1`)
        // 停用的是当前版本（r2）那份，起的是上一版（r1）那份 —— 起错版本就不是回滚
        const starts = runner.scriptExecs('start.sh')
        assert.equal(starts.length, 1, JSON.stringify(runner.execs))
        assert.equal(starts[0]?.[1], `${RELEASE_ROOT}/releases/r1/.dp/start.sh`)
        const stops = runner.scriptExecs('stop.sh')
        assert.equal(stops.length, 1)
        assert.equal(stops[0]?.[1], `${RELEASE_ROOT}/releases/r2/.dp/stop.sh`)
      },
      { process: true },
    )
  })

  it('**先切 current 再起服务**：脚本里烘的是 ${release.current} 软链，先起会起到新版本上', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease(RELEASE_ROOT, ['r1', 'r2'], 'r2')
        const { code, stdout } = await run('rollback', ['--json'])
        assert.equal(code, 0, stdout)
        const at = (needle: string): number => runner.events.findIndex((e) => e.includes(needle))
        const switchAt = Math.max(at(`${RELEASE_ROOT}/current -> `), at(`-> ${RELEASE_ROOT}/current`))
        const startAt = at(`exec sh ${RELEASE_ROOT}/releases/r1/.dp/start.sh`)
        assert.ok(switchAt >= 0, `没看到切 current 的动作：${JSON.stringify(runner.events)}`)
        assert.ok(startAt >= 0, `没看到起上一版脚本：${JSON.stringify(runner.events)}`)
        assert.ok(
          switchAt < startAt,
          `必须先把 current 指到上一版再起服务，实际顺序：${JSON.stringify(runner.events)}`,
        )
      },
      { process: true },
    )
  })

  it('上一版脚本被 prune 掉 → DP.PROC.NO_PREVIOUS，不谎报成功', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease(RELEASE_ROOT, ['r1', 'r2'], 'r2')
        await runner.remove(`${RELEASE_ROOT}/releases/r1/.dp/start.sh`)
        const { code, stdout } = await run('rollback', ['--json'])
        assert.notEqual(code, 0, '没有可退的目标却报成功 = 用户以为线上还是上一版')
        const error = resultOf(stdout)['error'] as Record<string, unknown>
        assert.equal(error['code'], 'DP.PROC.NO_PREVIOUS')
        assert.equal(runner.scriptExecs('start.sh').length, 0, '起一个不存在的脚本等于凭空报告一个服务')
        // 指针先切、服务后起，所以这次 current 已经指到上一版了 —— 那是留在机器上的
        // 改动，必须报出来；写成「一个指针都没动」是在替调用方隐瞒
        assert.equal(runner.peek(`${RELEASE_ROOT}/current`), `${RELEASE_ROOT}/releases/r1`)
        assert.equal(resultOf(stdout)['to'], 'r1')
        assert.equal(resultOf(stdout)['needsHealing'], true, 'current 已经切过去了，必须让人上机器看一眼')
        assert.match((resultOf(stdout)['warnings'] as string[]).join('\n'), /current 已切到/)
      },
      { process: true },
    )
  })
})

describe('dp status', () => {
  it('进程不在时只进 warnings，status 不因此变红（它的职责是报告事实）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        await runner.seedRelease(RELEASE_ROOT, ['r1'], 'r1')
        runner.alive = () => ({ code: 1 })
        const { code, stdout } = await run('status', ['--json'])
        assert.equal(code, 0, 'status 查到坏消息不该让整条命令变红')
        assert.match((resultOf(stdout)['warnings'] as string[]).join('\n'), /读不到 process 存活状态/)
        // 没有可搬的服务状态可报，所以不造新字段
        assert.equal(resultOf(stdout)['services'], undefined)
      },
      { process: true },
    )
  })
})

// ------------------------------------------------------------
// ⑥ 零回归
// ------------------------------------------------------------

describe('没配 target.process 时', () => {
  it('行为与接入前一致：不执行任何脚本、结果里没有 process 段', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code, stdout } = await run('apply', ['--json'])
        assert.equal(code, 0)
        const result = resultOf(stdout)
        assert.equal(result['ok'], true)
        assert.equal(result['process'], undefined, '没配 process 就不该出现这一段')
        assert.deepEqual(runner.scriptExecs('start.sh'), [], '不该执行任何脚本')
        assert.ok(runner.peek(`${RELEASE_ROOT}/current`) !== null, '部署本身要照常发生')
      },
      { process: false },
    )
  })

  it('只写 target.process 而不含在 type 链里，仍然跑（段存在即接线）', async () => {
    await withWorkspace(
      async ({ runner, run }) => {
        const { code } = await run('apply', ['--json'])
        assert.equal(code, 0)
        assert.equal(runner.scriptExecs('start.sh').length, 1)
      },
      { process: true, type: ['static'] },
    )
  })
})
