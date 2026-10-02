/**
 * 执行器 —— 用内存 Runner 跑完整流程。
 *
 * 这个假 Runner 刻意**不**照 nginx 那份写「返回固定值」的桩，它咬三件真机器上会咬人的事：
 *  1. **未注册的 argv 直接抛错** —— 返回 `code: 0` 的话，「跑错了命令」根本测不出来，
 *     而「跑错命令」正是本包最需要防的回归（计划与真跑分叉）；
 *  2. **stat 是真的树** —— 目录就是目录，于是「路径是目录」这件事能被区分于「文件不在」；
 *  3. **它记住每次调用的 argv / cwd / timeoutMs** —— 三样都要逐元素断言，
 *     断言拼出来的字符串会放过「两个元素被拼成一个」这类真问题。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DpError,
  type ExecOptions,
  type ExecResult,
  type Facts,
  type FileStat,
  type Runner,
  type TargetContext,
} from '@dp/ports'
import {
  activateDocker,
  installDocker,
  isDockerExecFailure,
  rollbackDocker,
  verifyDocker,
  type DockerExecFailure,
  type DockerExecInput,
} from './executor.js'
import type { DockerTargetConfig } from './types.js'

// ------------------------------------------------------------
// 内存 Runner
// ------------------------------------------------------------

interface ExecCall {
  readonly argv: readonly string[]
  readonly options?: ExecOptions
}

class MemoryRunner implements Runner {
  readonly id = 'memory'
  readonly facts: Facts
  readonly execs: ExecCall[] = []
  readonly stats: string[] = []
  private readonly tree = new Map<string, 'dir' | 'file'>()
  private readonly responses = new Map<string, ExecResult>()

  constructor(facts: Facts) {
    this.facts = facts
    this.tree.set('/', 'dir')
  }

  /** 测试辅助：放一个文件（父目录自动建） */
  seedFile(path: string): void {
    this.seedDir(path.slice(0, path.lastIndexOf('/')))
    this.tree.set(path, 'file')
  }

  /** 测试辅助：放一个目录。用来断言「路径是目录」与「文件不在」被区别对待 */
  seedDir(path: string): void {
    const parts = path.split('/').filter((p) => p !== '')
    for (let i = 1; i <= parts.length; i++) this.tree.set(`/${parts.slice(0, i).join('/')}`, 'dir')
  }

  /** 按 argv 注册响应。key 是 `argv.join('\u0000')` —— 用不可见分隔符，路径里有空格也不会串味 */
  on(argv: readonly string[], result: ExecResult): void {
    this.responses.set([...argv].join('\u0000'), result)
  }

  argvs(): readonly (readonly string[])[] {
    return this.execs.map((e) => e.argv)
  }

  async exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ argv: [...argv], ...(options !== undefined ? { options: { ...options } } : {}) })
    const key = [...argv].join('\u0000')
    const hit = this.responses.get(key)
    if (hit === undefined) {
      // 没注册的命令 = 执行器跑出了计划之外的东西。返回 code: 0 会让这条测试失去意义
      throw new Error(`内存 Runner 收到未注册的 argv：${JSON.stringify(argv)}`)
    }
    return hit
  }

  async stat(path: string): Promise<FileStat | null> {
    this.stats.push(path)
    const kind = this.tree.get(path)
    if (kind === undefined) return null
    return { isDirectory: kind === 'dir', isSymbolicLink: false, size: 0, mtimeMs: 0 }
  }

  async listDir(): Promise<readonly string[]> {
    return []
  }

  async mkdir(): Promise<void> {}

  async writeFile(): Promise<void> {
    throw new Error('docker 执行器不该写文件：搬运是 @dp/transport 的职责')
  }

  async readFile(): Promise<string> {
    throw new Error('docker 执行器不该读文件内容：只需要 stat 确认存在')
  }

  async readBinary(): Promise<Uint8Array> {
    return new Uint8Array()
  }

  async remove(): Promise<void> {
    throw new Error('docker 执行器不该删任何东西：down 会牵连目标机上同名的其它项目')
  }

  async rename(): Promise<void> {
    throw new Error('docker 执行器不该 rename')
  }

  async symlink(): Promise<void> {
    throw new Error('内存 Runner 不支持软链')
  }

  async readlink(): Promise<string | null> {
    return null
  }

  async realpath(path: string): Promise<string> {
    return path
  }
}

function makeFacts(): Facts {
  return {
    host: 'web-01',
    platform: 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: '/home/u',
    tmpdir: '/tmp',
    env: {},
    capabilities: {
      canWrite: {},
      canChown: [],
      canSymlink: true,
      systemdScope: 'none',
      lingerEnabled: false,
      canBindPrivilegedPort: false,
      sudoAllowlist: [],
    },
    tools: {},
  }
}

// ------------------------------------------------------------
// 夹具
// ------------------------------------------------------------

const RELEASE = '/srv/app/releases/r-1'
const PREV_RELEASE = '/srv/app/releases/r-0'
const COMPOSE = `${RELEASE}/docker-compose.yml`
const COMPOSE_2 = `${RELEASE}/docker-compose.prod.yml`
const ENV_FILE = `${RELEASE}/.env.prod`

const PULL_ARGV = ['docker', 'compose', '-f', COMPOSE, '-p', 'api', 'pull']
const UP_ARGV = ['docker', 'compose', '-f', COMPOSE, '-p', 'api', 'up', '-d', '--wait']
const PS_ARGV = ['docker', 'compose', '-f', COMPOSE, '-p', 'api', 'ps', '--format', 'json']
const PREV_UP_ARGV = ['docker', 'compose', '-f', `${PREV_RELEASE}/docker-compose.yml`, '-p', 'api', 'up', '-d', '--wait']
const PREV_PS_ARGV = ['docker', 'compose', '-f', `${PREV_RELEASE}/docker-compose.yml`, '-p', 'api', 'ps', '--format', 'json']

const CONFIG: DockerTargetConfig = {
  mode: 'remote-cli',
  render: { project: 'api', env: 'prod' },
  compose: { files: ['docker-compose.yml'], projectName: 'api' },
}

function makeCtx(over: Partial<TargetContext> = {}): TargetContext {
  return { host: 'web-01', root: '/srv/app', releaseId: 'r-1', keep: 3, ...over }
}

function makeInput(runner: Runner, over: Partial<DockerExecInput> = {}): DockerExecInput {
  return { runner, ctx: makeCtx(), config: CONFIG, ...over }
}

function config(over: Partial<DockerTargetConfig['compose']> = {}): DockerTargetConfig {
  return { ...CONFIG, compose: { ...CONFIG.compose, ...over } }
}

/** ps 的两种输入形态都要用到：数组形态与 NDJSON 形态（compose 新旧版本各一种） */
function psStdout(rows: readonly Record<string, unknown>[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

const HEALTHY_PS = psStdout([{ Service: 'api', State: 'running', Health: 'healthy', Status: 'Up 2 minutes (healthy)' }])
const UNHEALTHY_PS = psStdout([{ Service: 'api', State: 'running', Health: 'unhealthy', Status: 'Up 2 minutes (unhealthy)' }])

/** 铁律 0 的机器化检查：每条 exec 都必须有 timeout，且永远不喂 stdin */
function assertExecInvariants(runner: MemoryRunner): void {
  for (const call of runner.execs) {
    assert.notEqual(call.options?.timeoutMs, undefined, `exec 缺 timeoutMs：${JSON.stringify(call.argv)}`)
    assert.equal(call.options?.stdin, undefined, `exec 喂了 stdin：${JSON.stringify(call.argv)}`)
  }
}

async function capture(p: Promise<unknown>): Promise<{ readonly error: DpError }> {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof DpError, `期望 DpError，实际：${String(err)}`)
    return { error: err }
  }
  throw new Error('期望抛错，但没有')
}

/** 失败现场。读不出来就当场失败：把读不出来的字段当成空数组，恰好是这类测试最常见的假绿 */
function failureOf(error: DpError): DockerExecFailure {
  const cause: unknown = error.cause
  if (!isDockerExecFailure(cause)) {
    throw new Error(`DpError.cause 里没有 DockerExecFailure：${error.code}`)
  }
  return cause
}

function seeded(): MemoryRunner {
  const runner = new MemoryRunner(makeFacts())
  runner.seedFile(COMPOSE)
  return runner
}

// ------------------------------------------------------------
// install
// ------------------------------------------------------------

describe('installDocker', () => {
  it('文件齐 → ok，且一次 exec 都不发（只读走 stat）', async () => {
    const runner = seeded()

    const result = await installDocker(makeInput(runner))

    assert.equal(result.ok, true)
    assert.deepEqual(result.steps.map((s) => s.id), ['docker.check-compose-files'])
    assert.deepEqual(result.steps.map((s) => s.skipped), [false])
    assert.deepEqual(runner.argvs(), [], 'install 不该发任何命令：文件是传输层搬的')
    assert.deepEqual(runner.stats, [COMPOSE])
    assertExecInvariants(runner)
  })

  it('两个 compose 文件都缺 → 一次报全两个，不许只报第一个', async () => {
    const runner = new MemoryRunner(makeFacts())
    runner.seedDir(RELEASE)

    const { error } = await capture(installDocker(makeInput(runner, { config: config({ files: ['docker-compose.yml', 'docker-compose.prod.yml'] }) })))

    assert.equal(error.code, 'DP.DOCKER.FILE_MISSING')
    // 只报第一个会让用户改一个、重跑、再撞第二个
    assert.match(error.message, /docker-compose\.yml/)
    assert.match(error.message, /docker-compose\.prod\.yml/)
    assert.ok(error.hint !== undefined && error.hint.length > 0, '错误必须带 hint')
    assert.match(error.hint, /source\.root/)
    assert.match(error.hint, /include\/exclude/)
    const failure = failureOf(error)
    assert.equal(failure.step, 'docker.check-compose-files')
    assert.equal(failure.phase, 'install')
    assert.deepEqual(runner.argvs(), [])
  })

  it('路径是目录 → 一样算缺失，且说清是目录', async () => {
    const runner = new MemoryRunner(makeFacts())
    // 目录在，但里面没有那个文件。`-f <目录>` 报的是 no such file or directory，与真缺一字不差
    runner.seedDir(`${RELEASE}/docker-compose.yml`)

    const { error } = await capture(installDocker(makeInput(runner)))

    assert.equal(error.code, 'DP.DOCKER.FILE_MISSING')
    assert.match(error.message, /是个目录/)
    assert.match(error.message, /docker-compose\.yml/)
    assert.deepEqual(runner.argvs(), [])
  })

  it('compose 文件齐但 envFile 缺 → 报 envFile，不误判成 compose 齐了', async () => {
    const runner = seeded()

    const { error } = await capture(installDocker(makeInput(runner, { config: config({ envFile: '.env.prod' }) })))

    assert.equal(error.code, 'DP.DOCKER.FILE_MISSING')
    assert.match(error.message, /\.env\.prod/)
    assert.equal(error.message.includes(COMPOSE), false, 'compose 文件是在的，不该被点名')
    // 步骤本身也要走：compose 文件那步确实过了
    const failure = failureOf(error)
    assert.deepEqual(failure.steps.map((s) => `${s.id}:${s.ok}`), ['docker.check-compose-files:true', 'docker.check-env-file:false'])
  })

  it('compose 文件与 envFile 都在 → 两条步骤都过', async () => {
    const runner = seeded()
    runner.seedFile(ENV_FILE)

    const result = await installDocker(makeInput(runner, { config: config({ envFile: '.env.prod' }) }))

    assert.deepEqual(result.steps.map((s) => s.id), ['docker.check-compose-files', 'docker.check-env-file'])
    assert.deepEqual(runner.argvs(), [])
  })

  it('dryRun 也真的 stat：它给出的「文件在不在」是真的', async () => {
    const runner = seeded()

    const result = await installDocker(makeInput(runner, { dryRun: true }))

    assert.equal(result.dryRun, true)
    // stat 跑了，结论是真的 → 不是 skipped
    assert.deepEqual(result.steps.map((s) => s.skipped), [false])
    assert.deepEqual(runner.stats, [COMPOSE])
    assert.deepEqual(runner.argvs(), [])
  })
})

// ------------------------------------------------------------
// activate
// ------------------------------------------------------------

describe('activateDocker', () => {
  it('pull → up 的顺序、argv 元素级、cwd 是 release 目录、每次都带 timeout', async () => {
    const runner = seeded()
    runner.on(PULL_ARGV, { code: 0, stdout: 'api: Pulled\n', stderr: '' })
    runner.on(UP_ARGV, { code: 0, stdout: 'Container api-1  Started\n', stderr: '' })

    const result = await activateDocker(makeInput(runner))

    assert.equal(result.ok, true)
    assert.deepEqual(result.steps.map((s) => s.id), ['docker.pull', 'docker.up'])
    assert.deepEqual(runner.argvs(), [PULL_ARGV, UP_ARGV])
    for (const call of runner.execs) {
      assert.equal(call.options?.cwd, RELEASE, 'cwd 必须是 release 目录：compose 里的相对路径按它解析')
    }
    assertExecInvariants(runner)
  })

  it('pull: false → 计划里没有 pull 步骤，一条 pull 都不发', async () => {
    const runner = seeded()
    runner.on(UP_ARGV, { code: 0, stdout: '', stderr: '' })

    const result = await activateDocker(makeInput(runner, { config: config({ pull: false }) }))

    assert.deepEqual(result.steps.map((s) => s.id), ['docker.up'])
    assert.deepEqual(runner.argvs(), [UP_ARGV])
  })

  it('wait: false → argv 尾部没有 --wait，且给出「唯一一道关是 verify」的警告', async () => {
    const runner = seeded()
    const upNoWait = ['docker', 'compose', '-f', COMPOSE, '-p', 'api', 'up', '-d']
    runner.on(PULL_ARGV, { code: 0, stdout: '', stderr: '' })
    runner.on(upNoWait, { code: 0, stdout: '', stderr: '' })

    const result = await activateDocker(makeInput(runner, { config: config({ wait: false }) }))

    assert.deepEqual(runner.argvs(), [PULL_ARGV, upNoWait])
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0] ?? '', /wait/)
  })

  it('up 失败 → START_FAILED + 原话摘录 + healing 里有 dp rollback，且不补发任何补偿命令', async () => {
    const runner = seeded()
    runner.on(PULL_ARGV, { code: 0, stdout: '', stderr: '' })
    runner.on(UP_ARGV, { code: 1, stdout: '', stderr: 'service "api" failed to start: port is already allocated' })

    const { error } = await capture(activateDocker(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) })))

    assert.equal(error.code, 'DP.ACTIVATE.START_FAILED')
    // 只报「启动失败」等于让用户自己上机器重跑一遍才知道原因
    const failure = failureOf(error)
    assert.match(failure.output ?? '', /port is already allocated/)
    assert.equal(failure.step, 'docker.up')
    assert.equal(failure.phase, 'activate')
    assert.ok(failure.healing.length > 0, 'healing 不许是空的：等于没告诉人下一步')
    const healing = failure.healing.join('\n')
    assert.match(healing, /dp rollback/)
    assert.match(healing, /r-0/, '要指名回滚到哪一版')

    // 本轮最关键的一条：失败后一条补偿都不许发。
    // 自动 down 会停掉目标机上同名的其它项目；自动 up 上一版会让「失败」与「已回滚」混成一个语义
    const afterFailure = runner.execs.slice(1)
    for (const call of afterFailure) {
      assert.equal(
        call.argv.some((a) => a === 'down' || a === 'rm' || a === 'kill' || a === 'stop'),
        false,
        `失败后补发了补偿命令：${JSON.stringify(call.argv)}`,
      )
    }
    // 更狠一档：整条执行里只允许出现计划里那两条命令
    assert.deepEqual(runner.argvs(), [PULL_ARGV, UP_ARGV])
    assert.deepEqual(
      runner.argvs().some((argv) => argv.includes('r-0')),
      false,
      '执行器自动 up 了上一版',
    )
    assertExecInvariants(runner)
  })

  it('首次部署 up 失败 → healing 给元素级的完整 down argv，不给假的回滚', async () => {
    const runner = seeded()
    runner.on(PULL_ARGV, { code: 0, stdout: '', stderr: '' })
    runner.on(UP_ARGV, { code: 1, stdout: '', stderr: 'boom' })

    const { error } = await capture(activateDocker(makeInput(runner)))

    assert.equal(error.code, 'DP.ACTIVATE.START_FAILED')
    const healing = failureOf(error).healing.join('\n')
    assert.equal(healing.includes('dp rollback'), false, '没有上一版，给回滚是骗人')
    // 元素级：路径里有空格时 join 出来的字符串没法区分「一个元素」与「两个元素」
    assert.match(healing, /"docker","compose","-f",".*docker-compose\.yml","-p","api","down"/)
    assert.deepEqual(runner.argvs(), [PULL_ARGV, UP_ARGV], '仍然不许自动 down')
  })

  it('pull 失败 → PULL_FAILED，说清「旧容器还在跑」，且不把 healing 指到 down', async () => {
    const runner = seeded()
    runner.on(PULL_ARGV, { code: 1, stdout: '', stderr: 'Error response from daemon: pull access denied for api' })

    const { error } = await capture(activateDocker(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) })))

    assert.equal(error.code, 'DP.DOCKER.PULL_FAILED')
    assert.match(error.message, /上一版/)
    assert.match(error.message, /没有起新容器/)
    const failure = failureOf(error)
    assert.match(failure.output ?? '', /pull access denied/)
    assert.equal(failure.step, 'docker.pull')
    // pull 只动镜像缓存，线上什么都没坏 —— 让用户去 down 是有害建议
    assert.equal(failure.healing.join('\n').includes('"down"'), false)
    // up 一步都没走
    assert.deepEqual(runner.argvs(), [PULL_ARGV])
    assertExecInvariants(runner)
  })

  it('dryRun：pull 与 up 都 skipped，一次 exec 都不发', async () => {
    const runner = seeded()
    runner.on(PULL_ARGV, { code: 0, stdout: '', stderr: '' })
    runner.on(UP_ARGV, { code: 0, stdout: '', stderr: '' })

    const result = await activateDocker(makeInput(runner, { dryRun: true }))

    assert.equal(result.dryRun, true)
    assert.deepEqual(result.steps.map((s) => s.skipped), [true, true])
    // 报「已拉取已启动」而机器上什么都没变，比不做更难发现
    assert.deepEqual(runner.argvs(), [], 'dryRun 下不许真的 pull / up')
  })
})

// ------------------------------------------------------------
// verify
// ------------------------------------------------------------

describe('verifyDocker', () => {
  it('健康 → ok，services 带回来，断言步骤也走了一遍', async () => {
    const runner = seeded()
    runner.on(PS_ARGV, { code: 0, stdout: HEALTHY_PS, stderr: '' })

    const result = await verifyDocker(makeInput(runner))

    assert.equal(result.ok, true)
    assert.deepEqual(result.steps.map((s) => s.id), ['docker.ps', 'docker.assert-services'])
    assert.deepEqual(result.services, [{ service: 'api', state: 'running', status: 'Up 2 minutes (healthy)', health: 'healthy' }])
    assert.deepEqual(runner.argvs(), [PS_ARGV])
    assertExecInvariants(runner)
  })

  it('不健康 → VERIFY.FAILED，reason 点名服务并带 state/health/status', async () => {
    const runner = seeded()
    runner.on(PS_ARGV, { code: 0, stdout: UNHEALTHY_PS, stderr: '' })

    const { error } = await capture(verifyDocker(makeInput(runner)))

    assert.equal(error.code, 'DP.VERIFY.FAILED')
    assert.match(error.message, /api/)
    assert.match(error.message, /unhealthy/)
    const failure = failureOf(error)
    assert.equal(failure.step, 'docker.assert-services', '失败挂在断言那一步，不该挂在读 ps 那一步')
    assert.deepEqual(failure.services?.map((s) => s.service), ['api'], '失败现场要带读到的服务状态')
    assert.ok(failure.healing.length > 0)
  })

  it('坏 JSON → PS_PARSE_FAILED 原码原样冒泡，不许被包成别的码', async () => {
    const runner = seeded()
    runner.on(PS_ARGV, { code: 0, stdout: 'Usage:  docker compose [OPTIONS] COMMAND', stderr: '' })

    const { error } = await capture(verifyDocker(makeInput(runner)))

    // 包成 VERIFY.FAILED 就丢了「远端 compose 可能根本不可用」这条线索
    assert.equal(error.code, 'DP.DOCKER.PS_PARSE_FAILED')
    const failure = failureOf(error)
    assert.equal(failure.step, 'docker.ps')
    // 挂上 phase / step 的同时，把读不懂的那份输出原样带出来
    assert.match(failure.output ?? '', /Usage:/)
  })

  it('ps 命令自己失败 → 读不出结论，一律 abort 而不判通过', async () => {
    const runner = seeded()
    runner.on(PS_ARGV, { code: 1, stdout: '', stderr: 'no configuration file provided' })

    const { error } = await capture(verifyDocker(makeInput(runner)))

    assert.equal(error.code, 'DP.DOCKER.PS_PARSE_FAILED')
    assert.match(error.message, /没有任何服务被验证过/)
    assert.deepEqual(runner.argvs(), [PS_ARGV])
  })

  it('expectStates: [running] 时 ps 通过 → 没有断言步骤，且一样 ok', async () => {
    const runner = seeded()
    // 用 health 为空的服务：parseComposePs 对 health='' 直接放行。
    // 顺带把语义钉住 —— expectStates 是 state **与** health 的共同取值集合，
    // 配成 ['running'] 时一个 health=unhealthy 的服务仍然不通过
    runner.on(PS_ARGV, { code: 0, stdout: psStdout([{ Service: 'api', State: 'running', Health: '' }]), stderr: '' })

    const result = await verifyDocker(
      makeInput(runner, { config: { ...CONFIG, healthcheck: { expectStates: ['running'] } } }),
    )

    assert.equal(result.ok, true)
    assert.deepEqual(result.steps.map((s) => s.id), ['docker.ps'], '没有 healthy 就不该有断言步骤')
  })

  it('expectStates: [running] 但 state 是 exited → 不通过也要抛 VERIFY.FAILED', async () => {
    const runner = seeded()
    runner.on(PS_ARGV, { code: 0, stdout: psStdout([{ Service: 'api', State: 'exited', Health: '' }]), stderr: '' })

    const { error } = await capture(verifyDocker(makeInput(runner, { config: { ...CONFIG, healthcheck: { expectStates: ['running'] } } })))

    // 把判定省掉等于把健康检查做成永远绿的灯
    assert.equal(error.code, 'DP.VERIFY.FAILED')
    const failure = failureOf(error)
    assert.equal(failure.step, 'docker.ps', '没有断言步骤时，判定落在 ps 那一步上')
  })

  it('healthcheck.services 指定的服务不健康 → 点名它，不牵连别的服务', async () => {
    const runner = seeded()
    runner.on(
      PS_ARGV,
      { code: 0, stdout: psStdout([{ Service: 'api', State: 'running', Health: 'healthy' }, { Service: 'db', State: 'running', Health: 'unhealthy' }]), stderr: '' },
    )

    const { error } = await capture(verifyDocker(makeInput(runner, { config: { ...CONFIG, healthcheck: { services: ['db'] } } })))

    assert.equal(error.code, 'DP.VERIFY.FAILED')
    assert.match(error.message, /db/)
  })

  it('指定的服务压根不在 ps 输出里 → 报错，不按「没有要判的服务」放行', async () => {
    const runner = seeded()
    runner.on(PS_ARGV, { code: 0, stdout: psStdout([{ Service: 'api', State: 'running', Health: 'healthy' }]), stderr: '' })

    const { error } = await capture(verifyDocker(makeInput(runner, { config: { ...CONFIG, healthcheck: { services: ['api', 'nope'] } } })))

    assert.equal(error.code, 'DP.VERIFY.FAILED')
    assert.match(error.message, /nope/)
  })

  it('dryRun：ps 真跑（只读，结论是真的）且 skipped 为 false', async () => {
    const runner = seeded()
    runner.on(PS_ARGV, { code: 0, stdout: HEALTHY_PS, stderr: '' })

    const result = await verifyDocker(makeInput(runner, { dryRun: true }))

    assert.deepEqual(runner.argvs(), [PS_ARGV], 'ps 是只读的，dryRun 下照跑')
    assert.deepEqual(result.steps.map((s) => s.skipped), [false, false])
    assert.deepEqual(result.services?.map((s) => s.service), ['api'])
  })
})

// ------------------------------------------------------------
// rollback
// ------------------------------------------------------------

describe('rollbackDocker', () => {
  it('用上一版目录的 argv 重新 up，不 pull，复验通过 → ok', async () => {
    const runner = seeded()
    runner.on(PREV_UP_ARGV, { code: 0, stdout: '', stderr: '' })
    runner.on(PREV_PS_ARGV, { code: 0, stdout: HEALTHY_PS, stderr: '' })

    const result = await rollbackDocker(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) }))

    assert.equal(result.ok, true)
    assert.deepEqual(result.steps.map((s) => s.id), ['docker.rollback-up', 'docker.rollback-ps'])
    // 每一 argv 元素都指向上一版，且一条 pull 都没有：浮动 tag 再拉一次就不是回滚了
    assert.deepEqual(runner.argvs(), [PREV_UP_ARGV, PREV_PS_ARGV])
    assert.equal(
      runner.argvs().some((argv) => argv.includes('pull')),
      false,
      '回滚不许 pull',
    )
    assert.deepEqual(result.services?.map((s) => s.service), ['api'])
    assertExecInvariants(runner)
  })

  it('上一版 up 失败 → START_FAILED，并说清「上一版自己就起不来」', async () => {
    const runner = seeded()
    runner.on(PREV_UP_ARGV, { code: 1, stdout: '', stderr: 'manifest unknown' })

    const { error } = await capture(rollbackDocker(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) })))

    assert.equal(error.code, 'DP.ACTIVATE.START_FAILED')
    const failure = failureOf(error)
    assert.equal(failure.step, 'docker.rollback-up')
    assert.match(failure.output ?? '', /manifest unknown/)
    assert.match(error.hint ?? '', /镜像已被清理/)
    assert.deepEqual(runner.argvs(), [PREV_UP_ARGV], '失败后不许再补发命令')
  })

  it('复验不通过 → VERIFY.FAILED 并说清「回滚已执行、上一版也没起来」', async () => {
    const runner = seeded()
    runner.on(PREV_UP_ARGV, { code: 0, stdout: '', stderr: '' })
    runner.on(PREV_PS_ARGV, { code: 0, stdout: UNHEALTHY_PS, stderr: '' })

    const { error } = await capture(rollbackDocker(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) })))

    assert.equal(error.code, 'DP.VERIFY.FAILED')
    assert.match(error.message, /回滚已经执行/)
    assert.match(error.message, /人工介入/)
    const failure = failureOf(error)
    assert.equal(failure.phase, 'rollback')
    assert.deepEqual(failure.services?.map((s) => s.service), ['api'])
    assert.ok(failure.healing.length > 0)
    // up 那一步是真的执行过的（回滚已落定），不能记成 skipped
    assert.deepEqual(failure.steps.map((s) => `${s.id}:${s.ok}`), ['docker.rollback-up:true', 'docker.rollback-ps:false'])
  })

  it('没有上一版 → NO_PREVIOUS 原样冒泡，执行器不许吞成空计划', async () => {
    const runner = seeded()

    const { error } = await capture(rollbackDocker(makeInput(runner)))

    assert.equal(error.code, 'DP.DOCKER.NO_PREVIOUS')
    assert.deepEqual(runner.argvs(), [])
  })

  it('dryRun：up 不跑（会改变机器状态），复验的 ps 照跑', async () => {
    const runner = seeded()
    runner.on(PREV_UP_ARGV, { code: 0, stdout: '', stderr: '' })
    runner.on(PREV_PS_ARGV, { code: 0, stdout: HEALTHY_PS, stderr: '' })

    const result = await rollbackDocker(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }), dryRun: true }))

    assert.deepEqual(runner.argvs(), [PREV_PS_ARGV])
    assert.deepEqual(result.steps.map((s) => s.skipped), [true, false])
  })
})

// ------------------------------------------------------------
// 失败现场的形状
// ------------------------------------------------------------

describe('isDockerExecFailure', () => {
  it('读不出来的对象返回 false，而不是当成「没有失败现场」', () => {
    assert.equal(isDockerExecFailure(undefined), false)
    assert.equal(isDockerExecFailure(null), false)
    assert.equal(isDockerExecFailure('boom'), false)
    // 字段不全就不是本包抛的现场：把读不出来的字段当空数组恰好是这类测试最常见的假绿
    assert.equal(isDockerExecFailure({ step: 'docker.up', phase: 'activate' }), false)
    assert.equal(isDockerExecFailure({ step: 'docker.up', phase: 'activate', steps: [], healing: [] }), true)
  })
})
