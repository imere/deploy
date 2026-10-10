/** 渲染上下文：项目名、环境名与调用方注入的环境变量表。 */
export interface RenderContext {
  readonly project: string
  /** 环境名，如 'prod'。供 ${env} 使用 */
  readonly env: string
  /** 环境变量表，供 ${env.NAME} 使用 */
  readonly envVars?: Readonly<Record<string, string | undefined>>
  readonly git?: { readonly sha?: string; readonly branch?: string; readonly tag?: string }
  readonly release?: { readonly id?: string; readonly current?: string }
  readonly now?: Date
  /** 额外变量，优先级最低（内置变量优先） */
  readonly extra?: Readonly<Record<string, string | undefined>>
}

/**
 * 产出物用途，决定危险字符校验的严格程度。
 */
export type Usage = 'text' | 'path' | 'shell' | 'conf'

/**
 * 单次渲染的选项。
 */
export interface RenderOptions {
  /** 出错时定位到具体配置项，如 'projects.web.target.confd' */
  readonly path?: string
  /** 产出物用途，决定危险字符校验的严格程度。默认 'text' */
  readonly usage?: Usage
}
