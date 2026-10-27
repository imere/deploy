/**
 * `dp apply` 的失败文案 —— 收场说明只允许在这一层写：每个目标失败时机器处在
 * 什么状态、为什么**不**自动回滚、下一步敲什么命令。
 */
import { isDockerExecFailure } from '@dp/target-docker'
import { isProcessExecFailure } from '@dp/target-process'
import { isSystemdExecFailure } from '@dp/target-systemd'
import { exitCodeFor } from '../output.js'
import { targetErrorFields } from '../target-resolve.js'

import { WARN } from '@dp/ports'
/**
 * needsHealing 时的告警文案。
 *
 * 这是「明确承认」而不是把错误吞掉：保留现场不继续自动操作，说清现在环境是
 * A 部分生效、B 部分没回滚，并给一条**人能直接敲**的下一步命令。
 */
export function healingWarning(root: string, rbErr: unknown): string {
  return [
    `${WARN.HEALING.REQUIRED}: 环境处于部分回滚状态 —— 新版本已部分生效，回滚未能完成`,
    `下一步：1) 人工查看 ${root}/releases 下的版本目录；`,
    `2) 把 ${root}/current 指回可用版本（Linux/macOS：ln -sfn <root>/releases/<版本> ${root}/current` +
      `；Windows 无软链权限时把 ${root}/current 目录内容替换为该版本）；`,
    '3) 确认服务正常后再重跑 dp apply',
    `回滚失败原因：${targetErrorFields(rbErr).message}`,
  ].join('\n')
}

/**
 * activate 失败时机器处在什么状态。**不写「已回滚」**是刻意的：
 * conf 失败而版本本身是好的（deploy 的健康检查过了），为一个 conf 问题把一次
 * 成功的发布退掉，是把两件独立的事绑成一次失败。旧 conf 指向的是 `release.current`
 * 软链，所以线上仍然在服务，不是悬空。
 */
export function activateFailedWarning(
  releaseId: string,
  /** `${release.current}` 展开后的真实软链位置。confd 里没有 current 这种东西，
   *  把 confd 拼上去会指向一个根本不存在的路径 */
  currentPath: string,
  f: { readonly code: string; readonly message: string },
): string {
  return [
    `版本已切到 ${releaseId}，conf 未更新，nginx 仍在用旧的 conf（它的 root 指向 ${currentPath} 软链，所以服务没有中断）。`,
    `失败原因 [${f.code}]：${f.message}`,
    '下一步：按 nginx 的原话修好 target.nginx 的配置后重跑 dp apply。',
    '**不要回滚这次发布** —— 版本本身是好的，退掉它只会把「一个 conf 问题」变成「一次服务中断」。',
  ].join('\n')
}

/**
 * systemd 失败时机器处在什么状态。**按失败的那一步分**而不是一句话糊过去：
 * 「unit 已落盘但 systemd 还没读到」与「unit 已生效但服务没起来」要做的下一步完全不同，
 * 而它们的现场都还在盘上（备份也在），处置方式相反。
 *
 * @param err 执行器抛出的原始错误。错误码与失败现场都从它身上取，不另传一份 ——
 * 另传就多一处可能对不上的来源
 * @param releaseId 本次已生效的版本号
 * @returns 给人看的收场说明，含 systemd 的原话
 */
export function systemdFailureWarning(err: unknown, releaseId: string): string {
  const f = targetErrorFields(err)
  const failure = execFailureOf(err)
  if (!isSystemdExecFailure(failure)) {
    return `systemd 阶段失败 [${f.code}]：${f.message}（没能拿到结构化的失败现场，这不该发生，请连同配置报 issue）`
  }
  const scene =
    failure.step === 'systemd.daemon-reload'
      ? `版本已切到 ${releaseId}，新 unit 已写进 ${failure.file}，但 systemd daemon-reload 失败 —— 机器上生效的仍是上一份 unit（备份在 ${failure.file}.dp-backup），服务没断`
      : `版本已切到 ${releaseId}，unit 已落盘并完成 daemon-reload，但服务没起来 —— 机器现在的状态是「新 unit + 无服务」`
  const lines = [
    `systemd 阶段失败 [${failure.step}]：${scene}。`,
    '**没有回滚这次发布** —— 版本本身是好的（deploy 的健康检查过了），为了一份 unit 的问题把一次成功的发布退掉，只会把两件独立的事绑成一次失败。',
    `失败原因 [${f.code}]：${f.message}`,
    '下一步：按下面的原话排查服务自身（端口占用、可执行权限、WorkingDirectory 不存在都属这一类），修好后重跑 dp apply 或直接 systemctl restart。',
  ]
  if (failure.compensationErrors.length > 0) {
    lines.push(`【补偿未完全成功，以下副作用留在机器上，需人工处理：${failure.compensationErrors.join('；')}】`)
  }
  if (failure.output !== undefined) lines.push(`systemd 原话：\n${failure.output}`)
  return lines.join('\n')
}

/**
 * process 失败时机器处在什么状态。**按失败的那一步分**：
 * 「停不掉旧进程」与「旧进程停了但新的没起来」是两种现场，而后一种是**服务空窗** ——
 * 报成「部署失败」会让人以为线上还在跑旧版本。
 *
 * @param err 执行器抛出的原始错误。错误码与失败现场都从它身上取，不另传一份 ——
 * 另传就多一处可能对不上的来源
 * @param releaseId 本次已生效的版本号
 * @returns 给人看的收场说明，含子进程的原话
 */
export function processFailureWarning(err: unknown, releaseId: string): string {
  const f = targetErrorFields(err)
  const failure = execFailureOf(err)
  if (!isProcessExecFailure(failure)) {
    return `process 阶段失败 [${f.code}]：${f.message}（没能拿到结构化的失败现场，这不该发生，请连同配置报 issue）`
  }
  // 两种现场的下一步不同，「要不要退版本」的结论也不同，所以两句都分开写：
  // 合成一句就会在「旧进程还在跑」的情况下也说出「空窗」—— 那会让人以为线上没服务了
  const stopped =
    failure.step === 'process.stop-current'
      ? {
          scene: `版本已切到 ${releaseId}，但旧进程停不下来 —— **新版本没有启动**，机器上跑的还是旧进程（它仍占着 ${failure.pidFile}）`,
          noRollback:
            '**没有回滚这次发布** —— 版本本身是好的（deploy 的健康检查过了），而旧进程还在服务，退掉它不会让线上更好。',
        }
      : {
          scene: `版本已切到 ${releaseId}，旧进程已停、新进程没起来 —— **服务现在是空窗的**，不是「还在跑旧的」`,
          noRollback:
            '**没有回滚这次发布** —— 版本本身是好的（deploy 的健康检查过了），而且回滚到这里是同样的空窗。',
        }
  const lines = [
    `process 阶段失败 [${failure.step}]：${stopped.scene}。`,
    stopped.noRollback,
    `失败原因 [${f.code}]：${f.message}`,
    `下一步：先看 stdoutLog 指向的文件拿退出原因，pidfile 在 ${failure.pidFile}；想先恢复服务就按上一版的启动脚本手动起一次。`,
  ]
  if (failure.compensationErrors.length > 0) {
    lines.push(`【补偿未完全成功，以下副作用留在机器上，需人工处理：${failure.compensationErrors.join('；')}】`)
  }
  if (failure.output !== undefined) lines.push(`process 原话：\n${failure.output}`)
  return lines.join('\n')
}

/**
 * 失败时把执行器给的 healing 逐条带出来。
 *
 * 这不是「附赠信息」：执行器刻意**不做任何自动补偿**（自动 down 会连停掉目标机上
 * 同名的其它项目，自动 up 上一版会把「失败」与「已回滚」两个语义混进一个结果），
 * 所以那几条命令是用户唯一的下一步。吞掉它们等于留下一个「报失败但不说怎么修」
 * 的部署。
 */
export function dockerFailureWarning(err: unknown, releaseId: string): string {
  // 执行器把失败现场挂在 DpError.cause 上（ports 的 DpError 走 Error 的 cause，
  // 不是自定义字段）。传错对象会让 healing 整段消失 —— 而那是唯一的下一步
  const failure = execFailureOf(err)
  if (!isDockerExecFailure(failure)) {
    return 'docker 阶段失败，但没能拿到结构化的失败现场（这不该发生，请连同配置报 issue）'
  }
  const lines = [
    `docker 阶段失败 [${failure.step}]：版本 ${releaseId} 已部署，但服务没有按新版本起来。`,
    '**没有执行任何自动补偿** —— 跑着的可能是上一版的容器（它仍在服务），也可能已经被换了一半。',
    '下一步（逐条执行）：',
    ...failure.healing.map((h, i) => `  ${i + 1}. ${h}`),
  ]
  if (failure.output !== undefined) lines.push(`docker 原话：\n${failure.output}`)
  return lines.join('\n')
}

/** 执行器把失败现场挂在 DpError.cause 上（ports 的 DpError 走 Error 的 cause）。传错对象会让现场整段消失 —— 而那原话是用户唯一的下一步 */
function execFailureOf(err: unknown): unknown {
  return err instanceof Error ? err.cause : undefined
}

/**
 * 四个目标都可能失败，结果里只报一个：从原因列表里挑更严重的那个。
 *
 * 逐对比较会把「有四个原因」写成嵌套的两两比较，读的人得自己数一遍才知道
 * 哪几个被比过了、哪几个没参与。折叠一次只留一个数，结论与顺序无关。
 *
 * @param causes 各目标抛出的原始错误，undefined 表示那个目标没失败
 * @returns 最严重的那个**原始错误**（不是它的结构化副本）；全都没失败时 undefined
 */
export function pickWorstError(causes: readonly unknown[]): unknown {
  const present = causes.filter((c) => c !== undefined)
  if (present.length === 0) return undefined
  // pickWorseError 返回的是入参之一，所以折叠全程都是原始错误 —— 退出码仍映射得出来
  return present.reduce((a, b) => pickWorseError(a, b))
}

/**
 * 两个原因都有时，报更严重的那个（按退出码）。`undefined` 那个先被排除。
 *
 * 严重程度只由 `exitCodeFor` 决定，不在这里另立一套排序 —— 一旦这里有自己的
 * 「哪个更严重」判断，它就会和 CI 看到的退出码对不上。
 */
function pickWorseError(a: unknown, b: unknown): { code: string; message: string; path?: string; hint?: string } {
  const fa = a === undefined ? undefined : targetErrorFields(a)
  const fb = b === undefined ? undefined : targetErrorFields(b)
  if (fa === undefined) return fb as { code: string; message: string }
  if (fb === undefined) return fa
  return exitCodeFor(a) >= exitCodeFor(b) ? fa : fb
}
