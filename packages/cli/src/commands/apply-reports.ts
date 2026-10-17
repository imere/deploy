/**
 * `dp apply` 的报告段 —— 各目标执行阶段的结果并成结果文档里的一段。
 */
import type { DockerExecResult } from '@dp/target-docker'
import type { NginxExecResult } from '@dp/target-nginx'
import type { ProcessExecResult } from '@dp/target-process'
import type { SystemdExecResult } from '@dp/target-systemd'
import type { DockerTargetResult, NginxTargetResult, ProcessTargetResult, SystemdTargetResult } from '../output.js'
import type { DockerRun } from './apply-assembly.js'

/**
 * 两个阶段的结论并成一段。`ownership` 取 install 的判定 —— activate 判的是同一份
 * 文件，重复报一次只会让人以为发生过两次判定。
 */
export function nginxReport(
  confd: string,
  results: readonly NginxExecResult[],
): NginxTargetResult {
  const steps = results.flatMap((r) => r.steps.map((s) => ({ id: s.id, kind: s.kind, ok: s.ok, skipped: s.skipped })))
  const first = results[0]
  const last = results[results.length - 1]
  if (first === undefined || last === undefined) {
    // 调用点保证至少一个阶段（配了 nginx 就一定有 install），所以这是代码错误而非部署失败
    throw new Error('nginxReport 收到了空的结果列表')
  }
  return {
    confd,
    file: last.file,
    ...(first.ownership !== undefined ? { ownership: first.ownership } : {}),
    dryRun: last.dryRun,
    reloaded: results.some((r) => r.reloaded),
    skipped: steps.filter((s) => s.skipped).map((s) => s.id),
    steps,
    warnings: results.flatMap((r) => r.warnings),
  }
}

/**
 * 四个阶段的结论并成一段。`ownership` 取 install 的判定，理由同 nginxReport。
 */
export function systemdReport(results: readonly SystemdExecResult[], unitDir: string): SystemdTargetResult {
  const steps = results.flatMap((r) => r.steps.map((s) => ({ id: s.id, kind: s.kind, ok: s.ok, skipped: s.skipped })))
  const first = results[0]
  const last = results[results.length - 1]
  if (first === undefined || last === undefined) {
    // 调用点保证至少一个阶段（配了 systemd 就一定有 install），所以这是代码错误而非部署失败
    throw new Error('systemdReport 收到了空的结果列表')
  }
  return {
    unitDir,
    file: last.file,
    unitName: last.unitName,
    ...(first.ownership !== undefined ? { ownership: first.ownership } : {}),
    dryRun: last.dryRun,
    reloaded: results.some((r) => r.reloaded),
    restarted: results.some((r) => r.restarted),
    skipped: steps.filter((s) => s.skipped).map((s) => s.id),
    steps,
    warnings: results.flatMap((r) => r.warnings),
  }
}

/**
 * 四个阶段的结论并成一段。
 *
 * 刻意**不含** pid：执行器的结果里只有 pidfile 位置（跨版本固定的那一份），
 * pid 每次激活都不同。报告里报一个会变的值等于要求读的人自己去猜哪个是当前的。
 */
export function processReport(results: readonly ProcessExecResult[]): ProcessTargetResult {
  const steps = results.flatMap((r) => r.steps.map((s) => ({ id: s.id, kind: s.kind, ok: s.ok, skipped: s.skipped })))
  const last = results[results.length - 1]
  if (last === undefined) {
    // 调用点保证配了 process 就有 install，所以这是代码错误而非部署失败
    throw new Error('processReport 收到了空的结果列表')
  }
  return {
    pidFile: last.pidFile,
    dryRun: last.dryRun,
    stopped: results.some((r) => r.stopped),
    started: results.some((r) => r.started),
    skipped: steps.filter((s) => s.skipped).map((s) => s.id),
    steps,
    warnings: results.flatMap((r) => r.warnings),
  }
}

/**
 * install + activate 的结论并成一段。
 *
 * `services` 刻意不来自这两个阶段：它们不读 ps。verify / rollback 才读。
 * 在这里造一个 services 字段就得编一份「服务列表」出来，而那正是「报告了没发生的事」。
 */
export function dockerReport(
  results: readonly DockerExecResult[],
  run: Pick<DockerRun, 'projectDir'> & { readonly projectName: string },
): DockerTargetResult {
  const steps = results.flatMap((r) => r.steps.map((s) => ({ id: s.id, kind: s.kind, ok: s.ok, skipped: s.skipped })))
  const last = results[results.length - 1]
  if (last === undefined) {
    // 调用点保证配了 docker 就有 install，所以这是代码错误而非部署失败
    throw new Error('dockerReport 收到了空的结果列表')
  }
  const ran = (id: string): boolean => results.some((r) => r.steps.some((s) => s.id === id && s.ok && !s.skipped))
  // services 只来自 verify/rollback 阶段。install / activate 不读 ps，
  // 所以它们的结果里根本没有这个字段 —— 这里不编一个空数组出来
  const services = results.find((r) => r.services !== undefined)?.services
  return {
    projectName: run.projectName,
    projectDir: run.projectDir,
    dryRun: last.dryRun,
    pulled: ran('docker.pull'),
    started: ran('docker.up'),
    skipped: steps.filter((s) => s.skipped).map((s) => s.id),
    steps,
    warnings: results.flatMap((r) => r.warnings),
    ...(services !== undefined ? { services: [...services] } : {}),
  }
}

/** dry-run 时的 plan 正文。与 plan 命令同源，让人看到的和真跑时一致 */
export function renderPlanBody(plan: { steps: readonly { id: string; kind: string; title: string }[]; releaseRoot: string; warnings: readonly string[] }): string {
  const lines = [`plan · 发布根 ${plan.releaseRoot} · ${plan.steps.length} 步`, '']
  plan.steps.forEach((s, i) => lines.push(`  ${i + 1}. [${s.kind}] ${s.title}`))
  if (plan.warnings.length > 0) {
    lines.push('', '告警', ...plan.warnings.map((w) => `  ! ${w}`))
  }
  lines.push('', '未写入任何文件（--dry-run）')
  return lines.join('\n')
}
