/**
 * 脱敏 —— 出口的最后一道闸门（docs/security.md：统一在 sink 层做，禁止单点 console.log）。
 *
 * 两条识别路径（decisions.md §7）：
 *   1. **key 名**：对 key 小写化后做**包含**匹配；命中即整值替换。
 *      例外是 `key` —— 它必须按**单词边界**匹配，否则 `keyboard`/`monkey` 会被误伤。
 *   2. **值模式**：字符串里的凭据指纹（PEM 私钥 / Bearer / JWT / ssh 公钥 / 各家 token）。
 *      命中即把**匹配到的片段**替换掉，保留周边上下文（`auth failed: Bearer ***` 仍可读）。
 *
 * 铁律 1：这里**绝不允许抛异常**。调用方是部署主流程，日志是次要需求。
 * 任何拿不准的值都降级成字符串，不让它有机会炸掉部署。
 */
import type { RedactOptions } from './options.js'

export const DEFAULT_REPLACEMENT = '***'
export const DEFAULT_MAX_STRING_LENGTH = 2000
export const DEFAULT_MAX_DEPTH = 6
/** 数组上限。超出只留头部，避免一条日志灌进 10 万个元素 */
export const MAX_ARRAY_ITEMS = 100

/** 单个字符串的兜底描述（无法安全求值时） */
const UNSERIALIZABLE = '[Unserializable]'
const CIRCULAR = '[Circular]'
const FUNCTION = '[Function]'

// ------------------------------------------------------------
// key 名匹配
// ------------------------------------------------------------

/** 包含匹配（小写化后）。`key` 不在这里 —— 它走单词边界 */
export const DEFAULT_KEY_SUBSTRINGS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
  'credential',
  'authorization',
  'cookie',
  'session',
  'passphrase',
  'pem',
]

/**
 * 按**词段**整段匹配：先把 key 切成词段（camelCase 边界 + 非字母数字），再整段比对。
 *
 * 为什么不用 `\b`：`authToken` 里 `auth` 后面紧跟字母，边界不成立 → 漏脱；
 * 而 `auth` 若走**包含**匹配，`author` / `authority` 会被误伤。词段匹配两头都对。
 *
 * 命中示例：`key` `apiKey` `private_key` `auth` `authToken` `auth_token`
 * 不命中：`keyboard` `monkey` `keypath` `author` `authority`
 */
export const DEFAULT_KEY_WORDS: readonly string[] = ['key', 'auth']

/** `authToken` → ['auth','token']；`private_key` → ['private','key'] */
export function keySegments(key: string): readonly string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((s) => s.length > 0)
}

// ------------------------------------------------------------
// 值模式匹配
// ------------------------------------------------------------

/**
 * 值模式。全部带 `g` —— 一条消息里可能同时有 token 和 AWS key。
 *
 * PEM 私钥给了两条：完整块（头到尾整段换掉）和只剩头部的残片
 * （只换头部，正文剩着等于没脱敏）。**证书不在此列** —— 证书是公开信息，
 * 脱掉它只会让排障时看不出 TLS 问题。
 */
export const DEFAULT_VALUE_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /Bearer\s+\S+/g,
  /ssh-(?:rsa|ed25519) AAAA[0-9A-Za-z+/=]+/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
]

// ------------------------------------------------------------
// 编译选项
// ------------------------------------------------------------

export interface Compiled {
  readonly keySubstrings: readonly string[]
  readonly keyWords: readonly string[]
  readonly extraKeyRes: readonly RegExp[]
  readonly valuePatterns: readonly RegExp[]
  readonly replacement: string
  readonly maxStringLength: number
  readonly maxDepth: number
}

/**
 * 把用户给的 pattern 编译成每次 redact 都能直接复用的形态。
 *
 * 调用方可以传字符串（当作 key 子串）或 RegExp（当 key 子串用其 source）。
 * 用户 RegExp 的 `lastIndex` 会被**归零** —— 带 `g` 的 RegExp 是有状态的，
 * 复用同一个实例会隔次漏匹配（经典坑）。
 */
export function compileRedact(options: RedactOptions = {}): Compiled {
  // 字符串按"包含"处理；RegExp 按**正则**处理（不是把 source 当字面量！
  // 那样 /CARD$/ 会变成去找字符串 "CARD$"，永远不命中 —— 静默失效最坑）
  const extraStrings: string[] = []
  const extraRes: RegExp[] = []
  for (const p of options.extraKeyPatterns ?? []) {
    if (p instanceof RegExp) {
      const flags = p.flags.includes('g') || p.flags.includes('y') ? p.flags.replace(/[gy]/g, '') : p.flags
      extraRes.push(new RegExp(p.source, flags.includes('i') ? flags : `${flags}i`))
    } else {
      extraStrings.push(p.toLowerCase())
    }
  }
  const keyWords = [...DEFAULT_KEY_WORDS]
  const extraValues = [...DEFAULT_VALUE_PATTERNS, ...(options.extraValuePatterns ?? [])]
  return {
    keySubstrings: [...DEFAULT_KEY_SUBSTRINGS, ...extraStrings],
    keyWords,
    extraKeyRes: extraRes,
    valuePatterns: extraValues.map((p) => {
      p.lastIndex = 0
      return p.global ? p : new RegExp(p.source, `${p.flags}g`)
    }),
    replacement: options.replacement ?? DEFAULT_REPLACEMENT,
    maxStringLength: options.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  }
}

/** key 名是否命中（已小写化） */
export function isSecretKey(key: string, c: Compiled): boolean {
  const k = key.toLowerCase()
  for (const sub of c.keySubstrings) if (k.includes(sub)) return true
  // 词段匹配：整段相等才算命中，避免 `auth` 误伤 `author`
  for (const seg of keySegments(key)) {
    if (c.keyWords.includes(seg)) return true
    for (const sub of c.keySubstrings) if (seg.includes(sub)) return true
  }
  for (const re of c.extraKeyRes) {
    re.lastIndex = 0
    if (re.test(key)) return true
  }
  return false
}

// ------------------------------------------------------------
// 纯函数入口
// ------------------------------------------------------------

/**
 * 递归脱敏。**返回新值，不改原对象**（调用方的字段对象可能还被别处持有）。
 *
 * @param value 任意值
 * @param options 脱敏策略；不传就是默认策略
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  return redactWith(value, compileRedact(options))
}

/**
 * 复用**已编译**的策略。Logger 每条日志都调 redact，正则重编译会成为
 * 热点（默认 8+8 条正则，一条日志编两遍），所以编译一次就够。
 */
export function redactWith(value: unknown, c: Compiled): unknown {
  try {
    return walk(value, c, 0, new WeakSet<object>())
  } catch {
    // 走到这里说明 walk 内部有没料到的洞。日志绝不能因为脱敏失败而拖垮部署。
    return UNSERIALIZABLE
  }
}

// ------------------------------------------------------------
// 递归主体
// ------------------------------------------------------------

function walk(value: unknown, c: Compiled, depth: number, seen: WeakSet<object>): unknown {
  // 深度超限是**结构**问题（有人在往里塞无底洞），直接截断
  if (depth > c.maxDepth) return c.replacement

  if (value === null) return null

  switch (typeof value) {
    case 'string':
      return scrubString(value, c)
    case 'number':
      // JSON.stringify(NaN/Infinity) → "null"，信息全丢。留个字符串至少能看出是哪个
      return Number.isFinite(value) ? value : String(value)
    case 'boolean':
      return value
    case 'bigint':
      return `${value}n`
    case 'symbol':
      return String(value)
    case 'undefined':
      return 'undefined'
    case 'function':
      return FUNCTION
    default:
      return walkObject(value as object, c, depth, seen)
  }
}

function walkObject(value: object, c: Compiled, depth: number, seen: WeakSet<object>): unknown {
  if (seen.has(value)) return CIRCULAR
  seen.add(value)
  try {
    // Date 要先判：Date.prototype.toJSON 对非法日期会抛 RangeError
    if (value instanceof Date) return safeIso(value, c)

    // 二进制不进日志。Buffer 有 toJSON（会展开成 {type,data:[]}），必须先拦
    if (value instanceof Uint8Array) return `[bytes:${value.byteLength}]`

    if (Array.isArray(value)) return walkArray(value, c, depth, seen)
    if (value instanceof Map) return walkMap(value, c, depth, seen)
    if (value instanceof Set) return walkSet(value, c, depth, seen)
    if (value instanceof Error) return walkError(value, c, depth, seen)

    // 尊重 toJSON —— DpError 就靠它把 code/path/hint 摊开。
    // 但它可能自己抛（用户写的），抛了就退回"只取自有可枚举键"
    const viaToJson = tryToJson(value)
    if (viaToJson !== undefined) return walk(viaToJson, c, depth, seen)

    return walkPlain(value, c, depth, seen)
  } finally {
    // 只增不减 = "当前祖先链"，共享引用不算循环
    seen.delete(value)
  }
}

/** 纯 JSON 对象：逐 key 处理，命中敏感 key 的整值换掉 */
function walkPlain(value: object, c: Compiled, depth: number, seen: WeakSet<object>): unknown {
  const out: Record<string, unknown> = {}
  let keys: string[]
  try {
    keys = Object.keys(value)
  } catch {
    return UNSERIALIZABLE // Proxy 的 ownKeys 抛了
  }
  for (const key of keys) {
    if (isSecretKey(key, c)) {
      out[key] = c.replacement
      continue
    }
    let raw: unknown
    try {
      raw = (value as Record<string, unknown>)[key]
    } catch {
      out[key] = UNSERIALIZABLE // getter 抛了
      continue
    }
    out[key] = walk(raw, c, depth + 1, seen)
  }
  return out
}

function walkArray(value: readonly unknown[], c: Compiled, depth: number, seen: WeakSet<object>): unknown {
  const head = value.length > MAX_ARRAY_ITEMS ? value.slice(0, MAX_ARRAY_ITEMS) : value
  const out = head.map((v) => walk(v, c, depth + 1, seen))
  if (value.length > MAX_ARRAY_ITEMS) out.push(`…(${value.length - MAX_ARRAY_ITEMS} more)`)
  return out
}

/** Map → 普通对象。key 走 String()，敏感 key 的**值**被替换（与普通对象一致：key 保留，值脱敏） */
function walkMap(value: Map<unknown, unknown>, c: Compiled, depth: number, seen: WeakSet<object>): unknown {
  const out: Record<string, unknown> = {}
  try {
    for (const [k, v] of value) {
      const key = safeString(k)
      out[key] = isSecretKey(key, c) ? c.replacement : walk(v, c, depth + 1, seen)
    }
  } catch {
    return UNSERIALIZABLE
  }
  return out
}

function walkSet(value: Set<unknown>, c: Compiled, depth: number, seen: WeakSet<object>): unknown {
  const out: unknown[] = []
  try {
    let n = 0
    for (const v of value) {
      if (n >= MAX_ARRAY_ITEMS) {
        out.push(`…(${value.size - MAX_ARRAY_ITEMS} more)`)
        break
      }
      out.push(walk(v, c, depth + 1, seen))
      n++
    }
  } catch {
    return UNSERIALIZABLE
  }
  return out
}

/**
 * Error → { name, message, stack }。
 * stack 保留是因为排障时它最有用，但**必须一起过脱敏** ——
 * 栈里可能带 `Authorization: Bearer xxx` 这样的参数痕迹。
 */
function walkError(value: Error, c: Compiled, depth: number, seen: WeakSet<object>): unknown {
  const out: Record<string, unknown> = {
    name: scrubString(safeString(value.name), c),
    message: scrubString(safeString(value.message), c),
  }
  if (typeof value.stack === 'string') out.stack = scrubString(value.stack, c)
  for (const key of ['code', 'path', 'hint', 'cause']) {
    const v = (value as unknown as Record<string, unknown>)[key]
    if (v !== undefined) out[key] = isSecretKey(key, c) ? c.replacement : walk(v, c, depth + 1, seen)
  }
  return out
}

// ------------------------------------------------------------
// 叶子工具
// ------------------------------------------------------------

/** 值模式替换 + 超长截断。顺序固定：先脱敏再截断，避免被切掉的半截凭据漏出去 */
function scrubString(value: string, c: Compiled): string {
  let out = value
  for (const re of c.valuePatterns) {
    re.lastIndex = 0
    out = out.replace(re, c.replacement)
  }
  return out.length > c.maxStringLength ? `${out.slice(0, c.maxStringLength)}…(truncated)` : out
}

function safeIso(date: Date, c: Compiled): string {
  try {
    return scrubString(date.toISOString(), c)
  } catch {
    return scrubString(String(date), c)
  }
}

function safeString(v: unknown): string {
  try {
    return String(v)
  } catch {
    return UNSERIALIZABLE
  }
}

/** 调 toJSON；不存在或抛了就返回 undefined 交给调用方兜底 */
function tryToJson(value: object): unknown {
  const fn = (value as { toJSON?: unknown }).toJSON
  if (typeof fn !== 'function') return undefined
  try {
    return (fn as () => unknown).call(value)
  } catch {
    return undefined
  }
}
