/**
 * `dp status` —— 只读报告目标机现在是什么状态。
 *
 * 零副作用是硬要求：不切 current、不回滚、不 prune、不写索引。用户跑 status
 * 绝不该导致环境发生变化 —— 一条「看看现在怎样」的命令如果会顺手做点什么，
 * 排查问题时反而会引入新的变量。
 */
import { readReleaseState, verifyRelease } from '@dp/target-static'
import { verifyDocker, type ComposePsEntry } from '@dp/target-docker'
import type { TargetContext } from '@dp/ports'
import { defaultApplyDeps } from '../deps.js'
import { dockerConfigFor } from '../docker-config.js'
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
    }, flags)
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
  flags: ResolvedFlags,
): Promise<{ readonly result: StatusResult; readonly exitCode: number }> {
  const { host, project, logger } = input
  const warnings: string[] = []
  /** compose 读到的服务状态。空 = 这次没读到（没配 docker，或读失败） */
  const services: ComposePsEntry[] = []
  /** ps 是否真的读到了。「读到且空」与「没读到」在结果里必须分得开 */
  let sawCompose = false
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

    // docker：compose ps 是只读的，所以「读服务状态」不违反 status 的零副作用。
    // 但**读不到不能当成不健康**：那会让一台没装 compose 的机器在 status 里永远红着，
    // 而 status 的职责是报告事实。读不到就说读不到（warning），healthy 交给 static 那一半
    const dockerSpec = input.projectConfig.target?.docker
    if (dockerSpec !== undefined) {
      try {
        const docker = await verifyDocker({
          runner: resolved.runner,
          ctx,
          config: dockerConfigFor({
            project: input.project,
            // 与 apply / verify 同源：projectName 与 compose 文件路径都过渲染，
            // ${env} 在 status 里算成空串会让 ps 去查另一个项目名，然后报「读不到」
            env: flags.env ?? '',
            envVars: context.env,
            targetCtx: ctx,
            now: new Date(0),
            docker: dockerSpec,
          }),
          onStep: (step) => logger.info('status.docker', { step: step.id, kind: step.kind }),
        })
        for (const s of docker.services ?? []) {
          services.push(s)
        }
        if (docker.services !== undefined) sawCompose = true
        // compose 过了但 static 没过（或反过来）都以 static 为准：
        // 只有一个 healthy 字段，合并的口径写死在这里，别让两处各判一次
        if (docker.services !== undefined && docker.services.length > 0 && !check.ok) {
          warnings.push('compose 的服务状态是好的，但 static 健康检查没过 —— 以 static 的结论为准')
        }
      } catch (err) {
        warnings.push(`读不到 compose 状态：${targetErrorFields(err).message}`)
      }
    }

    return {
      result: {
        ...base,
        healthy: check.ok,
        ...(check.ok ? {} : { reason: check.reason ?? '健康检查未通过' }),
        ...(services.length > 0 ? { services } : {}),
        ...(sawCompose ? { composeRead: true } : {}),
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
