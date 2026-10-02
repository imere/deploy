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

export const DEFAULT_LEVEL: LogLevel = 'info'

/** 序数。未知级别（只可能来自 JS 调用方）落到最低，永远不输出 */
export function levelRank(level: LogLevel): number {
  return RANK[level] ?? 0
}

/** level >= threshold 才输出。阈值等于自身**要**输出 */
export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return levelRank(level) >= levelRank(threshold)
}
