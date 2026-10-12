import type { SwitchStrategy } from '@dp/ports'
import type { ProjectConfig } from '@dp/schema'
import type { StaticTargetConfig } from '@dp/target-static'

/**
 * 部署与回滚必须走同一种切换方式：两次操作各走一条路的话，一次「部署 → 回滚」
 * 之后 current 的形态会不一致（部署建的是软链、回滚复制出目录），而下一次
 * 部署的「先删再建」就要按另一种形态收拾残局。
 */
export function switchStrategyFor(project: ProjectConfig): SwitchStrategy {
  return project.release?.switchStrategy ?? 'auto'
}

/**
 * static 目标只认两项配置：健康检查与切换方式。
 */
export function staticConfigFor(project: ProjectConfig): StaticTargetConfig {
  const fileExists = project.healthcheck?.fileExists
  return {
    ...(fileExists === undefined ? {} : { healthcheck: { fileExists } }),
    switch: switchStrategyFor(project),
  }
}
