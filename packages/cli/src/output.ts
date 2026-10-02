/**
 * 渲染层 —— 把 Plan / Facts / 错误变成给人或给机器看的文本。**纯函数**。
 *
 * 分成两种输出形态是硬要求（decisions.md §18）：
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
 * 退出码以 docs/transaction.md §"exit code 要区分" 为准：
 * `0` 成功 / `1` 部署失败但已完整回滚 / `2` 验证失败且已回滚 / `3` 配置错 / `4` 环境缺依赖。
 *
 * 本包只做**只读**命令，所以 tx 的 1 与 2（部署/验收类）本回合不会由我们产生。
 * 剩下没被文档覆盖的部分按任务约定补：用法错 = 2，与 tx 的 2 同码
 * （对 CI 而言都是「你给的东西不对，重跑前先改输入」），配置错 = 3，缺依赖 = 4。
 * 未知错误 = 1：不编造新码。
 */
export const EXIT_OK = 0
export const EXIT_FAILURE = 1
export const EXIT_USAGE = 2
export const EXIT_CONFIG = 3
export const EXIT_MISSING_DEPENDENCY = 4

export const EXIT_CODE_ROWS: readonly (readonly [number, string])[] = [
  [EXIT_OK, '成功'],
  [EXIT_FAILURE, '失败（未知错误，或需要 --verbose 看细节）'],
  [EXIT_USAGE, '用法/参数错：未知选项、未知命令、目标有多个却没指定'],
  [EXIT_CONFIG, '配置错：找不到 / 有冲突 / 校验不过 / source 写法有歧义'],
  [EXIT_MISSING_DEPENDENCY, '环境缺依赖：ssh 驱动不可用、工具缺失、传输链全失败'],
]

/** 纯函数：一条错误 → 退出码。CI 只认这个契约，所以它不接受任何外部状态。 */
export function exitCodeFor(err: unknown): number {
  if (err instanceof DpError) {
    if (isUsageError(err)) return EXIT_USAGE
    switch (err.code) {
      case 'CONFIG_INVALID':
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
      default:
        return EXIT_FAILURE
    }
  }
  return EXIT_FAILURE
}

// ============================================================
// 错误渲染
// ============================================================

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

export function renderFactsJson(facts: Facts, probeNotes: readonly string[] = []): string {
  return JSON.stringify({ ok: true, command: 'facts', facts, probeNotes }, null, 2)
}
