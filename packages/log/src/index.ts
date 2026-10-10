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
