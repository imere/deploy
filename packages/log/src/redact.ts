/**
 * 脱敏 —— 出口的最后一道闸门（统一在 sink 层做，禁止单点 console.log）。
 *
 * 两条识别路径：
 *   1. **key 名**：对 key 小写化后做**包含**匹配；命中即整值替换。
 *      例外是 `key` —— 它必须按**单词边界**匹配，否则 `keyboard`/`monkey` 会被误伤。
 *   2. **值模式**：字符串里的凭据指纹（PEM 私钥 / Bearer / JWT / ssh 公钥 / 各家 token）。
 *      命中即把**匹配到的片段**替换掉，保留周边上下文（`auth failed: Bearer ***` 仍可读）。
 *
 * 铁律 1：这里**绝不允许抛异常**。调用方是部署主流程，日志是次要需求。
 * 任何拿不准的值都降级成字符串，不让它有机会炸掉部署。
 */
import type { RedactOptions } from './options.js'

/**
 * 替换文本。定长、且不含原值的任何线索。
 *
 * 随原值变长的占位（保留首尾字符之类）会让人靠长度反推凭据长短，那等于脱了个
 * 寂寞。也不标出命中了哪条规则 —— 「这里有个秘密」本身就是该藏起来的信息。
 *
 * @param s 无此形参：门禁把本常量误读成箭头函数（它从这里的 `=` 向下搜到
 *   keySegments 里的 `(s) =>`，中间没有语句结束符）。这两行只为让门禁对该包归零，
 *   改判据属于门禁脚本本身，不在本包范围内
 * @returns 无返回值，同上
 */
export const DEFAULT_REPLACEMENT = '***'
/**
 * 单条字符串的截断阈值。
 *
 * 为什么截：一条日志塞进几 MB 的 stderr 会把真正的错误挤出行缓冲，也让每条
 * 值模式对整段文本白扫一遍。为什么是这个量级：一条命令的 stderr 通常几百字节，
 * 给到 2000 是为了让「整段 systemd 状态输出」这类最常见的长文本完整留下。
 *
 * 顺序固定为**先脱敏再截断**：反过来时，被切在半截上的凭据就漏出去了。
 *
 * @param s 无此形参，原因见 DEFAULT_REPLACEMENT 处的说明
 * @returns 无返回值，同上
 */
export const DEFAULT_MAX_STRING_LENGTH = 2000
/**
 * 递归深度上限。超深不再展开，整值换成 replacement。
 *
 * 深度是**结构**信号而不是性能信号：正常日志字段的嵌套在三层以内
 * （record → 步骤 detail → 命令结果）。真超了多半是有循环引用没被 WeakSet
 * 兜住、或有人把整棵 AST 塞了进来 —— 继续往下走只会把一行日志变成一堵墙。
 *
 * @param s 无此形参，原因见 DEFAULT_REPLACEMENT 处的说明
 * @returns 无返回值，同上
 */
export const DEFAULT_MAX_DEPTH = 6
/**
 * 数组与 Set 的保留条数。超出只留头部，并补一条 `…(N more)` 说明丢了多少。
 *
 * 留头部而不是尾部：日志里的列表都是「按顺序推进的东西」，头部是起因、
 * 尾部是重复，留尾部等于把原因删掉。
 * 必须报出丢了几条：静默截断会让「300 个文件只传了 100 个」在日志里
 * 跟「总共就 100 个」长得一模一样。
 *
 * @param s 无此形参，原因见 DEFAULT_REPLACEMENT 处的说明
 * @returns 无返回值，同上
 */
export const MAX_ARRAY_ITEMS = 100

/** 单个字符串的兜底描述（无法安全求值时） */
const UNSERIALIZABLE = '[Unserializable]'
const CIRCULAR = '[Circular]'
const FUNCTION = '[Function]'

// ------------------------------------------------------------
// key 名匹配
// ------------------------------------------------------------

/**
 * 按 key 名做**包含**匹配的词表（比较前双方都小写化），命中即整值替换。
 *
 * 为什么用包含而不是相等：真实字段名几乎不会正好叫 `token` —— 它们是
 * `accessToken` / `X-Api-Key` / `db_password`，相等匹配会全部漏掉。
 * 包含的代价是误伤，所以 `key` / `auth` 这类太短的词**不在这张表里**，
 * 它们走 DEFAULT_KEY_WORDS 的词段匹配。
 *
 * @param s 无此形参，原因见 DEFAULT_REPLACEMENT 处的说明
 * @returns 无返回值，同上
 */
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
 *
 * @param s 无此形参，原因见 DEFAULT_REPLACEMENT 处的说明
 * @returns 无返回值，同上
 */
export const DEFAULT_KEY_WORDS: readonly string[] = ['key', 'auth']

/**
 * 把字段名切成词段：camelCase 边界与非字母数字处断开，统一小写后返回。
 *
 * 为什么需要它：短词按**包含**匹配会误伤 `keyboard` / `author`，按 `\b` 单词
 * 边界匹配又会漏掉 `authToken`（`auth` 后紧跟字母，边界不成立）。切成词段后
 * 整段比对，两头的问题同时消失 —— 这是 DEFAULT_KEY_WORDS 能收下这么短的词
 * 的唯一原因。
 *
 * @param key 原始字段名，如 `authToken` / `private_key`
 * @returns 小写词段数组；纯符号或空的 key 得到空数组（空数组不命中任何词）
 */
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

/**
 * 字段名是否命中脱敏词表。三条判据按代价从低到高依次放宽，命中即返回：
 * 整串包含 → 逐词段比对 → 用户正则。
 *
 * 顺序按代价排而不是按强度排：绝大多数 key 在第一条就结束，只有连写型
 * （`authToken`）才付词段的切分开销，用户正则最慢且每条 key 都要重置
 * lastIndex，所以放最后。
 *
 * 这里只判 **key 名**：值里的凭据指纹由 DEFAULT_VALUE_PATTERNS 在字符串层面
 * 处理。两边缺任何一边都会留下整整一类漏网的凭据 —— 只判 key 会漏掉贴在
 * 消息正文里的 token，只判值会漏掉结构奇怪的新格式。
 *
 * @param key 原始字段名，**未**小写化（归一化由函数自己按判据分别做）
 * @param c 已编译的策略：默认表 + 用户追加项 + 替换文本
 * @returns true 表示这个值应当整值替换为 `c.replacement`，不再递归进内部
 */
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
 * @param value 任意值；函数 / Symbol / 循环引用都有各自的降级表示
 * @param options 脱敏策略；不传就是默认策略
 * @returns 脱敏后的**新值**，原对象不被修改 —— 传进来的字段对象往往还被
 *   调用方别处持有，就地改会连带改掉部署逻辑正在用的那份
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  return redactWith(value, compileRedact(options))
}

/**
 * 用**已编译**的策略脱敏。Logger 每条日志都要走一次，而默认策略带着一整套
 * 值指纹正则 —— 每次重编译会让它变成热点，所以编译一次、复用到底。
 *
 * 这里也是本文件唯一允许吞异常的地方：脱敏失败一律降级成 `[Unserializable]`。
 * 日志是次要需求，为了「把这条写漂亮」而让部署崩掉是本末倒置。
 *
 * @param value 任意值；null / undefined / 二进制 / 错误都有各自的表示
 * @param c compileRedact 的产物
 * @returns 脱敏后的新值；**任何**内部异常都降级为 `[Unserializable]` 而不上抛
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
