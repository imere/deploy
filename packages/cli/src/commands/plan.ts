/**
 * `dp plan` —— 干跑。本回合**只读**：不建目录、不写文件、不连交互。
 *
 * 之所以第一版就把 plan 做成真能用的而不是占位：plan 是零副作用的，它能回答
 * 「这次会做什么、发布根落在哪、能力缺什么」—— 而这些问题在真正部署前
 * 唯一安全的时刻就是现在。
 */
import { makePlan, type Plan } from '@dp/core'
import { listSourceEntries, normalizeSourceSpec } from '@dp/local'
import type { LoadedConfig } from '../config-file.js'
import { defaultApplyDeps } from '../deps.js'
import { readFactsFile } from '../facts-source.js'
import { renderPlanJson, renderPlanPretty } from '../output.js'
import { previewReleaseId } from '../release-id.js'
import { selectTargets } from '../targets.js'
import { resolveTarget } from '../target-resolve.js'
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
    const logger = context.logger.child({ host: target.host })
    const releaseId = previewReleaseId(target.project, started)

    // 源清单先枚举：它只读本地文件系统，出问题时用户还没付任何代价
    const spec = normalizeSourceSpec(target.projectConfig.source.root, context.cwd)
    const entries = await listSourceEntries(spec)
    if (entries.length === 0) {
      context.error(
        `项目 ${target.project} 的 source 是空的：${spec.root}`,
        '构建产物为空，或 include/exclude 把所有文件都排除了',
      )
      return 1
    }

    // facts 只有两个来源：--facts 夹具（完全离线，无连接、无 runner），或者在
    // status / verify / rollback / apply 共用的 resolveTarget 上现场探测。
    // --facts 不进 resolveTarget：resolveTarget 会拒绝「夹具 + 远端主机」，而 plan
    // 对这个组合有义务离线给出结论 —— 离线复核问题正是它存在的目的
    const result =
      flags.factsFile !== undefined
        ? { facts: await readFactsFile(flags.factsFile), probeNotes: [] as readonly string[], close: undefined }
        : await resolveTarget({
            context,
            deps: context.deps ?? defaultApplyDeps(),
            logger,
            target: {
              project: target.project,
              host: target.host,
              projectConfig: target.projectConfig,
              hostConfig: target.hostConfig,
            },
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

    logger.info('plan.done', {
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
