import { ERR, DpError, type Facts, type Step } from '@dp/ports'
import type { CandidateResult, Plan } from '@dp/core'
import { isUsageError } from './args.js'

// 退出码

/**
 * 退出码要能区分「部署失败」与「验收失败且已回滚」—— CI 靠它决定要不要单独发通知：`0` 成功 / `1` 部署失败但已完整回滚 / `2` 验证失败且已回滚 / `3` 配置错 / `4` 环境缺依赖。
 */
export const EXIT_OK = 0
/**
 * 未知错误 / 部署失败（已完整回滚）共用 1。
 */
export const EXIT_FAILURE = 1
/** 与 EXIT_VERIFY_FAILED 同为 2：两者对 CI 都是「先改输入再重跑」 */
export const EXIT_USAGE = 2
/** 验证失败且已回滚。与 EXIT_USAGE 同码，见上方说明 */
export const EXIT_VERIFY_FAILED = 2
/** 配置错：用户改了配置重跑就能好，与机器状态无关 */
export const EXIT_CONFIG = 3
/** 缺依赖：重跑无用，要装东西 / 换驱动 / 改配置里的传输链 */
export const EXIT_MISSING_DEPENDENCY = 4

/**
 * 退出码 → 人话。**help.ts 引用这一份**，不另抄：退出码表在帮助里出现两次的话，用户会拿到两份可能不一致的说法。
 */
export const EXIT_CODE_ROWS: readonly (readonly [number, string])[] = [
  [EXIT_OK, '成功'],
  [EXIT_FAILURE, '失败（未知错误，或需要 --verbose 看细节）'],
  [EXIT_USAGE, '用法/参数错，或验证失败且已回滚（用 --json 看 error.code 区分）'],
  [EXIT_CONFIG, '配置错：找不到 / 有冲突 / 校验不过 / source 写法有歧义'],
  [EXIT_MISSING_DEPENDENCY, '环境缺依赖：ssh 驱动不可用、工具缺失、传输链全失败'],
]

/**
 * 一条错误 → 退出码。纯函数：CI 只认这个契约，所以它不接受任何外部状态。
 *
 * @param err 任意抛出物；非 DpError 一律退 1（不猜 —— `undefined is not a
 * function` 这类信息在退出码上没有可区分的语义）
 * @returns `EXIT_*` 之一
 */
export function exitCodeFor(err: unknown): number {
  if (err instanceof DpError) {
    if (isUsageError(err)) return EXIT_USAGE
    switch (err.code) {
      case ERR.CONFIG.INVALID:
      case ERR.SOURCE.EMPTY:
      case ERR.PATH.RESERVED_NAME:
      case ERR.PATH.ILLEGAL_CHAR:
      case ERR.PATH.TOO_LONG:
      case ERR.PATH.CASE_COLLISION:
      case ERR.PATH.NOT_WRITABLE:
      case ERR.LAYOUT.MISMATCH:
        return EXIT_CONFIG
      case ERR.SSH.TOOL_MISSING:
      case ERR.SSH.DRIVER_UNAVAILABLE:
      case ERR.SSH.CONNECT_FAILED:
      case ERR.SSH.TUNNEL_FAILED:
      case ERR.SSH.AUTH_FAILED:
      case ERR.SSH.HOST_KEY_UNKNOWN:
      case ERR.SSH.HOST_KEY_MISMATCH:
      case ERR.PREF.UNSUPPORTED:
      case ERR.LINK.UNAVAILABLE:
        return EXIT_MISSING_DEPENDENCY
      // 验证失败**且已回滚**：CI 靠这个码单独发通知，所以它不能和「部署失败
      case ERR.VERIFY.FAILED:
        return EXIT_VERIFY_FAILED
      default:
        return EXIT_FAILURE
    }
  }
  return EXIT_FAILURE
}

// 错误渲染

/**
 * 错误的标准形态。**结构化**而不是一段拼好的字符串：JSON 输出与 pretty 输出消费的是同一份数据，pretty 那边加行、裁字段都不会让 JSON 侧漂移。
 */
export interface ErrorReport {
  readonly code: string
  readonly message: string
  readonly path?: string
  readonly hint?: string
  readonly exitCode: number
  /** 仅 --verbose 时非空 */
  readonly stack?: string
}

/** 未知错误也要给一行可执行建议 —— 裸 "undefined is not a function" 对谁都没用。 */
const GENERIC_HINT = '加 --verbose 看完整 stack；若确认是 dp 的问题，请连同命令与配置一起报 issue'

/**
 * 异常 → ErrorReport。pretty 与 json 两种渲染的唯一共同入口。
 *
 * @param err 任意抛出物，非 Error 也接受（`String(err)` 兜底）
 * @returns 报告；`stack` 永远不填（栈是渲染期按 --verbose 现取的）
 */
export function describeError(err: unknown): ErrorReport {
  if (err instanceof DpError) {
    const report: ErrorReport = {
      code: err.code,
      message: err.message,
      path: err.path,
      hint: err.hint,
      exitCode: exitCodeFor(err),
    }
    return report
  }
  const message = err instanceof Error ? err.message : String(err)
  return { code: ERR.CLI.INTERNAL, message, hint: GENERIC_HINT, exitCode: EXIT_FAILURE }
}

/**
 * 人看的错误文本。写 stderr（由调用方决定），这里只管内容。
 *
 * @param err 任意抛出物
 * @param verbose 是否附带完整 stack
 * @returns 多行文本，不含结尾换行
 */
export function renderErrorPretty(err: unknown, verbose: boolean): string {
  const r = describeError(err)
  const lines = [`错误 [${r.code}]：${r.message}`]
  if (r.path !== undefined) lines.push(`  出错位置：${r.path}`)
  if (r.hint !== undefined) lines.push(`  下一步：${r.hint}`)
  if (verbose && r.stack !== undefined) lines.push(r.stack)
  if (!verbose && err instanceof Error && err.stack !== undefined) {
    lines.push('  （--verbose 可打印完整 stack）')
  }
  return lines.join('\n')
}

/**
 * 机器看的错误。**恰好一个 JSON 文档**（铁律：--json 时 stdout 只有 JSON）。
 *
 * @param err 任意抛出物
 * @param verbose true 时顶层多一个 stack 字段（**只有** verbose 才出现，
 * 不给 null 占位 —— 让调用方用 `'stack' in obj` 判断即可）
 * @returns 缩进 2 的 JSON 字符串
 */
export function renderErrorJson(err: unknown, verbose: boolean): string {
  const r = describeError(err)
  const out: Record<string, unknown> = {
    ok: false,
    error: { code: r.code, message: r.message, path: r.path, hint: r.hint },
    exitCode: r.exitCode,
  }
  if (verbose && err instanceof Error && err.stack !== undefined) out['stack'] = err.stack
  return JSON.stringify(out, null, 2)
}

// Plan 渲染

/** 序号宽度跟着步数走：两位数时不能把列挤歪 */
function indexWidth(count: number): number {
  return String(count).length
}

function renderCandidates(candidates: readonly CandidateResult[]): string[] {
  if (candidates.length === 0) return []
  return [
    '发布根候选（实证可写性，不靠 uid 推断）',
    ...candidates.map((c) => `  ${c.writable ? '✓' : '✗'} ${c.path}${c.reason ? ` —— ${c.reason}` : ''}`),
  ]
}

function renderStep(step: Step, index: number, width: number): string[] {
  const head = `  ${String(index).padStart(width, ' ')}. [${step.kind}] ${step.title}`
  const lines = [head, `     host: ${step.host}`]
  if (step.undo !== undefined) lines.push(`     undo: ${step.undo}`)
  if (step.detail !== undefined) {
    for (const [key, value] of Object.entries(step.detail)) {
      lines.push(`     ${key}: ${formatDetailValue(value)}`)
    }
  }
  return lines
}

function formatDetailValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * plan 的人看输出。**只读干跑**是它承诺的核心，所以最后一行明写「没有创建任何目录，也没有写任何文件」—— 这行字是给用户和 CI 同时看的断言。
 *
 * @param plan makePlan 的产物
 * @param options probeNotes 是探测过程的说明（为什么选了不可写的目录之类）
 * @returns 多行文本；末行固定是干跑声明
 */
export function renderPlanPretty(plan: Plan, options: { readonly probeNotes?: readonly string[] } = {}): string {
  const width = indexWidth(plan.steps.length)
  const lines = [
    `plan · 布局 ${plan.layout} · 发布根 ${plan.releaseRoot} · ${plan.steps.length} 步`,
    '',
    ...plan.steps.flatMap((step, i) => renderStep(step, i + 1, width)),
  ]
  const candidates = renderCandidates(plan.candidates)
  if (candidates.length > 0) lines.push('', ...candidates)
  if (plan.warnings.length > 0) {
    lines.push('', '告警', ...plan.warnings.map((w) => `  ! ${w}`))
  }
  const notes = options.probeNotes ?? []
  if (notes.length > 0) {
    lines.push('', '探测说明', ...notes.map((n) => `  - ${n}`))
  }
  lines.push('', '（只读干跑：没有创建任何目录，也没有写任何文件）')
  return lines.join('\n')
}

/**
 * plan 的 JSON 输出。**结构完整、不做裁剪** —— 它是 `--facts` 的对照组，裁掉字段会让「同一份配置在两台机器上推出不同结果」变得无法复查。
 *
 * @param plan makePlan 的产物，原样嵌入
 * @param context 项目 / 主机 / releaseId 是 plan 之外的信息，只能由调用方给；
 * probeNotes 缺省给空数组而不是省略键，省得消费方写两套取值
 * @returns 缩进 2 的 JSON 字符串
 */
export function renderPlanJson(
  plan: Plan,
  context: { readonly project?: string; readonly host?: string; readonly releaseId?: string; readonly probeNotes?: readonly string[] },
): string {
  return JSON.stringify(
    {
      ok: true,
      command: 'plan',
      project: context.project,
      host: context.host,
      releaseId: context.releaseId,
      plan,
      probeNotes: context.probeNotes ?? [],
    },
    null,
    2,
  )
}

// Facts 渲染

function renderWritable(canWrite: Readonly<Record<string, boolean>>): string[] {
  const keys = Object.keys(canWrite).sort()
  if (keys.length === 0) return ['  （未探测写权限）']
  return keys.map((k) => `  ${canWrite[k] === true ? '✓' : '✗'} ${k}`)
}

/**
 * facts 的人看输出。逐条列出**实测**结论与对应的路径/命令名，让人能自己核对某条结论（比如「canWrite 里为什么少了 /opt」）。
 *
 * @param facts 探测产物
 * @param probeNotes 探测说明，默认不打印
 * @returns 多行文本
 */
export function renderFactsPretty(facts: Facts, probeNotes: readonly string[] = []): string {
  const c = facts.capabilities
  const lines = [
    `facts · host ${facts.host} · ${facts.platform}/${facts.arch} · init ${facts.init}`,
    `  homedir: ${facts.homedir}`,
    `  tmpdir: ${facts.tmpdir}`,
    '',
    '能力（全部实测）',
    `  canSymlink: ${c.canSymlink}`,
    `  systemdScope: ${c.systemdScope}`,
    `  lingerEnabled: ${c.lingerEnabled}`,
    `  canBindPrivilegedPort: ${c.canBindPrivilegedPort}`,
    `  sudoAllowlist: ${c.sudoAllowlist.length > 0 ? c.sudoAllowlist.join(' | ') : '（无）'}`,
    `  canChown: ${c.canChown.length > 0 ? c.canChown.join(' | ') : '（无）'}`,
    '',
    '可写性',
    ...renderWritable(c.canWrite),
    '',
    '工具',
    ...Object.keys(facts.tools)
      .sort()
      .map((k) => `  ${facts.tools[k] ?? '（未找到）'}  ${k}`),
  ]
  if (probeNotes.length > 0) {
    lines.push('', '探测说明', ...probeNotes.map((n) => `  - ${n}`))
  }
  return lines.join('\n')
}

/**
 * facts 的 JSON 输出，**原样嵌整个 Facts**。
 *
 * @param facts 探测产物
 * @param probeNotes 探测说明，默认空数组
 * @returns 缩进 2 的 JSON 字符串
 */
export function renderFactsJson(facts: Facts, probeNotes: readonly string[] = []): string {
  return JSON.stringify({ ok: true, command: 'facts', facts, probeNotes }, null, 2)
}

// Apply 渲染

/** nginx 阶段的结论。字段全部来自 NginxExecResult，不另造一套** */
export interface NginxTargetResult {
  readonly confd: string
  /** confd 里的目标文件（含目录） */
  readonly file: string
  readonly ownership?: { readonly action: string; readonly reason: string; readonly backup: boolean }
  readonly dryRun: boolean
  readonly reloaded: boolean
  /** 本次在机器上没留下作用的步骤 id */
  readonly skipped: readonly string[]
  readonly steps: ReadonlyArray<{ id: string; kind: string; ok: boolean; skipped: boolean }>
  readonly warnings: readonly string[]
}

/**
 * docker 阶段的结论。字段全部来自 DockerExecResult，不另造一套。
 */
export interface DockerTargetResult {
  readonly projectName: string
  /** compose 的项目目录（= release 目录）。up / ps 的 cwd 都固定在这里 */
  readonly projectDir: string
  readonly dryRun: boolean
  /** install + activate 的合并结论。verify 阶段的 services 不混进来 */
  readonly pulled: boolean
  readonly started: boolean
  /** 本次在机器上没留下作用的步骤 id */
  readonly skipped: readonly string[]
  readonly steps: ReadonlyArray<{ id: string; kind: string; ok: boolean; skipped: boolean }>
  readonly warnings: readonly string[]
  /** verify / rollback 读到的服务状态。install / activate 没有 */
  readonly services?: ReadonlyArray<{ service: string; state: string; status: string; health: string }>
}

/**
 * systemd 阶段的结论。字段全部来自 SystemdExecResult，不另造一套。
 */
export interface SystemdTargetResult {
  readonly unitDir: string
  /** unitDir 里的目标文件（含目录） */
  readonly file: string
  readonly unitName: string
  readonly ownership?: { readonly action: string; readonly reason: string; readonly backup: boolean }
  readonly dryRun: boolean
  readonly reloaded: boolean
  readonly restarted: boolean
  /** 本次在机器上没留下作用的步骤 id */
  readonly skipped: readonly string[]
  readonly steps: ReadonlyArray<{ id: string; kind: string; ok: boolean; skipped: boolean }>
  readonly warnings: readonly string[]
}

/**
 * process 阶段的结论。字段全部来自 ProcessExecResult，不另造一套。
 */
export interface ProcessTargetResult {
  /** 进程管理的落点。跨版本只有一份，所以激活时要停的「当前那个」才找得到 */
  readonly pidFile: string
  readonly dryRun: boolean
  /** 停旧进程这一步真跑过（首次部署没有 pidfile、或 dryRun 时为 false） */
  readonly stopped: boolean
  readonly started: boolean
  /** 本次在机器上没留下作用的步骤 id */
  readonly skipped: readonly string[]
  readonly steps: ReadonlyArray<{ id: string; kind: string; ok: boolean; skipped: boolean }>
  readonly warnings: readonly string[]
}

/** 一个目标机的执行结果。刻意**不含** ok / command —— 那两个是信封级字段 */
export interface ApplyTargetResult {
  readonly project: string
  readonly host: string
  readonly releaseId: string
  readonly previousReleaseId?: string
  readonly filesWritten: number
  readonly rolledBack: boolean
  readonly warnings: readonly string[]
  readonly steps: ReadonlyArray<{ id: string; kind: string; ok: boolean }>
  readonly probeNotes: readonly string[]
  readonly dryRun: boolean
  /** 失败时非空。JSON 输出里必须带它，否则 CI 拿不到失败原因 */
  readonly error?: { code: string; message: string; path?: string; hint?: string }
  /** 回滚本身也失败 = needsHealing 环境真的需要人工介入 */
  readonly needsHealing?: boolean
  /** 配了 target.nginx 才有。conf 这一半的结论与 release 那一半分开记 */
  readonly nginx?: NginxTargetResult
  /** 配了 target.docker 才有 */
  readonly docker?: DockerTargetResult
  /** 配了 target.systemd 才有 */
  readonly systemd?: SystemdTargetResult
  /** 配了 target.process 才有 */
  readonly process?: ProcessTargetResult
}

/**
 * apply 的 JSON 结果。**永远是恰好一个 JSON 文档**（铁律：stdout 只有 JSON）。
 *
 * @param results 这次实际处理的目标列表；空数组也能渲染（ok 为 true）
 * @returns 缩进 2 的 JSON 字符串，`ok` = 所有目标都没有 error 字段
 */
export function renderApplyJson(results: readonly ApplyTargetResult[]): string {
  const single = results.length === 1 ? results[0] : undefined
  return JSON.stringify(
    {
      ok: results.every((r) => r.error === undefined),
      command: 'apply',
      ...(single !== undefined ? single : {}),
      results,
    },
    null,
    2,
  )
}

/**
 * 单个目标机的人看输出。
 *
 * @param result 一个目标的执行结论
 * @returns 多行文本
 */
export function renderApplyPretty(result: ApplyTargetResult): string {
  const head = result.dryRun
    ? `apply --dry-run · ${result.project} → ${result.host}（未写入任何文件）`
    : `apply · ${result.project} → ${result.host}`
  const lines = [head, `  releaseId: ${result.releaseId}`]
  if (result.previousReleaseId !== undefined) lines.push(`  上一版:     ${result.previousReleaseId}`)
  if (!result.dryRun) lines.push(`  写入文件:   ${result.filesWritten}`)
  for (const step of result.steps) {
    lines.push(`  ${step.ok ? '✓' : '✗'} [${step.kind}] ${step.id}`)
  }
  if (result.rolledBack) lines.push('  已回滚到上一版')
  if (result.nginx !== undefined) {
    const n = result.nginx
    lines.push('', `nginx · ${n.file}`)
    lines.push(`  confd:   ${n.confd}`)
    if (n.ownership !== undefined) lines.push(`  所有权:   ${n.ownership.action} —— ${n.ownership.reason}`)
    lines.push(`  reload:  ${n.dryRun ? '未发（--dry-run）' : n.reloaded ? '已发出' : '未发'}`)
    for (const step of n.steps) {
      // skipped 单独标出来：它判据是「机器上有没有留下作用」，不是「跑没跑」。
      const mark = step.skipped ? '-' : step.ok ? '✓' : '✗'
      const note = step.skipped ? '（未在机器上留下作用）' : ''
      lines.push(`  ${mark} [${step.kind}] ${step.id}${note}`)
    }
    if (n.warnings.length > 0) {
      lines.push('', 'nginx 告警', ...n.warnings.map((w) => `  ! ${w}`))
    }
  }
  if (result.docker !== undefined) {
    const d = result.docker
    lines.push('', `docker · ${d.projectName}`)
    lines.push(`  项目目录:   ${d.projectDir}`)
    lines.push(
      `  启动:       ${d.dryRun ? '未启动（--dry-run）' : d.started ? '已启动' : '未启动'}`,
    )
    for (const step of d.steps) {
      // skipped 的判据是「机器上有没有留下作用」。pull 与 up 在 dry-run 下没跑过，
      const mark = step.skipped ? '-' : step.ok ? '✓' : '✗'
      const note = step.skipped ? '（未在机器上留下作用）' : ''
      lines.push(`  ${mark} [${step.kind}] ${step.id}${note}`)
    }
    if (d.services !== undefined && d.services.length > 0) {
      lines.push('', 'docker 服务状态')
      for (const s of d.services) {
        const health = s.health === '' ? '（没配 healthcheck）' : s.health
        lines.push(`  ${s.service}: state=${s.state} health=${health} status=${s.status}`)
      }
    }
    if (d.warnings.length > 0) {
      lines.push('', 'docker 告警', ...d.warnings.map((w) => `  ! ${w}`))
    }
  }
  if (result.systemd !== undefined) {
    const s = result.systemd
    lines.push('', `systemd · ${s.unitName}`)
    lines.push(`  unitDir:  ${s.unitDir}`)
    if (s.ownership !== undefined) lines.push(`  所有权:   ${s.ownership.action} —— ${s.ownership.reason}`)
    lines.push(
      `  daemon-reload: ${s.dryRun ? '未发（--dry-run）' : s.reloaded ? '已发出' : '未发'}`,
    )
    lines.push(`  restart:  ${s.dryRun ? '未发（--dry-run）' : s.restarted ? '已发出' : '未发'}`)
    for (const step of s.steps) {
      const mark = step.skipped ? '-' : step.ok ? '✓' : '✗'
      const note = step.skipped ? '（未在机器上留下作用）' : ''
      lines.push(`  ${mark} [${step.kind}] ${step.id}${note}`)
    }
    if (s.warnings.length > 0) {
      lines.push('', 'systemd 告警', ...s.warnings.map((w) => `  ! ${w}`))
    }
  }
  if (result.process !== undefined) {
    const p = result.process
    lines.push('', `process · ${p.pidFile}`)
    lines.push(`  停止旧进程: ${p.dryRun ? '未停（--dry-run）' : p.stopped ? '已停' : '没有可停的（首次部署）'}`)
    lines.push(`  启动新进程: ${p.dryRun ? '未启动（--dry-run）' : p.started ? '已启动' : '未启动'}`)
    for (const step of p.steps) {
      const mark = step.skipped ? '-' : step.ok ? '✓' : '✗'
      const note = step.skipped ? '（未在机器上留下作用）' : ''
      lines.push(`  ${mark} [${step.kind}] ${step.id}${note}`)
    }
    if (p.warnings.length > 0) {
      lines.push('', 'process 告警', ...p.warnings.map((w) => `  ! ${w}`))
    }
  }
  if (result.warnings.length > 0) {
    lines.push('', '告警', ...result.warnings.map((w) => `  ! ${w}`))
  }
  if (result.probeNotes.length > 0) {
    lines.push('', '探测说明', ...result.probeNotes.map((n) => `  - ${n}`))
  }
  if (result.error !== undefined) {
    lines.push('', `错误 [${result.error.code}]：${result.error.message}`)
    if (result.error.hint !== undefined) lines.push(`  下一步：${result.error.hint}`)
  }
  return lines.join('\n')
}
