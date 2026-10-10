import type { ProjectConfig } from '@dp/schema'
import type { StaticTargetConfig } from '@dp/target-static'

/**
 * static 目标只认 `healthcheck.fileExists` 一种校验（不需要起进程、不碰 shell）。
 */
export function staticConfigFor(project: ProjectConfig): StaticTargetConfig {
  const fileExists = project.healthcheck?.fileExists
  return fileExists === undefined ? {} : { healthcheck: { fileExists } }
}
