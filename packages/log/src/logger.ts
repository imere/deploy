/**
 * Logger 装配 —— 把 level / redact / format / sink 串成一条写日志的路。
 *
 * 铁律 1 在这里是**结构性**保证而不是靠 try/catch 补救：
 * 1. 级别不够 → 直接 return，连 record 都不组装（省掉脱敏与格式化的开销）
 * 2. 脱敏 → 格式化 → sink.write，三步各自都有兜底
 * 3. `sink.write` 拿到的**一定是脱敏后**的 record（脱敏属于出口职责）
 */
import type { LogLevel, LogRecord, Logger as LoggerPort, LogSink } from '@dp/ports'
import { formatRecord } from './format.js'
import { DEFAULT_LEVEL, isLevelEnabled } from './level.js'
import type { LoggerOptions, LogFormat, RedactOptions } from './options.js'
import { compileRedact, redactWith } from './redact.js'
import { createLineSink, describeError, warnStderr } from './sink.js'

/** 固定字段：先按它们拼出基础 record，再用调用方的 bind / fields 覆盖 */
const FIXED_SEED: readonly string[] = [
  'deployId',
  'host',
  'phase',
  'span',
  'attempt',
]

/** 结束计时的回调。end() 可带字段，可重复调用（第二次起忽略） */
export type EndTimer = (fields?: Readonly<Record<string, unknown>>) => void

/**
 * 本包导出的 Logger。
 *
 * 与 `@dp/ports` 的 `Logger` 形状一致，只把 `begin` 的返回值放宽了一点：
 * ports 写的是 `() => void`（满足最小契约），而实际实现允许 `end({ bytes })`
 * 补字段 —— `(f?) => void` 本身就可赋给 `() => void`，所以对 ports 而言
 * 依然是合法的 `Logger`，下游按 ports 类型拿到的照样能用。
 */
export interface Logger extends Omit<LoggerPort, 'begin'> {
  begin(msg: string, fields?: Readonly<Record<string, unknown>>): EndTimer
}

class LoggerImpl implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly format: LogFormat,
    private readonly sink: LogSink,
    private readonly clock: () => Date,
    private readonly bind: Readonly<Record<string, unknown>>,
    private readonly redactOptions: RedactOptions,
    private readonly compiled: ReturnType<typeof compileRedact>,
  ) {}

  /**
   * 派生子 logger。**不允许改 level** —— 子 logger 之间的 level 差异
   * 会让"为什么这条没出来"变成不可排查的问题；要不同 level 就新建 logger。
   * 子字段覆盖父字段，且只影响自己。
   */
  child(bind: Readonly<Record<string, unknown>>): Logger {
    try {
      return new LoggerImpl(
        this.level,
        this.format,
        this.sink,
        this.clock,
        { ...this.bind, ...stripUndefined(bind) },
        this.redactOptions,
        this.compiled,
      )
    } catch (err) {
      warnStderr(`child() 失败：${describeError(err)}`)
      return this
    }
  }

  span(spanId: string): Logger {
    return this.child({ span: spanId })
  }

  trace(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('trace', msg, fields)
  }

  debug(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('debug', msg, fields)
  }

  info(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('info', msg, fields)
  }

  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('warn', msg, fields)
  }

  error(msg: string, fields?: Readonly<Record<string, unknown>>): void {
    this.emit('error', msg, fields)
  }

  /**
   * 计时。走注入的 clock（不是 Date.now）—— 测试要用假时钟断言 durationMs，
   * 真实时钟会让断言只能写 `>= 0` 这种没信息量的东西。
   * 重复调用 end() 只写一次：结束钩子很容易被 finally 和错误处理各调一次。
   */
  begin(msg: string, fields?: Readonly<Record<string, unknown>>): EndTimer {
    const start = clockNow(this.clock)
    let ended = false
    return (endFields?: Readonly<Record<string, unknown>>) => {
      if (ended) return
      ended = true
      try {
        const end = clockNow(this.clock)
        const durationMs = Math.floor(end.getTime() - start.getTime())
        this.emit('info', msg, { ...(fields ?? {}), ...(endFields ?? {}), durationMs })
      } catch (err) {
        warnStderr(`begin("${msg}").end() 失败：${describeError(err)}`)
      }
    }
  }

  /** 依次等 sink 刷盘。**任何一个 flush 失败都吞掉并继续** —— 日志不是部署的一部分 */
  async flush(): Promise<void> {
    try {
      await this.sink.flush?.()
    } catch (err) {
      warnStderr(`flush 失败：${describeError(err)}`)
    }
  }

  // ------------------------------------------------------------
  // 写日志的唯一路径
  // ------------------------------------------------------------

  private emit(level: LogLevel, msg: string, fields?: Readonly<Record<string, unknown>>): void {
    // 1) 级别过滤：不够就什么都不做（连 bind 合并都不做）
    if (!isLevelEnabled(level, this.level)) return

    // 2~5) 每一步都可能抛（clock 坏、字段带毒 getter、sink 炸）。
    //      整段兜住，**绝不向调用方抛** —— 部署比日志重要（铁律 1）。
    try {
      const merged = stripUndefined({ ...this.bind, ...(fields ?? {}) })
      const record: Record<string, unknown> = { ts: isoNow(this.clock), level, msg }
      for (const key of FIXED_SEED) {
        const v = merged[key]
        if (v !== undefined) record[key] = v
      }
      for (const [k, v] of Object.entries(merged)) {
        if (v === undefined) continue
        record[k] = v
      }

      // 3) 脱敏在 sink 之前 —— record 之后一直带着脱敏后的值
      const safe = redactRecord(record, this.redactOptions, this.compiled)
      // 4) 格式化
      const line = formatRecord(safe, this.format)
      // 5) 出口
      this.sink.write(line, safe)
    } catch (err) {
      warnStderr(`写日志失败：${describeError(err)}`)
    }
  }
}

function redactRecord(
  record: Record<string, unknown>,
  options: RedactOptions,
  compiled: ReturnType<typeof compileRedact>,
): LogRecord {
  void options // 策略已编译进 compiled，这里直接复用
  return redactWith(record, compiled) as LogRecord
}

function stripUndefined(
  obj: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * clock 坏了就退到 epoch 0，**但必须告警**：静默写出 1970 年的时间戳，
 * 会让人以为日志没生成，而不是 clock 被换成了坏的实现。
 */
function clockNow(clock: () => Date): Date {
  try {
    return clock()
  } catch (err) {
    warnStderr(`clock() 失败：${describeError(err)}`)
    return new Date(0)
  }
}

function isoNow(clock: () => Date): string {
  const d = clockNow(clock)
  try {
    return d.toISOString()
  } catch {
    return String(d)
  }
}

/**
 * 装配入口的选项。空扩展是刻意的：`CreateLoggerOptions` 是给调用方的**公开名字**，
 * 让它跟内部的 `LoggerOptions` 分开，以后前者要加字段不会动到后者。直接写成
 * type 别名也能编译，但那会把两个名字焊死成同一个东西 —— 分开的意义就没了。
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CreateLoggerOptions extends LoggerOptions {}

/**
 * 全包唯一的装配入口：级别、格式、出口、时钟、脱敏策略在这里一次性定下来。
 *
 * 为什么走工厂而不是把 LoggerImpl 暴露出去：编译脱敏策略、套默认 sink、补默认
 * 时钟这三件事必须发生在**任何一条日志写出之前**，散给调用方就等于允许有人绕过
 * 它们 —— 绕过一次脱敏就是一次凭据落盘，而这种漏法在日志里看不出来。
 *
 * 三个默认值的口径：级别 `info`（理由见 DEFAULT_LEVEL）、格式 `json`（唯一机器
 * 可解析的，离线分析与报告都只认它）、出口 stdout。时钟默认真时钟，要可断言的
 * 输出就注入 `clock`。
 *
 * @param options 级别 / 格式 / sink / 时钟 / 绑定字段 / 脱敏策略，全可选
 * @returns 一个 Logger。它的**所有方法都不抛**（写失败只落 stderr），所以调用方
 *   不需要为记日志准备 try/catch —— 记日志不该改变部署的控制流
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? DEFAULT_LEVEL
  const format = options.format ?? 'json'
  const sink = options.sink ?? createLineSink(options.out ?? ((s) => { process.stdout.write(s) }))
  const clock = options.clock ?? ((): Date => new Date())
  const base: Record<string, unknown> = {}
  if (options.deployId !== undefined) base.deployId = options.deployId
  for (const [k, v] of Object.entries(options.bind ?? {})) {
    if (v !== undefined) base[k] = v
  }
  const redactOptions = options.redact ?? {}
  return new LoggerImpl(
    level,
    format,
    sink,
    clock,
    base,
    redactOptions,
    compileRedact(redactOptions),
  )
}
