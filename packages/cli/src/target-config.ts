/**
 * 配置 → 目标实现的配置翻译。**纯函数**。
 *
 * 单独成文件是因为同一份翻译要被 apply / verify / status / rollback 四处用：
 * 复制四份就意味着「改了健康检查的读法只改了三处」这种必然发生的不一致，
 * 而不一致在这里的表现是「apply 验得过、dp verify 报不过」。
 */
import type { ProjectConfig } from '@dp/schema'
import type { StaticTargetConfig } from '@dp/target-static'

/**
 * static 目标只认 `healthcheck.fileExists` 一种校验（不需要起进程、不碰 shell）。
 * 其余 healthcheck 形态（command / http / tcp）属于后续目标的能力，这里
 * **不假装支持** —— 没映射就不会被读，也就不会给出虚假的「已校验」。
 */
export function staticConfigFor(project: ProjectConfig): StaticTargetConfig {
  const fileExists = project.healthcheck?.fileExists
  return fileExists === undefined ? {} : { healthcheck: { fileExists } }
}
