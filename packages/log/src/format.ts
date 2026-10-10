import type { LogRecord } from '@dp/ports'
import type { LogFormat } from './options.js'

/**
 * 固定字段，**顺序即输出顺序**。
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
 * 拆成"有序 kv 对"：固定字段按 FIXED_FIELDS 顺序（只含有值的），其余字段按插入顺序。所有三种格式共用这一份顺序，避免三处各写一遍。
 *
 * @param record 一条已脱敏的日志
 * @returns 有序的 [key, value] 列表。值为 undefined / null 的字段**整个不出现**，
 * 而不是输出 `null` —— 后者会逼下游去区分「没给」和「给了空」
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

// json

/**
 * 严格 JSONL：单行、无换行。
 *
 * @param record 一条已脱敏的日志
 * @returns 单行 JSON 文本，**不含换行符**（换行由 sink 在写出时补）
 */
export function formatJson(record: LogRecord): string {
  const obj: Record<string, unknown> = {}
  for (const [key, v] of orderedEntries(record)) obj[key] = v
  return JSON.stringify(obj)
}

// logfmt

/** 需要引号的情况：空格 / 引号 / 反斜杠 / 等号 / 换行 —— 不引就没法解析 */
const NEEDS_QUOTE = /[\s"\\=]/

function stringifyScalar(v: unknown): { text: string; structured: boolean } {
  if (v === null) return { text: 'null', structured: false }
  if (typeof v === 'string') return { text: v, structured: false }
  if (typeof v === 'number' || typeof v === 'boolean') return { text: String(v), structured: false }
  // 嵌套结构走 JSON 紧凑串。**强制加引号**（structured）：`[1,2]` 不含
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
 * @param record 一条已脱敏的日志
 * @returns 单行 logfmt 文本，形如 `ts=… level=info msg=transfer.begin host=web-01`
 */
export function formatLogfmt(record: LogRecord): string {
  return formatPairs(orderedEntries(record))
}

// pretty

/**
 * pretty 的最终格式（这里定版）：`07:00:00.000 INFO  transfer.begin  host=web-01 bytes=1048576`^ 时:分:秒.毫秒  ^ 右对齐到 5   ^ 事件名  ^ logfmt 风格字段三个决定：1. **只显示时间，不显示日期**。终端日志是"当下正在跑"的视角，跨零点的长时间部署靠 msg 里的 deployId 对齐；真要留全量信息用 json。
 */
function prettyTime(ts: string): string {
  const t = ts.indexOf('T')
  if (t < 0) return ts
  const rest = ts.slice(t + 1)
  if (rest.endsWith('Z')) return rest.slice(0, 12)
  return rest.slice(0, 12)
}

/**
 * 给人看的一行。抬头排版（只显示时间、level 补齐 5 字符、字段走 logfmt 风格）的三条决定与理由见上面 prettyTime 处的定版说明。
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

// 分发

/**
 * 按格式名分派到三个纯函数。
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
 */
export const LOG_FORMATS: readonly LogFormat[] = ['json', 'pretty', 'logfmt']
