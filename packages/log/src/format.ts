/**
 * 三种输出格式 —— 全部是**纯函数**，输入 record 输出单行字符串。
 *
 * 纯函数是硬要求：黄金快照测试、将来的 OTel 桥接（@dp/log-otel）、
 * 以及"离线渲染一条历史日志"全都依赖它没有隐藏状态。
 */
import type { LogRecord } from '@dp/ports'
import type { LogFormat } from './options.js'

/**
 * 固定字段，**顺序即输出顺序**。
 * 机器读日志的人会按这个顺序做 grep/awk，硬编码在类型上就不容易漂移。
 */
export const FIXED_FIELDS: readonly string[] = [
  'ts',
  'level',
  'msg',
  'deployId',
  'host',
  'phase',
  'span',
  'attempt',
]

const FIXED_SET: ReadonlySet<string> = new Set(FIXED_FIELDS)

/**
 * 拆成"有序 kv 对"：固定字段按 FIXED_FIELDS 顺序（只含有值的），
 * 其余字段按插入顺序。所有三种格式共用这一份顺序，避免三处各写一遍。
 *
 * 为什么是「有序 kv 对」而不是直接拼字符串：三种格式必须共用**同一份字段顺序**，
 * 各写一遍的结果是同一个 record 在 json 与 pretty 里字段次序不同 —— 那种差异
 * 肉眼看不见，但会让按列取数的脚本在换格式时静默错位。
 *
 * @param record 一条已脱敏的日志
 * @returns 有序的 [key, value] 列表。值为 undefined / null 的字段**整个不出现**，
 *   而不是输出 `null` —— 后者会逼下游去区分「没给」和「给了空」
 */
export function orderedEntries(record: LogRecord): ReadonlyArray<readonly [string, unknown]> {
  const out: Array<readonly [string, unknown]> = []
  for (const key of FIXED_FIELDS) {
    const v = record[key]
    if (v !== undefined && v !== null) out.push([key, v] as const)
  }
  for (const [key, v] of Object.entries(record)) {
    if (FIXED_SET.has(key)) continue
    if (v === undefined || v === null) continue
    out.push([key, v] as const)
  }
  return out
}

// ------------------------------------------------------------
// json
// ------------------------------------------------------------

/**
 * 严格 JSONL：单行、无换行。
 * undefined 的固定字段直接不输出（JSON.stringify 也会省掉，但顺序要我们自己保证）。
 *
 * @param record 一条已脱敏的日志
 * @returns 单行 JSON 文本，**不含换行符**（换行由 sink 在写出时补）
 */
export function formatJson(record: LogRecord): string {
  const obj: Record<string, unknown> = {}
  for (const [key, v] of orderedEntries(record)) obj[key] = v
  return JSON.stringify(obj)
}

// ------------------------------------------------------------
// logfmt
// ------------------------------------------------------------

/** 需要引号的情况：空格 / 引号 / 反斜杠 / 等号 / 换行 —— 不引就没法解析 */
const NEEDS_QUOTE = /[\s"\\=]/

function stringifyScalar(v: unknown): { text: string; structured: boolean } {
  if (v === null) return { text: 'null', structured: false }
  if (typeof v === 'string') return { text: v, structured: false }
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v), structured: false }
  // 嵌套结构走 JSON 紧凑串。**强制加引号**（structured）：`[1,2]` 不含
  // 空格/引号/等号，按普通规则不会加引号，但 logfmt 解析器对裸方括号
  // 是"字符串还是数组"各执一词 —— 强制加引号才能保证解析无歧义。
  try {
    const s = JSON.stringify(v)
    return { text: s === undefined ? String(v) : s, structured: true }
  } catch {
    return { text: String(v), structured: true }
  }
}

function quoteValue(raw: string, force = false): string {
  if (!force && !NEEDS_QUOTE.test(raw)) return raw
  return `"${raw.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

function formatPairs(entries: ReadonlyArray<readonly [string, unknown]>): string {
  return entries
    .map(([k, v]) => {
      const s = stringifyScalar(v)
      return `${k}=${quoteValue(s.text, s.structured)}`
    })
    .join(' ')
}

/**
 * logfmt：`k=v` 空格分隔，一行一条。
 *
 * 为什么在 json 与 pretty 之外还要它：json 给机器、pretty 给终端，而 logfmt 是
 * 唯一**既经得起 grep / awk 按列取用、又不用引号转义糊满屏幕**的形态 ——
 * 贴进 issue 或聊天窗口时它不会被二次破坏。嵌套结构一律转 JSON 紧凑串并
 * **强制**加引号（理由见 stringifyScalar），否则 `[1,2]` 到底是字符串还是数组，
 * 各家 logfmt 解析器各执一词。
 *
 * @param record 一条已脱敏的日志
 * @returns 单行 logfmt 文本，形如 `ts=… level=info msg=transfer.begin host=web-01`
 */
export function formatLogfmt(record: LogRecord): string {
  return formatPairs(orderedEntries(record))
}

// ------------------------------------------------------------
// pretty
// ------------------------------------------------------------

/**
 * pretty 的最终格式（这里定版）：
 *
 *   `07:00:00.000 INFO  transfer.begin  host=web-01 bytes=1048576`
 *   ^ 时:分:秒.毫秒  ^ 右对齐到 5   ^ 事件名  ^ logfmt 风格字段
 *
 * 三个决定：
 *  1. **只显示时间，不显示日期**。终端日志是"当下正在跑"的视角，
 *     跨零点的长时间部署靠 msg 里的 deployId 对齐；真要留全量信息用 json。
 *  2. **level 补齐到 5 字符**（padEnd）。四种 level 长度不等，
 *     不补齐的话事件名会参差不齐，人眼扫不过来。
 *     补齐后 `INFO` 后面留一个空格 + 分隔空格 = 两个空格，这是刻意的。
 *  3. **字段用 logfmt 风格**而不是 `k=v, k=v`，因为行内对齐的逗号列表
 *     在宽度变化时会全散架。
 *
 * ISO 串取 `T` 之后、去掉尾部 `Z`、截到毫秒：`2026-10-02T07:00:00.000Z` → `07:00:00.000`。
 * 非 ISO（注入的假 clock 之类）原样返回，不做无依据的猜测。
 */
function prettyTime(ts: string): string {
  const t = ts.indexOf('T')
  if (t < 0) return ts
  const rest = ts.slice(t + 1)
  if (rest.endsWith('Z')) return rest.slice(0, 12)
  return rest.slice(0, 12)
}

/**
 * 给人看的一行。抬头排版（只显示时间、level 补齐 5 字符、字段走 logfmt 风格）
 * 的三条决定与理由见上面 prettyTime 处的定版说明。
 *
 * **ts / level / msg 不再重复出现在字段区**：抬头里已经排版过一次，再输出一遍
 * 就是「同一条信息两种写法」—— 肉眼对不齐，grep 也会一次命中两处，
 * 而两处格式还不一样（一个补齐了空格、一个没有）。
 *
 * @param record 一条已脱敏的日志
 * @returns 单行文本；没有任何附加字段时只有抬头，行尾不留多余空格
 */
export function formatPretty(record: LogRecord): string {
  const time = prettyTime(record.ts)
  const level = record.level.toUpperCase().padEnd(5)
  // ts / level / msg 三个字段已经在抬头里排版过了，绝不能在这里再出现一次
  const entries = orderedEntries(record).filter(([k]) => k !== 'ts' && k !== 'level' && k !== 'msg')
  const head = `${time} ${level} ${String(record.msg)}`
  const rest = formatPairs(entries)
  return rest.length > 0 ? `${head}  ${rest}` : head
}

// ------------------------------------------------------------
// 分发
// ------------------------------------------------------------

/**
 * 按格式名分派到三个纯函数。
 *
 * 为什么留 `default` 分支兜底到 json（TS 的类型已经能保证穷尽）：本包会被纯 JS
 * 调用方按字符串调用，`--log-format` 也可能从配置里读到一个拼错的值。
 * 兜到 json 至少还写出一行可解析的日志；抛错或返回空串则让「记日志」本身成为
 * 一个新的失败点 —— 那正是本包最该避免的事。
 *
 * @param record 一条已脱敏的日志
 * @param format 目标格式名
 * @returns 单行文本，无换行；未知格式按 json 处理
 */
export function formatRecord(record: LogRecord, format: LogFormat): string {
  switch (format) {
    case 'json':
      return formatJson(record)
    case 'logfmt':
      return formatLogfmt(record)
    case 'pretty':
      return formatPretty(record)
    default:
      return formatJson(record)
  }
}

/**
 * 可用格式清单，CLI 的 `--log-format` 校验与提示读它。
 *
 * 它与 `LogFormat` 是两份独立的字面量（谁也没从谁派生）：本数组带**顺序** ——
 * json 排第一，因为它是唯一机器可解析的、提示里该排在最前；而类型联合的顺序
 * 没有语义，硬让一方派生另一方就会把这两件事绑死。
 * 代价是两处必须一起改：漏改的表现是「类型里支持、CLI 却拒绝」，属于配置被
 * 静默挡在门外的那类错，所以看到这里就该去对一眼。
 */
export const LOG_FORMATS: readonly LogFormat[] = ['json', 'pretty', 'logfmt']
