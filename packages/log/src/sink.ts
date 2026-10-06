/**
 * sink —— 日志的出口。
 *
 * **唯一允许碰 IO 的地方**（file sink 碰 node:fs）。理由不是洁癖：
 * 脱敏必须发生在出口，所以"谁在写"和"写什么"要能分开替换。
 *
 * 所有 sink 的 write **都只保证尽力而为**：写失败不抛，落到 stderr 兜底。
 */
import { appendFile } from 'node:fs/promises'
import type { LogRecord, LogSink } from '@dp/ports'

/** 兜底告警。铁律 3：只有走这里的日志可以绕过 sink 直接写 stderr */
export function warnStderr(text: string): void {
  try {
    process.stderr.write(`[dp/log] ${text}\n`)
  } catch {
    // stderr 本身都写不掉了（EPIPE / 管道已关）。到此为止，不再制造新错误。
  }
}

/** 取错误信息的短描述。**绝不用模板串直接插值 unknown** —— 它的 toString 可能又抛 */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`
  if (typeof err === 'string') return err
  try {
    return String(err)
  } catch {
    return '<unprintable>'
  }
}

/**
 * 把一行交给调用方。
 *
 * 行终止由 sink 负责：`out` 收到的是**已带 `\n` 的一行**。
 * 反过来做的话，"JSONL 一行一条"就变成了每个调用方的自觉，迟早有人忘。
 *
 * `out` 抛错会被吞掉并落到 stderr，**绝不上抛**：出口写不出去不是让部署停下来的
 * 理由，而一条日志引发的异常栈会把真正的部署错误顶出视线和日志之外。
 *
 * @param out 接收**已补好换行符**的一行，不做二次加工
 * @returns 一个尽力而为的 sink
 */
export function createLineSink(out: (line: string) => void): LogSink {
  return {
    write(line) {
      try {
        out(`${line}\n`)
      } catch (err) {
        warnStderr(`sink.write 失败：${describeError(err)}`)
      }
    },
  }
}

/**
 * 内存 sink，供测试与「事后检查到底写了什么」的场景使用。
 *
 * 同时留 `lines`（给人看的文本）与 `records`（结构化字段）是刻意的：只留文本
 * 的话，想断言「deployId 有没有带上」就得去解析字符串 —— 那是把已经结构化
 * 的东西反向解析一遍，而解析本身又会变成新的失败点。
 */
export interface MemorySink extends LogSink {
  /** 已写入的单行文本（不含换行符） */
  readonly lines: readonly string[]
  /** 传给 write 的 record（调用方传进来的原对象） */
  readonly records: readonly LogRecord[]
  clear(): void
}

/**
 * 内存 sink。测试与需要事后检查"到底写了什么"的地方用
 *
 * @returns 一个 MemorySink。两个数组是**同一个实例上的可变数组**，`clear()`
 *   就地清空而不换新数组 —— 外部先取到的引用（测试里先存一份 `sink.lines`）
 *   在清空之后依然指向当前内容
 */
export function createMemorySink(): MemorySink {
  const lines: string[] = []
  const records: LogRecord[] = []
  return {
    lines,
    records,
    write(line, record) {
      lines.push(line)
      records.push(record)
    },
    clear() {
      lines.length = 0
      records.length = 0
    },
  }
}

/**
 * 文件 sink。**这里是全仓唯一允许 import node:fs 的地方。**
 *
 * 写是 fire-and-forget（部署不能被磁盘 IO 卡住），但把 promise 串在一条链上，
 * `flush()` 就能等它排空 —— 否则进程退出时最后几行会丢。
 * 失败直接吞掉：日志写不进去不是部署失败的理由。
 *
 * @param path 追加写入的文件路径。**不代建父目录**：目录不存在时 appendFile
 *   直接失败并被吞成一条 stderr 告警，结果是「日志文件静静地一行都没有」——
 *   所以调用方要在建 logger 之前自己确认这个目录存在
 * @returns fire-and-forget 的 sink；`flush()` 可等它排空
 */
export function createFileSink(path: string): LogSink {
  let pending: Promise<void> = Promise.resolve()

  return {
    write(line) {
      pending = pending
        .then(() => appendFile(path, `${line}\n`, 'utf8'))
        .catch((err: unknown) => {
          warnStderr(`写 ${path} 失败：${describeError(err)}`)
        })
    },
    async flush() {
      await pending
    },
  }
}

/**
 * stdout sink —— 默认出口。
 *
 * 走 createLineSink 而不是直接 `process.stdout.write`：换行必须由 sink 补，
 * 否则「一行一条」就成了每个调用方的自觉。
 *
 * @returns 写到 stdout 的 sink；行终止由 createLineSink 负责
 */
export function createStdoutSink(): LogSink {
  return createLineSink((s) => {
    process.stdout.write(s)
  })
}
