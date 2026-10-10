import { CURRENT_LINK_NAME, DpError, type TargetContext } from '@dp/ports'
import { assertSafe } from './unsafe.js'
import { resolveVar, scan } from './vars.js'
import type { RenderContext, RenderOptions } from './context.js'

/** DpError 字段只读，补路径只能重建一个同码错误 */
function withPath(source: DpError, path: string): DpError {
  return new DpError(source.code, source.message, {
    path,
    ...(source.hint !== undefined ? { hint: source.hint } : {}),
  })
}

/**
 * 渲染单个字符串。
 *
 * @param input 模板原文。`$host` / `$1` 原样保留，`$${x}` 输出字面量 `${x}`
 * @param ctx 变量来源。**只读**：本包零 IO，环境变量与 git 状态全靠调用方注入
 * @param options usage 决定危险字符的严格程度，path 只用于错误消息定位
 * @returns 渲染后的字符串；转义的引用输出为字面量，不报错
 * @throws DpError `DP.TPL.SYNTAX` / `UNKNOWN_VAR` / `MISSING_*` / `UNSAFE_VALUE`
 */
export function renderString(input: string, ctx: RenderContext, options?: RenderOptions): string {
  const { segments, syntaxErrors } = scan(input)
  if (syntaxErrors.length > 0) {
    const first = syntaxErrors[0]!
    throw options?.path === undefined ? first : withPath(first, options.path)
  }

  const usage = options?.usage ?? 'text'
  let out = ''
  for (const segment of segments) {
    if (segment.kind === 'text') {
      out += segment.value
      continue
    }
    const { ref } = segment
    if (ref.escaped) {
      // `$${x}` → `${x}`：去掉转义用的那个 `$`，其余原样
      out += ref.raw.slice(1)
      continue
    }
    const value = resolveVar(ref.name, ctx, options?.path !== undefined ? { path: options.path } : undefined)
    assertSafe(value, usage, options?.path)
    out += value
  }
  return out
}

/**
 * 递归渲染结构化配置：只处理字符串叶子，返回**新**对象。
 *
 * @param value 任意结构。字符串叶子被渲染，其余形状原样保留
 * @param ctx 变量来源，只读
 * @param options 透传给每一个字符串叶子
 * @returns 同构的新对象；Date / Map / 类实例等非普通对象原样返回（不展开）
 * @throws DpError 与 renderString 相同，在第一个出错的叶子上抛出
 */
export function renderDeep<T>(value: T, ctx: RenderContext, options?: RenderOptions): T {
  return walk(value, ctx, options, new WeakSet()) as T
}

function walk(value: unknown, ctx: RenderContext, options: RenderOptions | undefined, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return renderString(value, ctx, options)
  if (value === null || typeof value !== 'object') return value

  const obj = value as object
  if (seen.has(obj)) return obj
  seen.add(obj)

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, ctx, options, seen))
  }

  // 只展开**普通对象**。Date / Map / RegExp / 类实例经 Object.entries 摊出来是 {}，
  const proto = Object.getPrototypeOf(obj) as object | null
  if (proto !== Object.prototype && proto !== null) return obj

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = walk(item, ctx, options, seen)
  }
  return out
}

/**
 * 把发布根与版本号展开成模板可用的变量表
 *
 * @param ctx 目标上下文，root 末尾的斜杠会被去掉（避免拼出 `//current`）
 * @returns `release.id` 为本次版本号，`release.current` 为 current 软链的绝对路径
 */
export function releaseVars(ctx: TargetContext): { 'release.id': string; 'release.current': string } {
  const root = ctx.root.replace(/\/+$/, '')
  return {
    'release.id': ctx.releaseId,
    'release.current': `${root}/${CURRENT_LINK_NAME}`,
  }
}
