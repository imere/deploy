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

/**
 * JSON Schema 的节点类型，只覆盖**编辑器提示用得到的那一小撮**字段。
 *
 * 为什么不引一份完整的 JSON Schema 类型定义：本包零依赖（供应链要可审计），
 * 而那套类型里绝大多数字段本仓一个都不产出。带进来只是多加一个包，
 * 还会把「本仓实际产出什么形状」这件事埋进一份外部声明里。
 */
export interface JsonSchemaNode {
  /** 原子类型名。数组形态留给将来表达"或"关系，目前没有产出方 */
  type?: string | string[]
  /**
   * 对象字段 → 该字段的 schema。只描述"有哪些字段"，
   * 与 `required` 分开是因为「有这个字段」与「这个字段必填」是两件事。
   */
  properties?: Record<string, JsonSchemaNode>
  /**
   * 必填字段名。由 `obj()` 按 `isOptional` **反推**而不是手写 ——
   * 手写一份必填清单会和真正的必填判定分叉，症状是编辑器说必填、运行时却接受省略。
   */
  required?: string[]
  /** 数组元素的 schema */
  items?: JsonSchemaNode
  /**
   * 字符串枚举，进编辑器的下拉补全。由 `oneOf()` 产出，
   * 所以它同时也是错误消息里"可选值"的同一份来源。
   */
  enum?: readonly unknown[]
  /**
   * 字面量。**与 enum 是两个东西**：enum 是「从这几个里选一个」，
   * const 是「必须是这个值」。分开的实质理由是 `oneOf` 只认字符串，
   * 而 `reload: false`（交给外部机制重载）这类非字符串字面量只能落在 const 上。
   */
  const?: unknown
  /**
   * 默认值，只供编辑器做占位提示。运行时的缺省值由 `withDefault` 自己填 ——
   * 两条路各自独立，这一项写错不会影响部署，只影响提示好不好读。
   */
  default?: unknown
  /**
   * 给用户看的说明，直接显示在编辑器的悬浮提示里。
   *
   * 这是**用户看得见**的文案，所以只写「是什么 / 怎么填」，不写指向别处的指路 ——
   * 读这段字的人手边只有那个悬浮框。
   */
  description?: string
  /** 键不受限制时的值 schema（`record()` 产出）。`false` 表示不允许额外键 */
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

/**
 * schema 归一化**之后**的类型 —— 下游消费的形状。
 *
 * 与 `InputOf` 成对存在的理由：偏好链可写 `'rsync'` 或 `['rsync','sftp']`，
 * 出来一律是数组。只留一个类型参数的话，IDE 要么拒绝单值（难写），
 * 要么让下游在每个消费点都处理一次联合（难用且迟早漏一处）。
 */
export type Infer<S> = S extends Schema<infer TOut, any, any> ? TOut : never
/**
 * 用户**可写**的形态 —— `define*` 的参数类型，决定 IDE 提示。
 *
 * 与 `Infer` 的差别集中在两处：`withDefault` 的字段在这里可省、在 `Infer` 里必填；
 * 偏好链在这里可写单值、在 `Infer` 里是数组。
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

/**
 * 字符串。严格 `typeof === 'string'`，不做任何强制转换。
 *
 * 为什么不宽松地转：`'8080'` 写进一个数字字段是手滑而不是"想要字符串"，
 * 转过去之后就再也无法区分这两种意图，而后者拼进 argv 时完全是另一回事。
 *
 * @param description 给用户看的说明，进 JSON Schema 的 description
 * @returns 字符串 schema
 */
export const str = (description?: string): Schema<string> =>
  atom<string>('string', (v) => typeof v === 'string', 'string', description)

/**
 * 数字。必须是**有限数** —— `NaN` 与 `Infinity` 一并拒掉。
 *
 * 为什么单独排非有限数：JSON 里出不来它们，但 YAML 与 JS 配置能出。
 * 而一个 NaN 拼进路径或 argv 之后，目标机报的错与本次配置毫无关系，
 * 排查方向会整个偏掉。数字字符串同样不接受，理由同 `str`。
 *
 * @param description 给用户看的说明，进 JSON Schema 的 description
 * @returns 数字 schema
 */
export const num = (description?: string): Schema<number> =>
  atom<number>('number', (v) => typeof v === 'number' && Number.isFinite(v), 'number', description)

/**
 * 布尔。严格 `typeof === 'boolean'`，不做真假值转换。
 *
 * 为什么不接受 `'false'` 这类字符串：任何非空字符串按真假值转换都是 `true`，
 * 转过去的结果是配置明明写了个"关"、实际跑的是"开"，且没有一处会报错。
 *
 * @param description 给用户看的说明，进 JSON Schema 的 description
 * @returns 布尔 schema
 */
export const bool = (description?: string): Schema<boolean> =>
  atom<boolean>('boolean', (v) => typeof v === 'boolean', 'boolean', description)

/**
 * 字符串枚举。判定是**严格相等**：不 trim、不折叠大小写。
 *
 * 为什么这么硬：枚举值最终是给机器分派的（错误码、目标类型、驱动名都按字面量分派），
 * 折叠一次就会出现「配置里写 `prod `（尾部空格）、代码按 `prod` 分派」的错位，
 * 而这种错没有任何一处会报错。多一个空格的代价是当场报一条带可选值的错误，便宜得多。
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
 * 单一字面量。与 `oneOf` 的分工**不是**「一个值 vs 多个值」：
 * `oneOf` 表达「从这几个里选一个」且只认字符串，这里用严格相等比一个值，
 * 于是布尔与数字也能表达 —— `reload: false`（交给外部机制重载）只有它能落地。
 *
 * 失败时报「期望 X，实际是 Y」而不是列一串可选值：只有一个允许值时，
 * 说清"该写什么"比给一堆选项有用。
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

// ------------------------------------------------------------
// 复合类型
// ------------------------------------------------------------

/**
 * 数组。逐元素 parse，元素的路径编成 `${path}[${i}]`。
 *
 * 为什么下标必须进路径：数组里第 3 个元素写错，报 `locations` 等于让人去查整个数组，
 * 报 `locations[2].upstream` 才指向真正要改的那一行。空数组是合法的 ——
 * 「一个都没有」与「写错了」是两件事，后者才有判定，判定发生在元素上。
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
 * 这是本包最要紧的一条判据：字段名拼错（`serverNam`）时若忽略，用户会以为自己
 * 配了 server_name，而渲染出来的 conf 是 `server_name _` —— 不报错，只是行为不对，
 * 这种故障要一路绿到远端 reload 之后才可能被人察觉。报出来的是「未知字段 + 可用字段清单」，
 * 改哪一处一眼可见。
 *
 * 必填判定走 `acceptsUndefined` 而不是 `key in src`：`{ keep: undefined }`
 * （展开一个可能没值的变量得来）与不写 `keep` 在 JS 里是两件事，但对 `withDefault`
 * 都该填默认值；用 `in` 判会把前者当成"给了 undefined"然后 parse 失败。
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
 * 写成 `record<T>(value: Schema<T>)` 时，`Schema<T>` 等价于 `Schema<T, T, false>`，
 * 于是 T 同时对应到 TOut 与 TIn 两个位置。传入 `obj({...})` 这种 TOut ≠ TIn 的
 * schema 时 TS 会挑其中一个 —— 实测挑了 **TIn（输入形状）**，于是
 * `Config.projects.web.release.keep` 明明有默认值却被推导成可能 undefined，
 * 下游只得写一堆 `?? 默认值` 来绕。TOut / TIn 分开声明才能把归一化后的形状传出去。
 *
 * @param value 每个值服从的 schema
 * @param description 给用户看的说明
 * @param TIn 类型参数（非形参）：值的输入形态，必须与 TOut 分开写，理由见上
 * @param IsOptional 类型参数：值 schema 是否可选，透传而不重新推导
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

// ------------------------------------------------------------
// 修饰器
// ------------------------------------------------------------

/**
 * 标为可选：输入可省略，省略后**输出里不产生这个键**（下游拿到的是"没有"）。
 *
 * 与 `withDefault` 的差别只在输出：那边省略后填默认值（下游必填）。
 * 合成一个"可选 + 默认值"的形状会把两种语义混成一团 —— 下游再也分不清
 * 「用户明确没配」与「用了系统默认」，而这两者在报告与排查里是两件事。
 *
 * @param schema 被修饰的 schema
 * @param TIn 类型参数（非形参）：输入形态，透传
 * @param IsOpt 类型参数：原 schema 是否可选，透传；本函数把结果的可选位改成 true
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
 * 默认值的适用范围被严格限定在「用户没写」：写了但不合法照样报错，
 * 绝不拿默认值去兜一个写坏的值 —— 那等于拿一份"看起来能跑"的配置去动生产路径。
 *
 * fallback 本身**不过** schema.parse：它是实现给的常量而不是用户输入，
 * 对它做校验只是把实现自己的取值也拖进"配置错"这一类里。
 *
 * @param schema 被修饰的 schema
 * @param fallback 省略时使用的值
 * @param TIn 类型参数（非形参）：输入形态，透传
 * @param IsOpt 类型参数：原 schema 是否可选，透传
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
