/**
 * 跨模块共享的**类型**。单独成文件是为了让 redact / format / logger
 * 能互相引用而不产生运行时循环依赖（`verbatimModuleSyntax` 下
 * `import type` 会被完全擦除，不留 require 边）。
 */
import type { LogLevel, LogSink } from '@dp/ports'

/** 输出格式。json 是唯一机器可解析的，pretty 是唯一给人看的 */
export type LogFormat = 'json' | 'pretty' | 'logfmt'

export interface RedactOptions {
  /** 额外要按 key 名脱敏的正则/字符串（小写比较）。字符串按"包含"处理，RegExp 取其 source */
  readonly extraKeyPatterns?: readonly (string | RegExp)[]
  /** 额外的值模式。会自动补上 g 标志 */
  readonly extraValuePatterns?: readonly RegExp[]
  /** 替换文本，默认 '***' */
  readonly replacement?: string
  /** 单条字符串超过此长度就截断，默认 2000 */
  readonly maxStringLength?: number
  /** 递归深度上限，默认 6；超过直接替换为 replacement */
  readonly maxDepth?: number
}

export interface LoggerOptions {
  /** 默认 'info' */
  readonly level?: LogLevel
  /** 默认 'json' */
  readonly format?: LogFormat
  /** 默认写到 stdout */
  readonly sink?: LogSink
  /** 默认 () => new Date()；测试注入固定值即可让输出完全确定 */
  readonly clock?: () => Date
  readonly deployId?: string
  /** 全局绑定字段，对所有派生 logger 生效 */
  readonly bind?: Readonly<Record<string, unknown>>
  readonly redact?: RedactOptions
  /**
   * 输出目标。**收到的是已补好换行符的一行**（由 sink 负责行终止，
   * 否则 JSONL 的"一行一条"根本没人保证）。默认 `process.stdout.write`。
   */
  readonly out?: (line: string) => void
}
