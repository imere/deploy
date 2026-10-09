/**
 * 渲染层 —— 把 Plan / Facts / 错误变成给人或给机器看的文本。**纯函数**。
 *
 * 分成两种输出形态是硬要求：
 *  - pretty：给人看，编号 + 缩进，一行一个事实
 *  - json：给 agent / CI 看，必须是**完整**结构，不做裁剪
 *
 * 「--json 时 stdout 只有 JSON」也是铁律：日志走 stderr，结果走 stdout。
 * 日志混进结果流，jq 就废了 —— 这是 CLI 最常见的可用性事故。
 */
import { DpError, type Facts, type Step } from '@dp/ports'
import type { CandidateResult, Plan } from '@dp/core'
import { isUsageError } from './args.js'

// ============================================================
// 退出码
// ============================================================

/**
 * 退出码要能区分「部署失败」与「验收失败且已回滚」—— CI 靠它决定要不要单独发通知：
 * `0` 成功 / `1` 部署失败但已完整回滚 / `2` 验证失败且已回滚 / `3` 配置错 / `4` 环境缺依赖。
 *
 * 本包最早的三个命令都是只读的，所以 tx 的 1 与 2（部署/验收类）一度用不上。
 * 剩下没被文档覆盖的部分按任务约定补：用法错 = 2，与 tx 的 2 同码
 * （对 CI 而言都是「你给的东西不对，重跑前先改输入」），配置错 = 3，缺依赖 = 4。
 * 未知错误 = 1：不编造新码。
 *
 * 注意 2 号码承载了两种语义（用法错 / 验证失败）。这是刻意的：CI 要能对
 * 「验证失败且已回滚」单独发通知，而**区分它们的信号是 JSON 里的
 * `error.code`（DP.VERIFY.FAILED），不是退出码** —— 所以 `--json` 下必须
 * 看 code，别只看 exit code。
 */
export const EXIT_OK = 0
/**
 * 未知错误 / 部署失败（已完整回滚）共用 1。
 *
 * 刻意不给「未知错误」单独一码：编一个新码意味着 CI 里要为一个没人能修的分类
 * 专门配处置动作，而它的实际处置与部署失败一样 —— 看日志、修输入、重跑。
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
 * 退出码 → 人话。**help.ts 引用这一份**，不另抄：
 * 退出码表在帮助里出现两次的话，用户会拿到两份可能不一致的说法。
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
 * 判据是**错误码**而不是异常类型：`DpError` 的 code 是全仓登记的封闭联合，
 * 而按类型分派的话，同一个 code 从不同包抛出就会得到不同退出码。
 *
 * @param err 任意抛出物；非 DpError 一律退 1（不猜 —— `undefined is not a
 *   function` 这类信息在退出码上没有可区分的语义）
 * @returns `EXIT_*` 之一
 */
export function exitCodeFor(err: unknown): number {
  if (err instanceof DpError) {
    if (isUsageError(err)) return EXIT_USAGE
    switch (err.code) {
      case 'DP.CONFIG.INVALID':
      case 'DP.SOURCE.EMPTY':
      case 'DP.PATH.RESERVED_NAME':
      case 'DP.PATH.ILLEGAL_CHAR':
      case 'DP.PATH.TOO_LONG':
      case 'DP.PATH.CASE_COLLISION':
      case 'DP.PATH.WSL_MOUNT':
      case 'DP.PATH.NOT_WRITABLE':
      case 'DP.LAYOUT.MISMATCH':
      case 'DP.LAYOUT.UNSUPPORTED':
        return EXIT_CONFIG
      case 'DP.SSH.TOOL_MISSING':
      case 'DP.SSH.DRIVER_UNAVAILABLE':
      case 'DP.SSH.CONNECT_FAILED':
      case 'DP.SSH.TUNNEL_FAILED':
      case 'DP.SSH.AUTH_FAILED':
      case 'DP.SSH.HOST_KEY_UNKNOWN':
      case 'DP.SSH.HOST_KEY_MISMATCH':
      case 'DP.PREF.UNSUPPORTED':
      case 'DP.LINK.UNAVAILABLE':
        return EXIT_MISSING_DEPENDENCY
      // 验证失败**且已回滚**：CI 靠这个码单独发通知，所以它不能和「部署失败
      // 但已完整回滚」的 1 混在一起
      case 'DP.VERIFY.FAILED':
        return EXIT_VERIFY_FAILED
      default:
        return EXIT_FAILURE
    }
  }
  return EXIT_FAILURE
}

// ============================================================
// 错误渲染
// ============================================================

/**
 * 错误的标准形态。**结构化**而不是一段拼好的字符串：
 * JSON 输出与 pretty 输出消费的是同一份数据，pretty 那边加行、裁字段
 * 都不会让 JSON 侧漂移。
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
 * 非 DpError 一律给 `DP.CLI.INTERNAL` 加一句可执行建议：裸 message
 * （比如 `undefined is not a function`）对谁都没用，而 code 这个字段
 * 存在的意义就是让调用方有稳定的字符串可匹配。
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
  return { code: 'DP.CLI.INTERNAL', message, hint: GENERIC_HINT, exitCode: EXIT_FAILURE }
}

/**
 * 人看的错误文本。写 stderr（由调用方决定），这里只管内容。
 *
 * 非 verbose 时**不**打 stack 但仍打一行「--verbose 可打印完整 stack」——
 * 静默不给栈会让用户以为 dp 已经把根因处理掉了。
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
 * `exitCode` 在 JSON 里重复一份：退出码本身不足以区分（2 号位承载两种语义），
 * 靠这里的 `error.code` 才是可靠信号。
 *
 * @param err 任意抛出物
 * @param verbose true 时顶层多一个 stack 字段（**只有** verbose 才出现，
 *   不给 null 占位 —— 让调用方用 `'stack' in obj` 判断即可）
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

// ============================================================
// Plan 渲染
// ============================================================

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
 * plan 的人看输出。**只读干跑**是它承诺的核心，所以最后一行明写
 * 「没有创建任何目录，也没有写任何文件」—— 这行字是给用户和 CI 同时看的断言。
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
 * plan 的 JSON 输出。**结构完整、不做裁剪** —— 它是 `--facts` 的对照组，
 * 裁掉字段会让「同一份配置在两台机器上推出不同结果」变得无法复查。
 *
 * @param plan makePlan 的产物，原样嵌入
 * @param context 项目 / 主机 / releaseId 是 plan 之外的信息，只能由调用方给；
 *   probeNotes 缺省给空数组而不是省略键，省得消费方写两套取值
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

// ============================================================
// Facts 渲染
// ============================================================

function renderWritable(canWrite: Readonly<Record<string, boolean>>): string[] {
  const keys = Object.keys(canWrite).sort()
  if (keys.length === 0) return ['  （未探测写权限）']
  return keys.map((k) => `  ${canWrite[k] === true ? '✓' : '✗'} ${k}`)
}

/**
 * facts 的人看输出。逐条列出**实测**结论与对应的路径/命令名，
 * 让人能自己核对某条结论（比如「canWrite 里为什么少了 /opt」）。
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
 * 它的用途是喂给 `dp plan --facts` 复现同一份计划，所以一个字段都不能少：
 * 少一个字段就等于「用这份 facts 跑出来的结论和真机探测的不一定一致」，
 * 而那种不一致是在几周后才体现的 bug。
 *
 * @param facts 探测产物
 * @param probeNotes 探测说明，默认空数组
 * @returns 缩进 2 的 JSON 字符串
 */
export function renderFactsJson(facts: Facts, probeNotes: readonly string[] = []): string {
  return JSON.stringify({ ok: true, command: 'facts', facts, probeNotes }, null, 2)
}

// ============================================================
// Apply 渲染
// ============================================================

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
 *
 * 刻意不含「回滚了没有」：docker 执行器**不做任何自动补偿**（compose.ts 的注释里
 * 写了理由），所以这一段没有任何自动动作可报 —— 它的失败只以 apply 的 error +
 * warnings 出现。列一个恒为 false 的字段会让读结果的人以为「查过、没回滚」。
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
}

/**
 * apply 的 JSON 结果。**永远是恰好一个 JSON 文档**（铁律：stdout 只有 JSON）。
 *
 * 单目标时把字段平铺到顶层：最常见的形状，也省掉 agent 侧的一层解包；
 * 多目标时平铺不了，就统一读 `results`。规则是确定的、只看数组长度，
 * 调用方不需要猜。
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
 * 步骤的标记刻意分三种（`-` / `✓` / `✗`）：`skipped` 的判据是
 * 「机器上有没有留下作用」，不是「跑没跑」。渲染成同一个 `✓` 会让 dry-run
 * 的报告看起来像真备份过、真拉过镜像、真起过容器 —— 「报告了没发生的副作用」
 * 比不做更难发现。
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
      // 渲染成同一个 ✓ 会让 dry-run 的报告看起来像是真备份过
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
      // 而 ps 跑了 —— 把它们渲染成同一个 ✓ 会让报告看起来像是真拉过真起过
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
