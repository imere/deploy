/**
 * 三种输出格式 —— 全部是**纯函数**，输入 record 输出单行字符串。
 *
 * 纯函数是硬要求：黄金快照测试、将来的 OTel 桥接（@dp/log-otel）、
 * 以及"离线渲染一条历史日志"全都依赖它没有隐藏状态。
 */
import type { LogRecord } from '@dp/ports'
import type { LogFormat } from './options.js'

/**
 * 固定字段，**顺序即输出顺序**（decisions.md §7）。
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

/** `ts=... level=info msg=transfer.begin host=web-01 bytes=1048576` */
export function formatLogfmt(record: LogRecord): string {
  return formatPairs(orderedEntries(record))
}

// ------------------------------------------------------------
// pretty
// ------------------------------------------------------------

/**
 * pretty 的最终格式（decisions.md §7 未定死，这里定版）：
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

export const LOG_FORMATS: readonly LogFormat[] = ['json', 'pretty', 'logfmt']
