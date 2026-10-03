/**
 * 渲染 —— 把扫描结果拼回字符串，并递归处理结构化配置。
 *
 * 两条设计约束：
 *  1. **只校验被替换进去的值**，不校验整份模板。模板自身的多行结构是作者写的、
 *     是被允许的；危险的是注入进来的内容。对整份输出做控制字符检查会把
 *     任何多行 conf 全部拒掉。
 *  2. **原对象不动**。配置对象在 plan 与执行之间被复用，改了就等于让第二次
 *     渲染拿到上一次的结果（`${env.FOO}` 变成字面量）—— 这类 bug 只在
 *     「同一份配置部署两次」时出现，极难复现。
 */
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
 * 未知变量 / 缺值 / 语法错一律抛错，**绝不留下 `${x}` 原文** ——
 * 留在产出物里的 `${x}` 会生成一份「语法合法、语义全错」的 conf，
 * 而它要到远端 nginx 解析时才炸，现场早就没了。
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
 * 循环引用必须能过：配置来自 YAML/JSON 时不可能成环，但 JS 侧的调用方
 * 可能把已经解析好的对象图直接传进来。让它栈溢出等于把调用方的 bug
 * 变成一个看不出原因的报告；已访问过的节点直接返回原引用，
 * 既不成环也不会重复渲染。
 *
 * 只有**普通对象**与数组会被展开，其余形状（Date / Map / RegExp / 类实例）
 * 原样返回 —— 见 walk() 里的理由。
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
  // 等于静默销毁调用方的数据 —— 那种故障要等到"配置里那个日期没了"才被发现，
  // 而现场早被后续步骤覆盖。认不出的形状原样返回：本包负责的是字符串叶子。
  const proto = Object.getPrototypeOf(obj) as object | null
  if (proto !== Object.prototype && proto !== null) return obj

  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = walk(item, ctx, options, seen)
  }
  return out
}

/**
 * release 相关变量的便利构造。
 *
 * `release.current` 指向 `<root>/current` 这个**软链**，不是 `<root>/releases/<id>`。
 * 原因：conf 里写死具体版本目录的话，每次部署都得改写 conf 再 reload，
 * 而「改文件 + reload」之间存在一个窗口，窗口内服务读到的配置是新的、
 * 加载的还是旧的，行为不可预测。写软链则每次换版只要一次 rename ——
 * rename 在同一文件系统内是原子的，nginx 根本不需要感知版本切换。
 * 原子发布这个前提一旦破坏，整套 trial→promote 的意义就没了。
 *
 * 路径拼接一律用 `/` 而**不用 `path.join`**：这些值会被写进远端的 conf，
 * `path.join` 在 Windows 上产出反斜杠（`C:\srv\web\current`），
 * 落到 Linux 上既是错的路径、也是 conf 语法里的一处转义陷阱。
 */
export function releaseVars(ctx: TargetContext): { 'release.id': string; 'release.current': string } {
  const root = ctx.root.replace(/\/+$/, '')
  return {
    'release.id': ctx.releaseId,
    'release.current': `${root}/${CURRENT_LINK_NAME}`,
  }
}
