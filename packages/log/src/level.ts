/**
 * 级别：序数 + 过滤。
 *
 * 单独成文件是因为 CLI（`--log-level`）和测试都要用同一份真值表，
 * 复制一份 rank 就会出现"两处定义漂移"的经典 bug。
 */
import type { LogLevel } from '@dp/ports'

/** 由低到高。数组顺序即语义顺序，不要随手重排 */
export const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error']

const RANK: Readonly<Record<LogLevel, number>> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
}

/**
 * 缺省级别定在 `info`。
 *
 * 为什么不是 debug：默认开 debug 会把 rsync / ssh 的逐文件输出灌进终端，
 * 真正的进度行被冲走 —— 排障的人第一眼看到的全是噪音。
 * 为什么不是 warn：warn 之上看不到「正在做什么」，一次失败的部署就只剩一条
 * 结论而没有过程，连卡在哪一步都判断不出来。info 是同时给出进度与结论的那一档。
 */
export const DEFAULT_LEVEL: LogLevel = 'info'

/**
 * 级别 → 序数，供比较用。
 *
 * 未知级别给 0（比最低的 trace 还低）而不是抛错或给中间值：本包会被纯 JS
 * 调用方喂进任意字符串，在这里抛错等于让「记一行日志」变成一次部署中断。
 * 给 0 的后果只是这条日志不输出 —— 少一行日志永远比挂掉一次部署划算。
 *
 * @param level 级别名；不在 LOG_LEVELS 里的一律按最低处理
 * @returns 序数，越大越严重；未知级别为 0
 */
export function levelRank(level: LogLevel): number {
  return RANK[level] ?? 0
}

/**
 * 这一条该不该输出。阈值**等于自身时要输出**（info 阈值下 info 照出）。
 *
 * 把 `>=` 写成 `>` 的后果只在一个级别上显现：`--log-level info` 恰好过滤掉
 * info 本身，用户看到的是「我明明开了 info 却什么都没有」，而这个 bug 在
 * error / debug 上完全看不出来 —— 所以它必须在这里写死，不能靠调用方自觉。
 *
 * @param level 待写这一条的级别
 * @param threshold 当前生效的阈值（CLI 的 --log-level 或 LoggerOptions.level）
 * @returns true 表示应当写这一条；未知级别恒为 false
 */
export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return levelRank(level) >= levelRank(threshold)
}
