/**
 * docker 目标的配置翻译。**纯函数**，零 IO。
 *
 * 单独成文件的理由与 nginx-config.ts 一样：翻译只有这一份实现，apply / verify /
 * status / rollback 四处共用。复制四份就意味着「改了 expectStates 的读法只改了三处」，
 * 而症状是「apply 验得过、dp verify 报不过」。
 *
 * 与 nginx 侧的关键差异：**这里不推导任何目标机路径**。发布根由 resolveTarget 从
 * 实测能力推导（compose 文件随 release 上传后就在那个目录之下），而 compose 文件
 * 自己的路径是**相对 release 目录**的（compose.ts 的 assertRelative 强制）——
 * 也就是说这里没有任何一个字段能承载「部署到哪」，这是对的。
 */
import type { TargetContext } from '@dp/ports'
import type { DockerConfig } from '@dp/schema'
import type { DockerTargetConfig } from '@dp/target-docker'
import { releaseVars } from '@dp/template'

export interface DockerTranslateInput {
  readonly project: string
  /** profile 名（`--env`）。没给就是空串：`${env}` 这时按缺值报错，而不是编一个出来 */
  readonly env: string
  readonly envVars: Readonly<Record<string, string | undefined>>
  readonly targetCtx: TargetContext
  readonly now: Date
  readonly docker: DockerConfig
}

/**
 * schema 的 `target.docker` → @dp/target-docker 的 `DockerTargetConfig`。
 *
 * **渲染上下文只在这里构造一次**，取值来自 `releaseVars(targetCtx)` —— 与
 * nginxConfigFor 同源。自己再拼一遍 `${release.current}` 就是第二个事实来源，
 * 两处一旦漂移，产出的 compose 路径会指向一个从没被发布过的目录。
 *
 * `pull` / `wait` 直接透传：schema 已经给了默认值（true），这里不写第二套默认值。
 * 写成 `config.compose.pull ?? true` 看着无害，实际上是把「默认值的定义」分成了两处，
 * 改 schema 的那一处时 CLI 这处会静默保持旧值。
 */
export function dockerConfigFor(input: DockerTranslateInput): DockerTargetConfig {
  const { docker, targetCtx } = input
  const vars = releaseVars(targetCtx)
  const compose = docker.compose
  return {
    mode: docker.mode,
    compose: {
      files: compose.files,
      projectName: compose.projectName,
      pull: compose.pull,
      wait: compose.wait,
      ...(compose.envFile !== undefined ? { envFile: compose.envFile } : {}),
    },
    render: {
      project: input.project,
      env: input.env,
      envVars: input.envVars,
      release: { id: vars['release.id'], current: vars['release.current'] },
      now: input.now,
    },
    ...(docker.healthcheck !== undefined
      ? {
          healthcheck: {
            ...(docker.healthcheck.services !== undefined ? { services: docker.healthcheck.services } : {}),
            ...(docker.healthcheck.expectStates !== undefined
              ? { expectStates: docker.healthcheck.expectStates }
              : {}),
          },
        }
      : {}),
  }
}
