import { DpError } from '@dp/ports'

/**
 * JSON Schema 的节点类型，只覆盖**编辑器提示用得到的那一小撮**字段。
 */
export interface JsonSchemaNode {
  /**
   * 原子类型名。
   */
  type?: string | string[]
  /**
   * 对象字段 → 该字段的 schema。只描述"有哪些字段"，与 `required` 分开是因为「有这个字段」与「这个字段必填」是两件事。
   */
  properties?: Record<string, JsonSchemaNode>
  /**
   * 必填字段名。由 `obj()` 按 `isOptional` **反推**而不是手写 ——手写一份必填清单会和真正的必填判定分叉，症状是编辑器说必填、运行时却接受省略。
   */
  required?: string[]
  /** 数组元素的 schema */
  items?: JsonSchemaNode
  /**
   * 字符串枚举，进编辑器的下拉补全。由 `oneOf()` 产出，所以它同时也是错误消息里"可选值"的同一份来源。
   */
  enum?: readonly unknown[]
  /**
   * 字面量。**与 enum 是两个东西**：enum 是「从这几个里选一个」，const 是「必须是这个值」。分开的实质理由是 `oneOf` 只认字符串，而 `reload: false`（交给外部机制重载）这类非字符串字面量只能落在 const 上。
   */
  const?: unknown
  /**
   * 默认值，只供编辑器做占位提示。运行时的缺省值由 `withDefault` 自己填 ——两条路各自独立，这一项写错不会影响部署，只影响提示好不好读。
   */
  default?: unknown
  /**
   * 给用户看的说明，直接显示在编辑器的悬浮提示里。
   */
  description?: string
  /** 键不受限制时的值 schema（`record()` 产出）。`false` 表示不允许额外键 */
  additionalProperties?: boolean | JsonSchemaNode
  /** 联合：任一分支成立即可 */
  anyOf?: readonly JsonSchemaNode[]
}

/* eslint-disable @typescript-eslint/no-explicit-any -- DSL 必须擦除具体类型才能做形状推导 */

/* eslint-disable @typescript-eslint/no-unused-vars --
   TIn 不在接口体里出现是刻意的：它是给 InputOf<S> 反推「输入类型」用的幻影参数
   （parse 的输入与输出同类型时它等于 TOut，withDefault 这类才与 TOut 不同）。
   按「未使用」删掉它，InputOf 就再也推不出输入类型了。
   开关放在 JSDoc 块**外面**：插在 JSDoc 与声明之间会把 doc 块顶掉，JSDoc 门禁立刻报缺块。 */
/**
 * `IsOptional` 必须是**字面量类型**而不是 boolean —— 否则类型层面无法区分可选字段与必填字段，`withDefault` 的字段会被误判成必填。
 */
export interface Schema<TOut, TIn = TOut, IsOptional extends boolean = false> {
  readonly kind: string
  readonly isOptional: IsOptional
  /**
   * 输入可以省略该字段。opt() 与 withDefault() 都是 true —— 区别在于前者省略后**不产生**该键，后者省略后填入默认值。
   */
  readonly acceptsUndefined: boolean
  readonly description?: string
  parse(input: unknown, path: string): TOut
  toJsonSchema(): JsonSchemaNode
}
/* eslint-enable @typescript-eslint/no-unused-vars */

/**
 * schema 归一化**之后**的类型 —— 下游消费的形状。
 */
export type Infer<S> = S extends Schema<infer TOut, any, any> ? TOut : never
/**
 * 用户**可写**的形态 —— `define*` 的参数类型，决定 IDE 提示。
 */
export type InputOf<S> = S extends Schema<any, infer TIn, any> ? TIn : never

type Shape = Record<string, Schema<any, any, any>>

/** 输出形状：只有 opt() 的字段是可选的；withDefault() 有默认值，输出必填 */
export type InferShape<S extends Shape> = {
  [K in keyof S as S[K] extends Schema<any, any, true> ? never : K]: Infer<S[K]>
} & {
  [K in keyof S as S[K] extends Schema<any, any, true> ? K : never]?: Infer<S[K]>
}

/**
 * 输入形状：**只要 TIn 允许 undefined 就是可选键**。
 */
export type InputShape<S extends Shape> = {
  [K in keyof S as undefined extends InputOf<S[K]> ? never : K]: InputOf<S[K]>
} & {
  [K in keyof S as undefined extends InputOf<S[K]> ? K : never]?: Exclude<
    InputOf<S[K]>,
    undefined
  >
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function fail(path: string, message: string, hint?: string): never {
  throw new DpError('DP.CONFIG.INVALID', message, hint === undefined ? { path } : { path, hint })
}

function typeName(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return 'array'
  return typeof v
}

// 原子类型

function atom<T>(
  kind: string,
  check: (v: unknown) => boolean,
  jsonType: string,
  description?: string,
): Schema<T> {
  return {
    kind,
    isOptional: false,
    acceptsUndefined: false,
    description,
    parse(input, path) {
      if (!check(input)) fail(path, `期望 ${jsonType}，实际是 ${typeName(input)}`)
      return input as T
    },
    toJsonSchema: () => ({ type: jsonType, description }),
  }
}

/**
 * 字符串。严格 `typeof === 'string'`，不做任何强制转换。
 *
 * @param description 给用户看的说明，进 JSON Schema 的 description
 * @returns 字符串 schema
 */
export const str = (description?: string): Schema<string> =>
  atom<string>('string', (v) => typeof v === 'string', 'string', description)

/**
 * 数字。必须是**有限数** —— `NaN` 与 `Infinity` 一并拒掉。
 *
 * @param description 给用户看的说明，进 JSON Schema 的 description
 * @returns 数字 schema
 */
export const num = (description?: string): Schema<number> =>
  atom<number>('number', (v) => typeof v === 'number' && Number.isFinite(v), 'number', description)

/**
 * 布尔。严格 `typeof === 'boolean'`，不做真假值转换。
 *
 * @param description 给用户看的说明，进 JSON Schema 的 description
 * @returns 布尔 schema
 */
export const bool = (description?: string): Schema<boolean> =>
  atom<boolean>('boolean', (v) => typeof v === 'boolean', 'boolean', description)

/**
 * 字符串枚举。判定是**严格相等**：不 trim、不折叠大小写。
 *
 * @param values 允许的字面量。错误消息的 hint 由它直接生成，所以它就是"可用值"的单一事实来源
 * @param description 给用户看的说明
 * @returns 枚举 schema
 */
export function oneOf<T extends string>(values: readonly T[], description?: string): Schema<T> {
  return {
    kind: 'enum',
    isOptional: false,
    acceptsUndefined: false,
    description,
    parse(input, path) {
      if (typeof input !== 'string' || !values.includes(input as T)) {
        fail(
          path,
          `期望 ${values.join(' | ')} 之一，实际是 ${JSON.stringify(input)}`,
          `可选值：${values.join(', ')}`,
        )
      }
      return input as T
    },
    toJsonSchema: () => ({ type: 'string', enum: values, description }),
  }
}

/**
 * 单一字面量。与 `oneOf` 的分工**不是**「一个值 vs 多个值」：`oneOf` 表达「从这几个里选一个」且只认字符串，这里用严格相等比一个值，于是布尔与数字也能表达 —— `reload: false`（交给外部机制重载）只有它能落地。
 *
 * @param value 唯一允许的值
 * @returns 字面量 schema
 */
export function literal<T extends string | number | boolean>(value: T): Schema<T> {
  return {
    kind: 'literal',
    isOptional: false,
    acceptsUndefined: false,
    parse(input, path) {
      if (input !== value) {
        fail(path, `期望 ${JSON.stringify(value)}，实际是 ${JSON.stringify(input)}`)
      }
      return value
    },
    toJsonSchema: () => ({ const: value }),
  }
}

// 复合类型

/**
 * 数组。逐元素 parse，元素的路径编成 `${path}[${i}]`。
 *
 * @param item 元素的 schema
 * @param description 给用户看的说明
 * @returns 只读数组 schema
 */
export function arr<T>(item: Schema<T>, description?: string): Schema<readonly T[]> {
  return {
    kind: 'array',
    isOptional: false,
    acceptsUndefined: false,
    description,
    parse(input, path) {
      if (!Array.isArray(input)) fail(path, `期望数组，实际是 ${typeName(input)}`)
      return input.map((v, i) => item.parse(v, `${path}[${i}]`))
    },
    toJsonSchema: () => ({ type: 'array', items: item.toJsonSchema(), description }),
  }
}

/**
 * 对象。**未知字段一律报错**，绝不静默忽略。
 *
 * @param shape 字段名 → schema。`opt()` 的字段省略后**不产生该键**，`withDefault()` 的字段填默认值
 * @param description 给用户看的说明
 * @returns 对象 schema；输入形态与输出形态不同，见 InferShape / InputShape
 */
export function obj<S extends Shape>(
  shape: S,
  description?: string,
): Schema<InferShape<S>, InputShape<S>> {
  const required = Object.keys(shape).filter((k) => !shape[k]!.isOptional)
  return {
    kind: 'object',
    isOptional: false,
    acceptsUndefined: false,
    description,
    parse(input, path): InferShape<S> {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        fail(path, `期望对象，实际是 ${typeName(input)}`)
      }
      const src = input as Record<string, unknown>
      for (const key of Object.keys(src)) {
        if (!(key in shape)) {
          fail(`${path}.${key}`, '未知字段', `可用字段：${Object.keys(shape).join(', ')}`)
        }
      }
      const out: Record<string, unknown> = {}
      for (const [key, schema] of Object.entries(shape)) {
        const value = src[key]
        if (value === undefined) {
          if (!schema.acceptsUndefined) fail(`${path}.${key}`, '缺少必填字段')
          // opt(): 不产生该键
          if (schema.isOptional) continue
        }
        // withDefault(): 省略时 parse(undefined) 返回默认值
        out[key] = schema.parse(value, `${path}.${key}`)
      }
      return out as InferShape<S>
    },
    toJsonSchema() {
      const properties: Record<string, JsonSchemaNode> = {}
      for (const [key, schema] of Object.entries(shape)) properties[key] = schema.toJsonSchema()
      return { type: 'object', properties, required, description }
    },
  }
}

/**
 * 泛型必须把三个参数都写出来。
 *
 * @param value 每个值服从的 schema
 * @param description 给用户看的说明
 * @returns 键自由、值逐个归一化的 schema
 */
export function record<TOut, TIn, IsOptional extends boolean>(
  value: Schema<TOut, TIn, IsOptional>,
  description?: string,
): Schema<Readonly<Record<string, TOut>>, Readonly<Record<string, TIn>>> {
  return {
    kind: 'record',
    isOptional: false,
    acceptsUndefined: false,
    description,
    parse(input, path) {
      if (input === null || typeof input !== 'object' || Array.isArray(input)) {
        fail(path, `期望对象，实际是 ${typeName(input)}`)
      }
      const out: Record<string, TOut> = {}
      for (const [key, rawValue] of Object.entries(input as Record<string, unknown>)) {
        out[key] = value.parse(rawValue, `${path}.${key}`)
      }
      return out
    },
    toJsonSchema: () => ({
      type: 'object',
      additionalProperties: value.toJsonSchema(),
      description,
    }),
  }
}

// 修饰器

/**
 * 标为可选：输入可省略，省略后**输出里不产生这个键**（下游拿到的是"没有"）。
 *
 * @param schema 被修饰的 schema
 * @returns 同型但 isOptional 为 true 的 schema
 */
export function opt<TOut, TIn, IsOpt extends boolean>(
  schema: Schema<TOut, TIn, IsOpt>,
): Schema<TOut | undefined, TIn | undefined, true> {
  return {
    ...schema,
    kind: `optional(${schema.kind})`,
    isOptional: true,
    acceptsUndefined: true,
  } as unknown as Schema<TOut | undefined, TIn | undefined, true>
}

/**
 * 给一个默认值：输入可省，输出**必填**（省略时填 fallback）。
 *
 * @param schema 被修饰的 schema
 * @param fallback 省略时使用的值
 * @returns 同型但 acceptsUndefined 为 true、isOptional 为 false 的 schema
 */
export function withDefault<TOut, TIn, IsOpt extends boolean>(
  schema: Schema<TOut, TIn, IsOpt>,
  fallback: TOut,
): Schema<TOut, TIn | undefined, false> {
  return {
    ...schema,
    kind: `default(${schema.kind})`,
    isOptional: false as const,
    acceptsUndefined: true,
    parse(input: unknown, path: string) {
      return input === undefined ? fallback : schema.parse(input, path)
    },
    toJsonSchema: () => ({ ...schema.toJsonSchema(), default: fallback }),
  } as unknown as Schema<TOut, TIn | undefined, false>
}

/**
 * 给 schema 挂一条**结构之外**的规则。
 *
 * @param schema 被修饰的 schema，形状与类型参数原样透传
 * @param check 拿到归一化后的值与配置路径；抛错即终止，**不返回值**是刻意的 ——
 * 允许返回新值就等于有了第二条归一化路径，withDefault 之外不该再有一个
 * @returns 同型 schema，parse 时在原 parse 之后串上 check
 * @throws DpError check 主动抛出的错误，code 与 path 原样透出
 */
export function constrained<TOut, TIn, IsOpt extends boolean>(
  schema: Schema<TOut, TIn, IsOpt>,
  check: (value: TOut, path: string) => void,
): Schema<TOut, TIn, IsOpt> {
  return {
    ...schema,
    kind: `constrained(${schema.kind})`,
    parse(input, path) {
      const value = schema.parse(input, path)
      check(value, path)
      return value
    },
  }
}

/** 偏好链允许的用户写法 */
export type PrefInput<T extends string> = T | readonly T[] | 'auto'

/**
 * 偏好链：配置可以写单值或数组，归一化后**一律是数组**（下游对「是链」还是「单值」只认一种形态）。
 *
 * @param allowed 允许的取值全集；链里有不在其中的项即报 CONFIG_INVALID 并指明下标
 * @param defaultChain 写 'auto' 或省略时展开成的链。**不校验**它是否 ⊆ allowed ——
 * 它是实现给的常量，且这些默认值本身就是「实测过能跑」的顺序
 * @param description 供编辑器提示与 JSON Schema 用的说明；不写则该字段在编辑器里没有解释
 * @returns 输出恒为非空数组的 schema —— 空链在这里就报错而不是放行，
 * 因为空链在下游等同于「没有候选」，而那不是一个能给出建议的失败
 */
export function prefChain<T extends string>(
  allowed: readonly T[],
  defaultChain: readonly T[],
  description?: string,
): Schema<readonly T[], PrefInput<T>> {
  return {
    kind: 'prefChain',
    isOptional: false,
    acceptsUndefined: false,
    description,
    parse(input, path) {
      const raw: readonly unknown[] =
        input === undefined || input === 'auto'
          ? defaultChain
          : Array.isArray(input)
            ? input
            : [input]
      if (raw.length === 0) fail(path, '偏好链不能为空')
      return raw.map((v, i) => {
        if (typeof v !== 'string' || !allowed.includes(v as T)) {
          fail(`${path}[${i}]`, `不被支持：${JSON.stringify(v)}`, `可用：${allowed.join(', ')}`)
        }
        return v as T
      })
    },
    toJsonSchema: () => ({
      type: 'array',
      items: { type: 'string', enum: allowed },
      default: defaultChain,
      description,
    }),
  }
}
