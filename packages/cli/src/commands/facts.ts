/**
 * `dp facts` —— 打印目标机的实证事实。
 *
 * 独立成一个命令而不是只在 plan 里顺带打印：探测结果存成文件后，CI 里的 plan
 * 可以 `--facts` 复用（离线、可复现、不必在每次流水线里都连一遍目标机）。
 * 这是把「慢且会失败的一步」从每次部署里摘出去的办法。
 */
import type { LoadedConfig } from '../config-file.js'
import { acquireFacts } from '../facts-source.js'
import { renderFactsJson, renderFactsPretty } from '../output.js'
import { selectTargets } from '../targets.js'
import type { ResolvedFlags, RunContext } from '../run.js'

export async function runFacts(context: RunContext, flags: ResolvedFlags): Promise<number> {
  // facts 不需要 projects：目标机事实与项目无关。但配置文件里通常有，
  // 所以仍然走同一套发现/校验，让「配置写错」在最早的地方暴露出来。
  const loaded: LoadedConfig = await context.loadConfig(flags)
  const targets = selectTargets({
    config: loaded.config,
    project: flags.project,
    host: flags.host,
    all: flags.all,
    env: flags.env,
  })

  const blocks: string[] = []
  for (const target of targets) {
    const logger = context.logger.child({ host: target.host })
    const result = await acquireFacts({
      hostId: target.host,
      host: target.hostConfig,
      logger,
      projectName: target.project,
    })
    try {
      blocks.push(flags.json ? renderFactsJson(result.facts, result.probeNotes) : renderFactsPretty(result.facts, result.probeNotes))
    } finally {
      await result.close?.()
    }
  }
  context.out(blocks.join('\n\n'))
  return 0
}
