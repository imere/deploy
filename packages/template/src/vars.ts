import { ERR, DpError } from '@dp/ports'
import type { RenderContext } from './context.js'

/**
 * 一个变量引用。**保留原文**而不只留变量名：报错与 `--dry-run` 展示要的是用户写下的那段（`${env.FOO}`），只给 `env.FOO` 会让人对着错误消息猜自己写在哪个位置。
 */
export interface VarRef {
  /** 原文，含 `${}`，用于报错定位与 --dry-run 展示 */
  readonly raw: string
  /** 变量名，如 'env.FOO' / 'git.sha'；嵌套写法会带上内部的 `${}` */
  readonly name: string
  /** true 表示 `$${...}`，渲染阶段跳过（但仍被扫描到，好让 --dry-run 说清"这里有个转义"） */
  readonly escaped: boolean
}

/** 扫描出的一个片段。扫描器不解析变量的值，只切分与分类。 */
export type Segment =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'var'; readonly ref: VarRef }

/**
 * 扫描结果。语法错误**不挂在变量上**而是单列一串：未闭合的引用根本没有「变量名」可挂，而把它混进 vars 会让调用方以为「有 var 记录就说明这一处语法是好的」。
 */
export interface ScanResult {
  readonly segments: readonly Segment[]
  /** 扫描阶段的语法错误（如未闭合）。渲染前就会命中，所以不是逐变量挂到 var 上 */
  readonly syntaxErrors: readonly DpError[]
  readonly vars: readonly VarRef[]
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

/** 未闭合时用来描述"大概在哪儿"的可读片段：取未闭合点前后各若干字符 */
function contextAt(input: string, index: number): string {
  const from = Math.max(0, index - 12)
  const to = Math.min(input.length, index + 12)
  const head = input.slice(from, index)
  const tail = input.slice(index, to)
  return `${from > 0 ? '…' : ''}${head}⟦${tail}${to < input.length ? '…' : ''}`
}

/**
 * 切分 `input`。
 *
 * @param input 待切分的原文
 * @returns 片段序列、语法错误串、以及按出现顺序排列的变量列表（含转义的那些）
 */
export function scan(input: string): ScanResult {
  const segments: Segment[] = []
  const syntaxErrors: DpError[] = []
  const vars: VarRef[] = []

  let text = ''
  const flush = (): void => {
    if (text !== '') {
      segments.push({ kind: 'text', value: text })
      text = ''
    }
  }

  for (let i = 0; i < input.length; ) {
    const ch = input[i]!

    // `$` 后不是 `{` → 原样保留。这条覆盖了 nginx 的 $host、shell 的 $1 等
    if (ch !== '$') {
      text += ch
      i += 1
      continue
    }

    const next = input[i + 1]

    // `$$` → `$`（含 `$${` 的转义前缀），一对一起吃掉
    if (next === '$') {
      const afterPair = input[i + 2]
      if (afterPair === '{') {
        // `$${...}` —— 转义的变量引用，扫到结束括号后既不渲染也不报错
        const close = input.indexOf('}', i + 3)
        if (close === -1) {
          // 转义的内容不校验：用户要的就是字面量，没闭合就当普通文本。
          text += '$'
          i += 2
          continue
        }
        const name = input.slice(i + 3, close)
        const ref: VarRef = { raw: input.slice(i, close + 1), name, escaped: true }
        flush()
        segments.push({ kind: 'var', ref })
        vars.push(ref)
        i = close + 1
        continue
      }
      text += '$'
      i += 2
      continue
    }

    if (next !== '{') {
      // `$` 单独出现：原样保留，不吃掉（nginx conf 里 `$host` 就走这里）
      text += '$'
      i += 1
      continue
    }

    const close = input.indexOf('}', i + 2)
    if (close === -1) {
      syntaxErrors.push(
        new DpError(ERR.TPL.SYNTAX, `未闭合的变量引用，位置约在：${contextAt(input, i)}`, {
          hint: '补上结尾的 `}`。若这一段本该是字面量（例如 nginx 自己的 ${...}），写成 $${...} 转义',
        }),
      )
      // 剩下的内容已经无法判定归属，当字面量留着 —— 报错已经足够定位，不必二次拒绝
      text += input.slice(i)
      flush()
      return { segments, syntaxErrors, vars }
    }

    const name = input.slice(i + 2, close)
    const raw = input.slice(i, close + 1)

    // 嵌套：`${env.${x}}` 的第一个 `}` 会把 name 切成 `env.${x`，
    if (name.includes('{') || name.includes('$') || !NAME_RE.test(name)) {
      syntaxErrors.push(
        new DpError(ERR.TPL.SYNTAX, `不支持的变量写法：${raw}`, {
          hint: name.includes('{') || name.includes('$')
            ? '本包不是表达式引擎，不支持嵌套。`${env.${x}}` 请改成先在配置里定义中间变量，或直接写死值'
            : `变量名只能是字母 / 数字 / 下划线并以点分段，如 env.FOO、git.sha、release.current（收到的是 ${raw}）`,
        }),
      )
      text += raw
      i = close + 1
      continue
    }

    const ref: VarRef = { raw, name, escaped: false }
    flush()
    segments.push({ kind: 'var', ref })
    vars.push(ref)
    i = close + 1
  }

  flush()
  return { segments, syntaxErrors, vars }
}

/**
 * 只要变量列表的薄封装：不做语义判定，所以不认识 ctx 的配置也能调。
 *
 * @param input 待扫描的原文
 * @returns 按出现顺序排列的变量引用，含转义的那些
 */
export function collectVars(input: string): readonly VarRef[] {
  return scan(input).vars
}

/** 全部内置变量名。UNKNOWN_VAR 的 hint 直接用它 —— 报错要能指导下一步 */
export const KNOWN_VARS: readonly string[] = [
  'project',
  'env',
  'now',
  'env.NAME',
  'git.sha',
  'git.branch',
  'git.tag',
  'release.id',
  'release.current',
]

function unknownVar(name: string, ctx: RenderContext, extraKeys: readonly string[]): DpError {
  const extra = extraKeys.length > 0 ? ` | ${extraKeys.join(' | ')}` : ''
  return new DpError(ERR.TPL.UNKNOWN_VAR, `未知变量 \${${name}}`, {
    hint: `可用变量：${KNOWN_VARS.join(' | ')}${extra}。要引用环境变量写成 \${env.NAME}，要引用环境名用 \${env}`,
  })
}

function missingValue(name: string, hint: string): DpError {
  return new DpError(ERR.TPL.MISSING_VALUE, `变量 \${${name}} 在当前上下文里没有值`, { hint })
}

/**
 * 解析单个变量的值。
 */
export function resolveVar(name: string, ctx: RenderContext, options?: { path?: string }): string {
  const path = options?.path
  // 错误对象是只读的，而 path 只有在调用方给了配置项路径时才有值；
  const fail = (err: DpError): never => {
    if (path === undefined) throw err
    throw new DpError(err.code, err.message, {
      path,
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
    })
  }

  const [head, ...rest] = name.split('.')
  const extraKeys = Object.keys(ctx.extra ?? {})

  switch (head) {
    case 'project': {
      // 段数必须严格：多写一段（`${project.name}`）不是"取个字段"，是拼错了变量名。
      if (rest.length > 0) return fail(unknownVar(name, ctx, extraKeys))
      if (ctx.project === '') return fail(missingValue('project', 'project 是必填项，检查配置里的 project 字段'))
      return ctx.project
    }
    case 'env': {
      // `${env}` 是环境名；`${env.FOO}` 是环境变量。少写一个点就是两种意思，
      if (rest.length === 0) {
        if (ctx.env === '') return fail(missingValue('env', '环境名未确定；用 `dp deploy --env prod` 显式指定'))
        return ctx.env
      }
      if (rest.length > 1) {
        return fail(
          new DpError(ERR.TPL.UNKNOWN_VAR, `未知变量 \${${name}}`, {
            hint: '环境变量名只能是一段，如 ${env.DEPLOY_KEY}',
          }),
        )
      }
      const key = rest[0]!
      const value = ctx.envVars?.[key]
      if (value === undefined || value === '') {
        return fail(
          new DpError(ERR.TPL.MISSING_ENV, `环境变量 ${key} 未提供，无法渲染 \${env.${key}}`, {
            hint: `设置环境变量 ${key}，或写成字面量。空值同样会被拒绝：路径塌成 \`/srv//\` 要到部署中途才暴露`,
          }),
        )
      }
      return value
    }
    case 'git': {
      const field = rest[0]
      if (rest.length !== 1 || field === undefined || (field !== 'sha' && field !== 'branch' && field !== 'tag')) {
        return fail(unknownVar(name, ctx, extraKeys))
      }
      const value = ctx.git?.[field]
      if (value === undefined || value === '') {
        return fail(
          field === 'tag'
            ? missingValue('git.tag', '当前构建不在任何 tag 上。版本标识用 ${git.sha} 更稳 —— tag 可以移动，sha 不会')
            : missingValue(`git.${field}`, `调用方没有提供 git.${field}；确认探测逻辑能读到（浅克隆与 CI 上常见缺失），或改用其他变量`),
        )
      }
      return value
    }
    case 'release': {
      const field = rest[0]
      if (rest.length !== 1 || (field !== 'id' && field !== 'current')) {
        return fail(unknownVar(name, ctx, extraKeys))
      }
      const value = ctx.release?.[field]
      if (value === undefined || value === '') {
        return fail(
          missingValue(
            `release.${field}`,
            field === 'current'
              ? '尚未部署过，没有 current 可指向；conf 里改用 ${release.current} 的软链或让首次部署先生成'
              : '调用方没有提供 release.id',
          ),
        )
      }
      return value
    }
    case 'now': {
      // 同上：`${now.iso}` 这种"看起来像格式化"的写法不存在，拒绝了才知道要改
      if (rest.length > 0) return fail(unknownVar(name, ctx, extraKeys))
      // 唯一允许的时钟入口：默认取真实时间，测试注入 ctx.now 拿确定性
      return (ctx.now ?? new Date()).toISOString()
    }
    default:
      break
  }

  const extraValue = ctx.extra?.[name]
  if (extraValue !== undefined) return extraValue
  return fail(unknownVar(name, ctx, extraKeys))
}

/**
 * 只校验不渲染：逐个变量找出「会出什么错」，渲染前就能拿到同一份清单。
 *
 * @param input 待校验的原文
 * @param ctx 变量来源，只读
 * @returns 全部错误的列表，顺序是先语法后按出现顺序；**转义的引用被跳过** ——
 * 用户写 `$${foo}` 的意思正是「我要这个字面量」
 */
export function validateVars(input: string, ctx: RenderContext): readonly DpError[] {
  const { syntaxErrors, vars } = scan(input)
  const errors: DpError[] = [...syntaxErrors]
  for (const ref of vars) {
    if (ref.escaped) continue
    try {
      resolveVar(ref.name, ctx)
    } catch (err) {
      if (err instanceof DpError) errors.push(err)
      else throw err
    }
  }
  return errors
}
