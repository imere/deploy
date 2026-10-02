/**
 * @dp/log —— 结构化日志。
 *
 * 输出 JSONL，字段对齐 OpenTelemetry 语义约定，**不依赖** OTel 包
 * （decisions.md §7）：零运行时依赖，桥接留给可选包 @dp/log-otel。
 *
 * 脱敏集中在出口：调用方只管写字段，不许自己 scrub（docs/security.md）。
 * 日志的任何失败都不得冒泡 —— 部署比日志重要。
 */
export type { LogLevel, LogRecord, LogSink } from '@dp/ports'
export type { Logger } from '@dp/ports'

export type { LoggerOptions, LogFormat, RedactOptions } from './options.js'
export {
  DEFAULT_LEVEL,
  LOG_LEVELS,
  isLevelEnabled,
  levelRank,
} from './level.js'
export {
  DEFAULT_KEY_SUBSTRINGS,
  DEFAULT_KEY_WORDS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_STRING_LENGTH,
  DEFAULT_REPLACEMENT,
  DEFAULT_VALUE_PATTERNS,
  MAX_ARRAY_ITEMS,
  isSecretKey,
  keySegments,
  redact,
  redactWith,
} from './redact.js'
export {
  FIXED_FIELDS,
  LOG_FORMATS,
  formatJson,
  formatLogfmt,
  formatPretty,
  formatRecord,
  orderedEntries,
} from './format.js'
export {
  createFileSink,
  createLineSink,
  createMemorySink,
  createStdoutSink,
  type MemorySink,
} from './sink.js'
export { createLogger, type EndTimer } from './logger.js'
