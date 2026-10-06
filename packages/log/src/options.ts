/**
 * 跨模块共享的**类型**。单独成文件是为了让 redact / format / logger
 * 能互相引用而不产生运行时循环依赖（`verbatimModuleSyntax` 下
 * `import type` 会被完全擦除，不留 require 边）。
 */
import type { LogLevel, LogSink } from '@dp/ports'

/** 输出格式。json 是唯一机器可解析的，pretty 是唯一给人看的 */
export type LogFormat = 'json' | 'pretty' | 'logfmt'

/**
 * 脱敏策略。**每一项都是「追加」语义**：用户给的 pattern 加在默认表之上，
 * 不是替换默认表。
 *
 * 不可替换是这条设计的全部价值所在 —— 可替换的话，一次漏配就是一次凭据落盘，
 * 而且没有任何人会发现（日志看起来一切正常）。默认表永远在场，用户只能加宽。
 *
 * 单独成类型而不是让 `redact()` 收一串位置参数：策略要在建 logger 时编译一次、
 * 之后每条日志复用，散成参数就意味着每条日志都要重新解释一遍正则。
 */
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

/**
 * 建 logger 的选项。全部可选，缺省即一套「开箱能跑」的默认（级别 info / 格式 json / 出口 stdout）。
 *
 * `clock` 与 `sink` 可注入不是为了灵活，是为了**可断言**：注入假 clock 之后
 * `ts` 与 `durationMs` 都是定值，输出能做逐字符快照；换掉 sink 就能在不碰
 * stdout、不碰磁盘的前提下断言「到底写了什么」。读真时钟、写真 stdout 的测试
 * 只能断言到 `>= 0` 这种没有信息量的东西。
 */
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
  /** 绑定字段之外再加宽脱敏；默认表**永远在场**，这里只能加、不能减 */
  readonly redact?: RedactOptions
  /**
   * 输出目标。**收到的是已补好换行符的一行**（由 sink 负责行终止，
   * 否则 JSONL 的"一行一条"根本没人保证）。默认 `process.stdout.write`。
   */
  readonly out?: (line: string) => void
}
