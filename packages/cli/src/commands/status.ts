/**
 * `dp status` —— 只读报告目标机现在是什么状态。
 *
 * 零副作用是硬要求：不切 current、不回滚、不 prune、不写索引。用户跑 status
 * 绝不该导致环境发生变化 —— 一条「看看现在怎样」的命令如果会顺手做点什么，
 * 排查问题时反而会引入新的变量。
 */
import { readReleaseState, verifyRelease } from '@dp/target-static'
import type { TargetContext } from '@dp/ports'
import { defaultApplyDeps } from '../deps.js'
import { exitCodeFor } from '../output.js'
import { renderOpsJson, renderOpsPretty, type StatusResult } from '../output-ops.js'
import { selectTargets } from '../targets.js'
import { staticConfigFor } from '../target-config.js'
import { resolveTarget, targetErrorFields, type ResolvedTargetInput } from '../target-resolve.js'
import type { ProjectConfig, HostConfig } from '@dp/schema'
import type { ResolvedFlags, RunContext } from '../run.js'
import type { LoadedConfig } from '../config-file.js'

export async function runStatus(context: RunContext, flags: ResolvedFlags): Promise<number> {
  const loaded: LoadedConfig = await context.loadConfig(flags)
  const targets = selectTargets({
    config: loaded.config,
    project: flags.project,
    host: flags.host,
    all: flags.all,
    env: flags.env,
  })

  const deps = context.deps ?? defaultApplyDeps()
  const results: StatusResult[] = []
  let worst = 0

  for (const target of targets) {
    const logger = context.logger.child({ host: target.host })
    const { result, exitCode } = await statusOne(context, deps, {
      project: target.project,
      host: target.host,
      projectConfig: target.projectConfig,
      hostConfig: target.hostConfig,
      logger,
    })
    results.push(result)
    worst = Math.max(worst, exitCode)
  }

  context.out(
    flags.json
      ? renderOpsJson('status', results)
      : results.map((r) => renderOpsPretty('status', r)).join('\n\n'),
  )
  return worst
}

interface StatusInput {
  readonly project: string
  readonly host: string
  readonly projectConfig: ProjectConfig
  readonly hostConfig: HostConfig
  readonly logger: ReturnType<RunContext['logger']['child']>
}

async function statusOne(
  context: RunContext,
  deps: ResolvedTargetInput['deps'],
  input: StatusInput,
): Promise<{ readonly result: StatusResult; readonly exitCode: number }> {
  const { host, project, logger } = input
  const warnings: string[] = []
  let resolved: Awaited<ReturnType<typeof resolveTarget>> | undefined

  try {
    resolved = await resolveTarget({ context, target: input, deps, logger })
    const state = await readReleaseState(resolved.runner, resolved.releaseRoot)

    const base: StatusResult = {
      host,
      project,
      releaseRoot: resolved.releaseRoot,
      current: state.current ?? null,
      previous: state.previous ?? null,
      releases: state.releases,
      deployed: state.current !== undefined,
      healthy: null,
      warnings,
    }

    // 没部署过：这是**正常的初始状态**，退出 0。报成失败只会让第一次部署前
    // 的检查全部变红，而此时根本没有可失败的东西
    if (state.current === undefined) {
      warnings.push('尚未部署过：索引里没有 current。跑一次 dp apply 之后再来查')
      return { result: { ...base, healthy: null }, exitCode: 0 }
    }

    const ctx: TargetContext = {
      host,
      root: resolved.releaseRoot,
      releaseId: state.current,
      keep: resolved.keep,
      ...(state.previous !== undefined ? { previousReleaseId: state.previous } : {}),
    }
    const check = await verifyRelease(resolved.runner, ctx, staticConfigFor(input.projectConfig))
    if (!check.ok) warnings.push(`DP.VERIFY.FAILED: ${check.reason}`)

    return {
      result: {
        ...base,
        healthy: check.ok,
        ...(check.ok ? {} : { reason: check.reason ?? '健康检查未通过' }),
      },
      exitCode: 0,
    }
  } catch (err) {
    logger.error('status.failed', { code: targetErrorFields(err).code })
    return {
      result: {
        host,
        project,
        releaseRoot: '',
        current: null,
        previous: null,
        releases: [],
        deployed: false,
        healthy: null,
        warnings,
        error: targetErrorFields(err),
      },
      exitCode: exitCodeFor(err),
    }
  } finally {
    await resolved?.close?.()
  }
}
