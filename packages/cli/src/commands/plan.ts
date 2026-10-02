/**
 * `dp plan` —— 干跑。本回合**只读**：不建目录、不写文件、不连交互。
 *
 * 之所以第一版就把 plan 做成真能用的而不是占位：plan 是零副作用的，它能回答
 * 「这次会做什么、发布根落在哪、能力缺什么」—— 而这些问题在真正部署前
 * 唯一安全的时刻就是现在。
 */
import { makePlan, type Plan } from '@dp/core'
import type { Logger } from '@dp/log'
import { listSourceEntries, normalizeSourceSpec } from '@dp/local'
import type { LoadedConfig } from '../config-file.js'
import { acquireFacts, readFactsFile } from '../facts-source.js'
import { renderPlanJson, renderPlanPretty } from '../output.js'
import { previewReleaseId } from '../release-id.js'
import { selectTargets } from '../targets.js'
import type { PlanOptions, ResolvedFlags, RunContext } from '../run.js'

export async function runPlan(context: RunContext, flags: ResolvedFlags): Promise<number> {
  const started = new Date()
  const loaded: LoadedConfig = await context.loadConfig(flags)
  const targets = selectTargets({
    config: loaded.config,
    project: flags.project,
    host: flags.host,
    all: flags.all,
    env: flags.env,
  })

  const rendered: string[] = []

  for (const target of targets) {
    const logger: Logger | undefined = context.logger.child({ host: target.host })
    const releaseId = previewReleaseId(target.project, started)

    // 源清单先枚举：它只读本机文件系统，出问题时用户还没付任何代价
    const spec = normalizeSourceSpec(target.projectConfig.source.root, context.cwd)
    const entries = await listSourceEntries(spec)
    if (entries.length === 0) {
      context.error(
        `项目 ${target.project} 的 source 是空的：${spec.root}`,
        '构建产物为空，或 include/exclude 把所有文件都排除了',
      )
      return 1
    }

    const facts = flags.factsFile !== undefined ? await readFactsFile(flags.factsFile) : undefined
    const result =
      facts !== undefined
        ? { facts, probeNotes: [] as readonly string[], close: undefined }
        : await acquireFacts({
            hostId: target.host,
            host: target.hostConfig,
            projectName: target.project,
            ...(target.projectConfig.release?.root !== undefined
              ? { releaseRoot: target.projectConfig.release.root }
              : {}),
            ...(logger !== undefined ? { logger } : {}),
          })

    let plan: Plan
    try {
      plan = makePlan({
        name: target.project,
        project: target.projectConfig,
        facts: result.facts,
        releaseId,
        sourceEntries: entries.map((e) => e.relativePath),
        ...(target.hostConfig.layout !== undefined ? { layout: target.hostConfig.layout } : {}),
      })
    } finally {
      // 无论 plan 成不成都必须断开：漏掉 close 会让进程挂到 socket 超时
      await result.close?.()
    }

    context.logger.child({ host: target.host }).info('plan.done', {
      project: target.project,
      host: target.host,
      steps: plan.steps.length,
      layout: plan.layout,
      releaseRoot: plan.releaseRoot,
      warnings: plan.warnings.length,
    })

    rendered.push(
      flags.json
        ? renderPlanJson(plan, {
            project: target.project,
            host: target.host,
            releaseId,
            probeNotes: result.probeNotes,
          })
        : renderPlanPretty(plan, { probeNotes: result.probeNotes }),
    )
  }

  context.out(rendered.join('\n\n'))
  return 0
}

export const PLAN_OPTION_HINT: PlanOptions = {
  needsConfig: true,
  allowedFlags: [
    'config',
    'env',
    'host',
    'project',
    'all',
    'facts',
    'json',
    'dry-run',
    'log-format',
    'log-level',
    'log-file',
    'verbose',
    'quiet',
  ],
}
