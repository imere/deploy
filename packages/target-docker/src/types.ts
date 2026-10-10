import type { RenderContext } from '@dp/template'

/**
 * 本轮允许的取值。其余值一律显式拒绝（见 assertMode）。
 */
export type DockerMode = 'remote-cli' | (string & {})

/**
 * 用户手写的一半：用哪些 compose 文件、项目叫什么、要不要 pull / 等 healthy。
 */
export interface DockerCompose {
  /**
   * compose 文件，**相对 release 目录**的路径，按给定顺序生效。
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
 */
export interface DockerHealthcheck {
  /** 只检查这些服务；不给则检查全部 */
  readonly services?: readonly string[]
  /** 额外的期望状态。默认只认 `running` / `healthy` */
  readonly expectStates?: readonly string[]
}

/**
 * docker 目标要的东西，按「谁提供」分成两半：用户写的配置 vs 上层注入的依赖。
 */
export interface DockerTargetConfig {
  /**
   * 部署模式。本轮只有 `remote-cli` 跑得通，其余取值由 assertMode 在 plan 期显式拒绝 ——静默降级会让用户以为镜像构建过了，而真正的失败要等很久才以「tag 不存在」的形式冒出来。
   */
  readonly mode: DockerMode
  readonly compose: DockerCompose
  /**
   * 渲染上下文（`${env.NAME}` / `${release.current}` / `${project}` 的值）。
   */
  readonly render: RenderContext
  readonly healthcheck?: DockerHealthcheck
}
