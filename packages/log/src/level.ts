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
 */
export const DEFAULT_LEVEL: LogLevel = 'info'

/**
 * 级别 → 序数，供比较用。
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
 * @param level 待写这一条的级别
 * @param threshold 当前生效的阈值（CLI 的 --log-level 或 LoggerOptions.level）
 * @returns true 表示应当写这一条；未知级别恒为 false
 */
export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return levelRank(level) >= levelRank(threshold)
}
