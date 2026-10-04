/**
 * 极简 schema DSL。
 *
 * 为什么自研而不是引入库：
 *  1. 错误消息必须带**配置路径**（`projects.web.source.root`），且必须能挂 hint
 *  2. 需要偏好链（preference chain）这种本项目专属语义
 *  3. 零依赖 —— 供应链要可审计
 *
 * 三个用途（对应第 4 条要求）：TS 类型推导 / 运行时校验 / 导出 JSON Schema。
 *
 * 两个类型参数：
 *  - `TOut` 归一化**之后**的类型（parse 的返回值）
 *  - `TIn`  用户**可写**的形态（define* 的参数类型，决定 IDE 提示）
 *  二者不同的典型例子是偏好链：可写 `'rsync'` 或 `['rsync','sftp']`，出来一律是数组。
 */
import { DpError } from '@dp/ports'

export interface JsonSchemaNode {
  type?: string | string[]
  properties?: Record<string, JsonSchemaNode>
  required?: string[]
  items?: JsonSchemaNode
  enum?: readonly unknown[]
  const?: unknown
  default?: unknown
  description?: string
  additionalProperties?: boolean | JsonSchemaNode
  /** 联合：任一分支成立即可 */
  anyOf?: readonly JsonSchemaNode[]
}

/* eslint-disable @typescript-eslint/no-explicit-any -- DSL 必须擦除具体类型才能做形状推导 */

/**
 * `IsOptional` 必须是**字面量类型**而不是 boolean —— 否则类型层面无法区分
 * 可选字段与必填字段，`withDefault` 的字段会被误判成必填。
 */
export interface Schema<TOut, TIn = TOut, IsOptional extends boolean = false> {
  readonly kind: string
  readonly isOptional: IsOptional
  /**
   * 输入可以省略该字段。opt() 与 withDefault() 都是 true —— 区别在于
   * 前者省略后**不产生**该键，后者省略后填入默认值。
   */
  readonly acceptsUndefined: boolean
  readonly description?: string
  parse(input: unknown, path: string): TOut
  toJsonSchema(): JsonSchemaNode
}

export type Infer<S> = S extends Schema<infer TOut, any, any> ? TOut : never
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
 * 这样 opt() 与 withDefault() 在用户书写时都不必填，但输出语义不同。
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

// ------------------------------------------------------------
// 原子类型
// ------------------------------------------------------------

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

export const str = (description?: string): Schema<string> =>
  atom<string>('string', (v) => typeof v === 'string', 'string', description)

export const num = (description?: string): Schema<number> =>
  atom<number>('number', (v) => typeof v === 'number' && Number.isFinite(v), 'number', description)

export const bool = (description?: string): Schema<boolean> =>
  atom<boolean>('boolean', (v) => typeof v === 'boolean', 'boolean', description)

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

// ------------------------------------------------------------
// 复合类型
// ------------------------------------------------------------

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
 * 写成 `record<T>(value: Schema<T>)` 时，`Schema<T>` 等价于 `Schema<T, T, false>`，
 * 于是 T 同时对应到 TOut 与 TIn 两个位置。传入 `obj({...})` 这种 TOut ≠ TIn 的
 * schema 时 TS 会挑其中一个 —— 实测挑了 **TIn（输入形状）**，于是
 * `Config.projects.web.release.keep` 明明有默认值却被推导成可能 undefined，
 * 下游只得写一堆 `?? 默认值` 来绕。TOut / TIn 分开声明才能把归一化后的形状传出去。
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

// ------------------------------------------------------------
// 修饰器
// ------------------------------------------------------------

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

/** 有默认值：输入可省略，输出必填 */
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

/** 额外的语义约束（schema 结构之外的规则），失败同样报 CONFIG_INVALID + path */
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
 * 偏好链（第 5 条）：配置可以写单值或数组，归一化后**一律是数组**。
 *
 *   'auto'               → 默认链
 *   'rsync'              → ['rsync']
 *   ['rsync','tar-ssh']  → 原样
 *
 * 链内项若都不被支持 → 由 core 报 `DP.PREF.UNSUPPORTED`，列出整条链与每项的失败原因。
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
