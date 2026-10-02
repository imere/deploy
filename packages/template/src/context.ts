/**
 * 渲染上下文与选项 —— 只有形状，没有行为。
 *
 * 铁律：本包**零 IO**。环境变量与 git 状态都由调用方探测好塞进来，
 * 原因不是洁癖，而是「模板渲染」是这个仓库里唯一会被 plan 期直接调用的环节；
 * 一旦它自己去读 process.env 或起 git 子进程，plan() 就不再是纯函数，
 * 也就没法在没有任何机器的机器上断言「将要替换什么」。
 */

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
 *
 * 分档的依据是**这个值最终会落在哪**：
 *  - text  多行文本本身合法（模板里就有换行），只挡控制字符
 *  - path  会拼成远端路径，挡换行并复用 core 的跨平台路径判定
 *  - shell 以 argv 元素传远端，挡一切控制字符（含换行：换行能把一条参数拆成两条）
 *  - conf  写进 nginx conf / compose yaml，规则同 shell
 */
export type Usage = 'text' | 'path' | 'shell' | 'conf'

export interface RenderOptions {
  /** 出错时定位到具体配置项，如 'projects.web.target.confd' */
  readonly path?: string
  /** 产出物用途，决定危险字符校验的严格程度。默认 'text' */
  readonly usage?: Usage
}
