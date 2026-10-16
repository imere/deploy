import {
  DpError,
  type DpErrorCode,
  type ExecResult,
  type Runner,
  type Step,
  type TargetContext,
} from '@dp/ports'
import {
  processTarget,
  aliveArgv,
  processPaths,
  type ProcessPaths,
} from './target.js'
import { SCRIPT_MODE, renderStartScript, renderStopScript } from './script.js'
import type { ProcessTargetConfig } from './types.js'

/** 默认命令超时。启动脚本会立即返回，停止脚本最多等一个优雅期 */
const DEFAULT_TIMEOUT_MS = 30_000

/** 停止脚本的优雅期之外，再给多少毫秒余量让它收尾（脚本里的 sleep 也要算进去） */
const STOP_SLACK_MS = 5_000

/** 错误信息里保留多少子进程输出。整段塞进去会刷屏，并把真正有用的首行挤走 */
const OUTPUT_LIMIT = 2000

/** 脚本目录的权限位。它只放脚本，不给组写 */
const SCRIPT_DIR_MODE = 0o755

/**
 * 执行器的一个阶段。与 `@dp/ports` 的 `StepKind` **不是一套东西**：StepKind 描述
 * 「做了哪类动作」，阶段描述「调用的是哪个入口函数」。
 */
export type ProcessPhase = 'install' | 'activate' | 'verify' | 'rollback'

/**
 * 四个入口共用的入参。
 */
export interface ProcessExecInput {
  readonly runner: Runner
  readonly ctx: TargetContext
  readonly config: ProcessTargetConfig
  readonly onStep?: (step: Step) => void
  /**
   * 命令超时。**每个子进程都必须给**：停止脚本里的轮询会一直转到优雅期结束，
   * 没有兜底就是一次永不返回的部署。
   */
  readonly timeoutMs?: number
  readonly dryRun?: boolean
}

/**
 * 一步执行的留痕，供上层复盘。**只记录发生过什么**，不含重试语义。
 *
 * `skipped` 与 `ok` 是两回事：`ok=false` 且 `skipped=false` 才是真出了事，
 * `skipped=true` 说明这一步在机器上没留下作用（没轮到、无事可做、或被回滚清掉了）。
 */
export interface ProcessStepTrace {
  readonly id: string
  readonly kind: Step['kind']
  readonly ok: boolean
  /** 该步骤**在机器上没有留下作用**：没执行、无事可做，或产物已随补偿撤销 */
  readonly skipped: boolean
}

/**
 * 一个阶段跑成功后的对账凭据。**失败不返回这条路** —— 失败一律抛
 * `DpError`，机器当时的状态挂在 `cause` 里（见 `ProcessExecFailure`）。
 *
 * `ok` 写成字面量 `true` 是为了让上层收窄后再读 `steps`，不必再判一次。
 */
export interface ProcessExecResult {
  readonly ok: true
  readonly phase: ProcessPhase
  readonly host: string
  readonly releaseId: string
  readonly pidFile: string
  readonly dryRun: boolean
  /** 停止旧进程这一步是真跑过还是跳过的（首次部署没有 pidfile / dryRun） */
  readonly stopped: boolean
  readonly started: boolean
  readonly warnings: readonly string[]
  readonly steps: readonly ProcessStepTrace[]
}

/** 挂在 `DpError.cause` 上：失败时机器到底处在什么状态 */
export interface ProcessExecFailure {
  readonly phase: ProcessPhase
  readonly step: string
  readonly host: string
  readonly pidFile: string
  readonly steps: readonly ProcessStepTrace[]
  readonly compensated: readonly string[]
  readonly compensationErrors: readonly string[]
  readonly output?: string
}

interface UndoEntry {
  readonly label: string
  readonly run: () => Promise<void>
}

/**
 * 撤销过程的账。**撤销失败不往上抛** —— 已经救不回来了，把中断遮掉
 * 会让「健康检查没过」被误读成唯一的原因，真正卡住的是那个没撤掉的东西。
 */
export interface UnwindReport {
  readonly done: readonly string[]
  readonly errors: readonly string[]
}

function excerpt(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  return trimmed.length <= OUTPUT_LIMIT ? trimmed : `${trimmed.slice(0, OUTPUT_LIMIT)}…（已截断，原文 ${trimmed.length} 字节）`
}

/** 子进程原话必须进错误信息。只报「失败了」等于让用户自己上机器重跑一遍 */
function outputOf(result: ExecResult): string {
  const err = excerpt(result.stderr)
  if (err !== '') return `stderr：\n${err}`
  const out = excerpt(result.stdout)
  if (out !== '') return `stdout（stderr 为空）：\n${out}`
  return '子进程没有留下任何输出'
}

function describeError(err: unknown): string {
  if (err instanceof DpError) return `${err.code}: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

class Session {
  readonly paths: ProcessPaths
  readonly steps: ProcessStepTrace[] = []
  readonly warnings: string[] = []
  private readonly undo: UndoEntry[] = []
  private didStop = false
  private didStart = false

  constructor(
    readonly input: ProcessExecInput,
    private readonly phase: ProcessPhase,
  ) {
    this.paths = processPaths(input.ctx, input.config)
  }

  get runner(): Runner {
    return this.input.runner
  }

  get ctx(): TargetContext {
    return this.input.ctx
  }

  get config(): ProcessTargetConfig {
    return this.input.config
  }

  get dryRun(): boolean {
    return this.input.dryRun === true
  }

  get timeoutMs(): number {
    return this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 唯一的 exec 出口：timeoutMs 必填，stdin 永不带（铁律 0） */
  async exec(argv: readonly string[], timeoutMs?: number): Promise<ExecResult> {
    return this.runner.exec(argv, { timeoutMs: timeoutMs ?? this.timeoutMs })
  }

  begin(step: Step): void {
    this.input.onStep?.(step)
  }

  pass(step: Step): void {
    this.steps.push({ id: step.id, kind: step.kind, ok: true, skipped: false })
  }

  skip(step: Step): void {
    this.steps.push({ id: step.id, kind: step.kind, ok: true, skipped: true })
  }

  stopped(): void {
    this.didStop = true
  }

  started(): void {
    this.didStart = true
  }

  pushUndo(label: string, run: () => Promise<void>): void {
    this.undo.push({ label, run })
  }

  /** 副作用就此落定：之后的失败不再回滚已完成的步骤 */
  commit(): void {
    this.undo.length = 0
  }

  /** 逆序执行补偿。**永不抛错**：补偿失败要作为附加信息上报，不能顶掉原始错误 */
  async unwind(): Promise<UnwindReport> {
    const done: string[] = []
    const errors: string[] = []
    while (this.undo.length > 0) {
      const entry = this.undo.pop()!
      try {
        await entry.run()
        done.push(entry.label)
      } catch (err) {
        errors.push(`${entry.label} → ${describeError(err)}`)
      }
    }
    return { done, errors }
  }

  async fail(
    step: Step,
    code: DpErrorCode,
    message: string,
    options: {
      readonly hint?: string | ((report: UnwindReport) => string)
      readonly output?: string
      readonly path?: string
    },
  ): Promise<never> {
    this.steps.push({ id: step.id, kind: step.kind, ok: false, skipped: false })
    const report = await this.unwind()
    const hint = typeof options.hint === 'function' ? options.hint(report) : options.hint
    const failure: ProcessExecFailure = {
      phase: this.phase,
      step: step.id,
      host: this.ctx.host,
      pidFile: this.paths.pidFile,
      steps: [...this.steps],
      compensated: report.done,
      compensationErrors: report.errors,
      ...(options.output !== undefined ? { output: options.output } : {}),
    }
    throw new DpError(code, message, {
      path: options.path ?? 'projects.*.target.process',
      ...(hint !== undefined ? { hint } : {}),
      cause: failure,
    })
  }

  result(phase: ProcessPhase, plan: readonly Step[]): ProcessExecResult {
    // 计划里有的步骤必须都被走一遍（dryRun 下也产出 skipped 的那条）
    const planned = plan.map((step) => step.id)
    const ran = new Set(this.steps.map((step) => step.id))
    const missing = planned.filter((id) => !ran.has(id))
    if (missing.length > 0) {
      throw new DpError('DP.PROC.COMMAND_INVALID', `执行器漏掉了计划里的步骤：${missing.join(', ')}`, {
        hint: '执行器与 target.ts 的步骤 id 不一致。这是代码错误，不是部署失败',
      })
    }
    return {
      ok: true,
      phase,
      host: this.ctx.host,
      releaseId: this.ctx.releaseId,
      pidFile: this.paths.pidFile,
      dryRun: this.dryRun,
      stopped: this.didStop,
      started: this.didStart,
      warnings: [...this.warnings],
      steps: [...this.steps],
    }
  }
}

const RENDER_STEP = 'process.render'
const SCRIPTS_STEP = 'process.write-scripts'
const STOP_STEP = 'process.stop-current'
const START_STEP = 'process.start-new'
const START_PREVIOUS_STEP = 'process.start-previous'
const ALIVE_STEP = 'process.alive'

/** 从计划里取步骤；缺了就是代码错误而不是部署失败 */
function stepAt(plan: readonly Step[], id: string): Step {
  const found = plan.find((step) => step.id === id)
  if (found !== undefined) return found
  throw new DpError('DP.PROC.COMMAND_INVALID', `计划里没有步骤 ${id}`, {
    hint: '改 target.ts 的步骤时必须同步改执行器：少走一步在这里的表现是「部署看起来成功了」',
  })
}

/**
 * 从计划里取 argv。执行器只按计划里发布的 argv 造命令 ——
 * 在这里另写一份，症状是「计划与真跑的命令悄悄分叉」。
 *
 * @param step 计划里的一步
 * @returns 该步的 argv
 * @throws DpError `DP.PROC.COMMAND_INVALID` —— 这一步没有 argv（执行器与 target.ts 不同步）
 */
function argvOf(step: Step): readonly string[] {
  const argv = step.detail?.['argv']
  if (Array.isArray(argv) && argv.length > 0 && argv.every((item) => typeof item === 'string')) {
    return argv as readonly string[]
  }
  throw new DpError('DP.PROC.COMMAND_INVALID', `${step.id} 的 detail.argv 缺失或不是非空字符串数组`, {
    hint: '执行器只按计划里发布的 argv 造命令。要改命令就改 target.ts 的 plan，不要在执行器里另写一份',
  })
}

/** 建目录并把**最外层那级原本不存在的目录**登记成撤销目标 */
async function mkdirTracked(session: Session, dir: string, root: string): Promise<void> {
  const chain: string[] = []
  let cur = ''
  for (const part of dir.split('/').filter((p) => p !== '')) {
    cur = `${cur}/${part}`
    chain.push(cur)
  }
  const missing: string[] = []
  for (const p of chain) {
    if ((await session.runner.stat(p)) === null) missing.push(p)
  }
  await session.runner.mkdir(dir, { recursive: true, mode: SCRIPT_DIR_MODE })
  const under = missing.filter((p) => p.startsWith(`${root}/`))
  const top = under[0] ?? dir
  session.pushUndo(`删除 ${top}`, () => session.runner.remove(top))
  // recursive mkdir 会把缺失的每一级都建出来，而 root 之上那几级（releases/ 与版本目录）
  // 不在上面的登记范围内 —— 它们是**共享**目录，真正出错要补偿时不该由本次部署删掉。
  // dryRun 是另一回事：它承诺的是「磁盘上什么都没留下」，留下两个空目录就等于把这句
  // 话降格成「没留下有用的东西」。所以 dryRun 额外把这次新建的那几级也登记上，
  // 且只登记这次查明不存在的（`missing`），不碰原本就在的那几级
  if (session.dryRun) {
    for (const p of missing.filter((p) => !p.startsWith(`${root}/`)).reverse()) {
      session.pushUndo(`dryRun 清理 ${p}`, () => session.runner.remove(p))
    }
  }
}

/** pidfile 里的 pid；读不到就返回 null（文件不存在或内容不是数字） */
async function readPidOf(session: Session): Promise<string | null> {
  const file = session.paths.pidFile
  if ((await session.runner.stat(file)) === null) return null
  const raw = (await session.runner.readFile(file)).trim()
  if (!/^[0-9]+$/.test(raw)) return null
  return raw
}

/** 脚本文件在不在。回滚要跑上一版那份，不在就得说「没有上一版」而不是起一个空的 */
async function scriptExists(session: Session, argv: readonly string[]): Promise<boolean> {
  const script = argv[1]
  if (script === undefined) return false
  return (await session.runner.stat(script)) !== null
}

/**
 * ① install：渲染启动/停止脚本并落到版本目录下。**不启动任何进程**。
 *
 * 脚本跟着版本目录走（`<release 目录>/.dp/`），pid 与日志则落在发布根下的固定位置 ——
 * 前者随 prune 一起消失，后者跨版本只有一份，激活时要停的「当前那个」才找得到。
 *
 * @param input 见 ProcessExecInput
 * @returns 阶段结论
 * @throws DpError `DP.PROC.COMMAND_INVALID` —— 命令、参数、环境变量或路径不合法
 */
export async function installProcess(input: ProcessExecInput): Promise<ProcessExecResult> {
  const session = new Session(input, 'install')
  const plan = processTarget.planInstall(session.ctx, session.config)

  const renderStep = stepAt(plan, RENDER_STEP)
  session.begin(renderStep)
  const start = renderStartScript({
    command: session.paths.command,
    args: session.paths.args,
    workingDirectory: session.paths.workingDirectory,
    pidFile: session.paths.pidFile,
    stdoutLog: session.paths.stdoutLog,
    env: session.config.env ?? {},
  })
  const stop = renderStopScript({
    pidFile: session.paths.pidFile,
    stopSignal: session.paths.stopSignal,
    stopTimeoutMs: session.paths.stopTimeoutMs,
  })
  session.pass(renderStep)

  const writeStep = stepAt(plan, SCRIPTS_STEP)
  session.begin(writeStep)
  await mkdirTracked(session, session.paths.scriptDir, session.paths.releaseDir)
  await session.runner.writeFile(session.paths.startScript, start, { mode: SCRIPT_MODE })
  await session.runner.writeFile(session.paths.stopScript, stop, { mode: SCRIPT_MODE })
  if (session.dryRun) session.skip(writeStep)
  else session.pass(writeStep)

  if (session.dryRun) {
    // dryRun 承诺「磁盘上什么都没留下」：脚本目录撤掉
    const report = await session.unwind()
    for (const err of report.errors) session.warnings.push(`脚本目录清理失败（dryRun 应无残留）：${err}`)
  } else {
    session.commit()
  }

  return session.result('install', plan)
}

/**
 * 停掉当前跑着的进程。**dryRun 下绝不真停** ——
 * 「看一眼计划」和「把服务停了」是两件事，停进程不可撤销。
 *
 * @param session 本次执行上下文
 * @param step 计划里的停止步骤
 * @returns 是否真停过
 */
async function stopCurrent(session: Session, step: Step): Promise<boolean> {
  session.begin(step)
  const hadPid = (await session.runner.stat(session.paths.pidFile)) !== null
  if (!hadPid || session.dryRun) {
    // 首次部署没有可停的东西；dryRun 下则连「试一下」都不做
    session.skip(step)
    return false
  }
  const stopped = await session.exec(argvOf(step), session.timeoutMs + STOP_SLACK_MS)
  if (stopped.code !== 0) {
    return session.fail(step, 'DP.PROC.STOP_FAILED', `停止旧进程失败（退出码 ${stopped.code}）`, {
      output: outputOf(stopped),
      hint:
        '**没有启动新版本** —— 旧进程还占着端口，再起一个只会让它俩打架。' +
        '原话见上，通常是 pid 已被回收但 pidfile 还在（进程自己退了）、或权限不足。' +
        '确认现场后手动清掉 pidfile 再重新部署',
    })
  }
  session.pass(step)
  session.stopped()
  return true
}

/**
 * ② activate：先停掉当前跑着的进程，再按新版本目录里的脚本起新的。
 *
 * 顺序不能反：先起新的会让两个实例同时占着同一个端口，后一个必然起不来，
 * 于是「部署失败」的现场里还躺着一个已经在新版本里的半成品进程。
 *
 * @param input 见 ProcessExecInput
 * @returns 阶段结论；`stopped` 为 false 只在首次部署（没有 pidfile）或 dryRun 时出现
 * @throws DpError `DP.PROC.STOP_FAILED` —— 旧进程停不下来。**不继续起新版本**：
 * 起了就会与新版本抢同一个端口，把「一个停不掉的进程」升级成「两个打架的进程」
 * @throws DpError `DP.PROC.START_FAILED` —— 新进程没起来。此时旧进程已停，服务是空窗的，
 * 必须显式报出来而不是让人以为还在跑旧的
 */
export async function activateProcess(input: ProcessExecInput): Promise<ProcessExecResult> {
  const session = new Session(input, 'activate')
  const plan = processTarget.planActivate(session.ctx, session.config)

  await stopCurrent(session, stepAt(plan, STOP_STEP))

  const startStep = stepAt(plan, START_STEP)
  session.begin(startStep)
  if (session.dryRun) {
    session.skip(startStep)
  } else {
    const started = await session.exec(argvOf(startStep))
    if (started.code !== 0) {
      return session.fail(startStep, 'DP.PROC.START_FAILED', `启动新进程失败（退出码 ${started.code}）`, {
        output: outputOf(started),
        hint:
          '旧进程已经停了，新进程又没起来 —— **服务现在是空窗的**，不是「还在跑旧的」。' +
          '原话见上，先看日志（stdoutLog 指向的文件）拿退出原因；想恢复服务就先手动起一次。' +
          '确认是配置问题就改配置重新部署，不要回滚 —— 回滚到这里也是同样的空窗',
      })
    }
    session.pass(startStep)
    session.started()
  }

  return session.result('activate', plan)
}

/**
 * ③ verify：读 pidfile 里的 pid，再用 `kill -0` 断言它还活着。
 *
 * 不用 `ps` 或 `pgrep` 比对命令行：pid 是部署时自己记下的，比对命令行会
 * 把「同名进程」误判成「我们的进程」。
 *
 * @param input 见 ProcessExecInput
 * @returns 阶段结论
 * @throws DpError `DP.PROC.NOT_RUNNING` —— pidfile 不存在或 pid 已不在
 */
export async function verifyProcess(input: ProcessExecInput): Promise<ProcessExecResult> {
  const session = new Session(input, 'verify')
  const plan = processTarget.planVerify(session.ctx, session.config)

  const step = stepAt(plan, ALIVE_STEP)
  session.begin(step)
  const pid = await readPidOf(session)
  if (pid === null) {
    return session.fail(step, 'DP.PROC.NOT_RUNNING', `pidfile 不存在或内容不是 pid：${session.paths.pidFile}`, {
      hint:
        '进程没有把自己的 pid 写下来，通常是启动时就退了，或 pidfile 被清过。' +
        '看 stdoutLog 指向的文件拿退出原因',
    })
  }
  const result = await session.exec(aliveArgv(pid))
  if (result.code !== 0) {
    return session.fail(step, 'DP.PROC.NOT_RUNNING', `pid ${pid} 已不存在（进程自己退了）`, {
      output: outputOf(result),
      hint:
        'pid 还在 pidfile 里但进程没了 —— 说明它启动后自己退出了，不是被 dp 杀的。' +
        '看 stdoutLog 指向的文件拿退出原因；常见的是端口占用、工作目录不存在、可执行权限缺失',
    })
  }
  session.pass(step)

  return session.result('verify', plan)
}

/**
 * ④ rollback：停掉当前进程，再按上一版目录里的脚本起回来。
 *
 * 与 `activate` 用的是同一套「先停后起」，只是脚本取上一版目录里的那份 ——
 * 回滚到的是**上一版实际部署出去的脚本**，不是当前配置重新渲染出来的。
 *
 * @param input 见 ProcessExecInput；`ctx.previousReleaseId` 缺失时计划期就抛错
 * @returns 阶段结论
 * @throws DpError `DP.PROC.NO_PREVIOUS` —— 上一版的启动脚本不在了（被 prune 或从未部署过）
 * @throws DpError `DP.PROC.START_FAILED` —— 上一版脚本起不来
 * @throws DpError `DP.PROC.NOT_RUNNING` —— 起来之后又没了
 */
export async function rollbackProcess(input: ProcessExecInput): Promise<ProcessExecResult> {
  const session = new Session(input, 'rollback')
  const plan = processTarget.planRollback(session.ctx, session.config)

  await stopCurrent(session, stepAt(plan, STOP_STEP))

  const startStep = stepAt(plan, START_PREVIOUS_STEP)
  session.begin(startStep)
  const previousArgv = argvOf(startStep)
  // 上一版目录可能被 prune 过：不实测就起，报出来的是「启动失败」，而真因是它没有可退的目标
  if (!(await scriptExists(session, previousArgv))) {
    return session.fail(startStep, 'DP.PROC.NO_PREVIOUS', `上一版的启动脚本不在：${previousArgv[1]}`, {
      hint:
        '回滚要跑的是上一版目录里那份脚本（那是当时真正部署出去的东西），它不在就没得退 —— ' +
        '通常是版本被 prune 了，或这是一次全新的部署。' +
        '这种情况**不返回回滚成功**；要恢复服务就指定一个还在磁盘上的历史版本重新部署',
    })
  }
  if (session.dryRun) {
    session.skip(startStep)
  } else {
    const started = await session.exec(previousArgv)
    if (started.code !== 0) {
      return session.fail(startStep, 'DP.PROC.START_FAILED', `按上一版脚本启动失败（退出码 ${started.code}）`, {
        output: outputOf(started),
        hint:
          '旧进程已停、上一版没起来 —— **服务是空窗的**。' +
          `确认 ${session.paths.releaseDir} 之外那个历史版本目录还在，然后手动起一次`,
      })
    }
    session.pass(startStep)
    session.started()
  }

  const verifyStep = stepAt(plan, ALIVE_STEP)
  session.begin(verifyStep)
  if (session.dryRun) {
    session.skip(verifyStep)
  } else {
    const pid = await readPidOf(session)
    const checked = pid === null ? { code: 1, stdout: '', stderr: '' } : await session.exec(aliveArgv(pid))
    if (pid === null || checked.code !== 0) {
      return session.fail(verifyStep, 'DP.PROC.NOT_RUNNING', `回滚后进程不存在（pid ${pid ?? '未知'}）`, {
        ...(pid === null ? {} : { output: outputOf(checked) }),
        hint:
          '回滚的停与起都跑完了，只是新起的进程没活下来 —— 也就是**上一版的服务本来就是坏的**。' +
          '看 stdoutLog 拿退出原因，再决定是修配置还是手动指定某个历史版本',
      })
    }
    session.pass(verifyStep)
  }

  return session.result('rollback', plan)
}

/**
 * 从 `DpError.cause` 里认出本执行器留下的失败现场。
 *
 * @param value `err.cause`，来源不可控，什么都可能是
 * @returns 是本包的失败现场（`ProcessExecFailure`）；其它来源一律 `false`
 */
export function isProcessExecFailure(value: unknown): value is ProcessExecFailure {
  if (typeof value !== 'object' || value === null) return false
  const record: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  return (
    typeof record['step'] === 'string' &&
    Array.isArray(record['steps']) &&
    Array.isArray(record['compensated']) &&
    Array.isArray(record['compensationErrors'])
  )
}
