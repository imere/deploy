/**
 * status / verify / rollback 的渲染层。**纯函数**。
 *
 * 与 output.ts 里的 apply 渲染分开但形状一致：apply 的结果带 releaseId /
 * filesWritten / steps，而这三个命令不带 —— 把它们塞进同一个 interface
 * 只会逼出 `filesWritten: 0` 这种「为了填字段而编的数」。
 *
 * 信封规则沿用 apply：**永远是恰好一个 JSON 文档**，单目标平铺、多目标读
 * `results`。调用方不需要猜（铁律：--json 时 stdout 只有 JSON）。
 */
import { EXIT_CODE_ROWS } from './output.js'

export type OpsCommand = 'status' | 'verify' | 'rollback'

export interface OpsError {
  readonly code: string
  readonly message: string
  readonly path?: string
  readonly hint?: string
}

export interface StatusResult {
  readonly host: string
  readonly project: string
  readonly releaseRoot: string
  readonly current: string | null
  readonly previous: string | null
  readonly releases: readonly string[]
  readonly deployed: boolean
  /** null = 没部署过无从判断；false = 验过了且不通过。两者不能混为一谈 */
  readonly healthy: boolean | null
  readonly reason?: string
  readonly warnings: readonly string[]
  readonly error?: OpsError
}

export interface VerifyResult {
  readonly host: string
  readonly project: string
  readonly releaseRoot: string
  readonly releaseId: string | null
  readonly ok: boolean
  readonly reason?: string
  readonly warnings: readonly string[]
  readonly error?: OpsError
}

export interface RollbackResult {
  readonly host: string
  readonly project: string
  readonly releaseRoot: string
  readonly from: string | null
  readonly to: string | null
  /** 回滚后新 current 健康检查不过 = 环境需要人工介入 */
  readonly needsHealing: boolean
  readonly warnings: readonly string[]
  readonly error?: OpsError
}

export type OpsResult = StatusResult | VerifyResult | RollbackResult

/**
 * ok 的判定只看有没有 error。**不**把「status 查到不健康」算成失败：
 * status 的职责是报告事实，让它因为查到坏消息就变红就等于把报警器关掉。
 */
export function renderOpsJson(command: OpsCommand, results: readonly OpsResult[]): string {
  const single = results.length === 1 ? results[0] : undefined
  return JSON.stringify(
    {
      ok: results.every((r) => r.error === undefined),
      command,
      ...(single !== undefined ? single : {}),
      results,
    },
    null,
    2,
  )
}

export function renderOpsPretty(command: OpsCommand, result: OpsResult): string {
  const lines: string[] = [`${command} · ${result.project} → ${result.host}`]

  // 三个结果类型**都**有 warnings / error，直接读联合类型上的公共字段即可。
  // 用 `as StatusResult & VerifyResult & RollbackResult` 交叉断言是骗编译器：
  // 它让「某个类型其实没有这个字段」这类错在编译期消失
  if (command === 'status') {
    const s = result as StatusResult
    lines.push(`  发布根:     ${s.releaseRoot}`)
    lines.push(`  当前版本:   ${s.current ?? '（无）'}`)
    lines.push(`  上一版:     ${s.previous ?? '（无）'}`)
    lines.push(`  版本数:     ${s.releases.length}${s.deployed ? '' : '（尚未部署过）'}`)
    lines.push(
      `  健康:       ${s.healthy === null ? '—（没部署过，无从判断）' : s.healthy ? '✓ 通过' : `✗ ${s.reason ?? '未通过'}`}`,
    )
  } else if (command === 'verify') {
    const v = result as VerifyResult
    lines.push(`  发布根:     ${v.releaseRoot}`)
    lines.push(`  校验版本:   ${v.releaseId ?? '（无）'}`)
    lines.push(`  结论:       ${v.ok ? '✓ 通过' : `✗ ${v.reason ?? '未通过'}`}`)
  } else {
    const b = result as RollbackResult
    lines.push(`  发布根:     ${b.releaseRoot}`)
    lines.push(`  切回:       ${b.to ?? '（无）'}`)
    if (b.needsHealing) lines.push('  状态:       ！已切回但健康检查不过，需要人工介入')
  }

  if (result.warnings.length > 0) {
    lines.push('', '告警', ...result.warnings.map((w) => `  ! ${w}`))
  }
  if (result.error !== undefined) {
    lines.push('', `错误 [${result.error.code}]：${result.error.message}`)
    if (result.error.path !== undefined) lines.push(`  出错位置：${result.error.path}`)
    if (result.error.hint !== undefined) lines.push(`  下一步：${result.error.hint}`)
  }
  // 只有前两条是纯只读。rollback 真的动了 current，写同一句就成了假话 ——
  // 用户据此以为环境没变化，而事实相反
  if (command !== 'rollback') {
    lines.push('', '（只读查询：没有切换 current、没有回滚、没有清理版本）')
  } else {
    lines.push('', '（回滚只切换 current；不删除任何版本，清理留给 dp apply 的 prune）')
  }
  return lines.join('\n')
}

export { EXIT_CODE_ROWS }
