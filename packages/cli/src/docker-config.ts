import type { TargetContext } from '@dp/ports'
import type { DockerConfig } from '@dp/schema'
import type { DockerTargetConfig } from '@dp/target-docker'
import { renderContextFor } from './render-context.js'

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
 */
export function dockerConfigFor(input: DockerTranslateInput): DockerTargetConfig {
  const { docker } = input
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
    render: renderContextFor(input),
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
