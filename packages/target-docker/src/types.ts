/**
 * docker 目标的配置形状。
 *
 * 本轮只覆盖 DESIGN §8.3 的**默认模式 `remote-cli`**：compose 文件随 release 上传，
 * 然后在远端跑 `docker compose`。另外两种（build-load / registry）要本机 docker，
 * 依赖与失败模型完全不同，另开回合再长。
 *
 * `mode` 存在是为了将来扩展，但**非 `remote-cli` 必须显式报错** —— 静默降级会让
 * 用户以为在 build-push、实际什么都没构建，失败会以「镜像 tag 不存在」的形式
 * 在很久之后才出现。
 */
import type { RenderContext } from '@dp/template'

/**
 * 本轮允许的取值。其余值一律显式拒绝（见 assertMode）。
 *
 * 类型上放宽到 `string` 是刻意的：这份配置来自 YAML，而真正的闸门是运行期的
 * `assertMode`。只写 `'remote-cli'` 会让「绕过 schema 直接流进来的非法值」
 * 在类型上消失，而那时唯一还能救的就是运行期判定 —— 静默降级比报错危险得多。
 */
export type DockerMode = 'remote-cli' | (string & {})

export interface DockerCompose {
  /**
   * compose 文件，**相对 release 目录**的路径，按给定顺序生效。
   *
   * 必须非空且不重复：空数组渲染出的是不带 `-f` 的 `docker compose up`，
   * 它会在当前工作目录里找 compose 文件，找不到就报一句与部署毫无关系的话。
   */
  readonly files: readonly string[]
  /** compose 项目名。会成为容器名与网络名的前缀，字符集由 compose 收紧（见 compose.ts） */
  readonly projectName: string
  /** env 文件，路径相对 release 目录。给了就变成 `--env-file <path>` */
  readonly envFile?: string
  /** 拉取镜像。默认 true：tag 可变的镜像不 pull 就等于部署上一轮的镜像 */
  readonly pull?: boolean
  /** `up --wait` 等到健康。默认 true。关掉它 verify 就是唯一一道关 */
  readonly wait?: boolean
}

/**
 * 健康检查。`services` 为空 = ps 输出里的每个服务都要通过。
 *
 * 不接受「跳过健康检查」这种配置：DESIGN §2 的结论是没有健康检查就不存在
 * 「验证通过」，真要跳过由用户在编排层决定，不该由 target 悄悄放行。
 */
export interface DockerHealthcheck {
  /** 只检查这些服务；不给则检查全部 */
  readonly services?: readonly string[]
  /** 额外的期望状态。默认只认 `running` / `healthy` */
  readonly expectStates?: readonly string[]
}

export interface DockerTargetConfig {
  readonly mode: DockerMode
  readonly compose: DockerCompose
  /**
   * 渲染上下文（`${env.NAME}` / `${release.current}` / `${project}` 的值）。
   * **注入而非读环境**：本包零 IO，自己去读 process.env 会让 plan() 不再是纯函数，
   * 也就无法在没有机器的机器上断言产出。
   */
  readonly render: RenderContext
  readonly healthcheck?: DockerHealthcheck
}
