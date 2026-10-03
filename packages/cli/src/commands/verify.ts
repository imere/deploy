/**
 * `dp verify` —— 只跑健康检查。
 *
 * 与 status 的区别在**退出码**：status 是报告事实（查到不健康也退出 0），
 * verify 是 CI 的一道闸（不健康就退出 2）。两者读同一份数据，但语义不同 ——
 * 混成一条命令会让「想知道情况」和「要不要卡住流水线」被迫二选一。
 */
import { readReleaseState, verifyRelease } from '@dp/target-static'
import { verifyDocker } from '@dp/target-docker'
import { DpError, type Runner, type TargetContext } from '@dp/ports'
import type { HostConfig, ProjectConfig } from '@dp/schema'
import { defaultApplyDeps } from '../deps.js'
import { dockerConfigFor } from '../docker-config.js'
import { exitCodeFor } from '../output.js'
import { renderOpsJson, renderOpsPretty, type VerifyResult } from '../output-ops.js'
import { selectTargets } from '../targets.js'
import { staticConfigFor } from '../target-config.js'
import { resolveTarget, targetErrorFields, type ResolvedTargetInput } from '../target-resolve.js'
import type { ResolvedFlags, RunContext } from '../run.js'
import type { LoadedConfig } from '../config-file.js'

export async function runVerify(context: RunContext, flags: ResolvedFlags): Promise<number> {
  const loaded: LoadedConfig = await context.loadConfig(flags)
  const targets = selectTargets({
    config: loaded.config,
    project: flags.project,
    host: flags.host,
    all: flags.all,
    env: flags.env,
  })

  const deps = context.deps ?? defaultApplyDeps()
  const results: VerifyResult[] = []
  let worst = 0

  for (const target of targets) {
    const logger = context.logger.child({ host: target.host })
    const { result, exitCode } = await verifyOne(context, deps, {
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
      ? renderOpsJson('verify', results)
      : results.map((r) => renderOpsPretty('verify', r)).join('\n\n'),
  )
  return worst
}

interface VerifyInput {
  readonly project: string
  readonly host: string
  readonly projectConfig: ProjectConfig
  readonly hostConfig: HostConfig
  readonly logger: ReturnType<RunContext['logger']['child']>
}

async function verifyOne(
  context: RunContext,
  deps: ResolvedTargetInput['deps'],
  input: VerifyInput,
  flags: ResolvedFlags,
): Promise<{ readonly result: VerifyResult; readonly exitCode: number }> {
  const { host, project, logger } = input
  const warnings: string[] = []
  let resolved: Awaited<ReturnType<typeof resolveTarget>> | undefined

  try {
    resolved = await resolveTarget({ context, target: input, deps, logger })
    const state = await readReleaseState(resolved.runner, resolved.releaseRoot)

    // 没部署过 → 验不了。报成功会让 CI 里的 verify 变成一盏永远绿的灯：
    // 「没东西可验」和「验过了没问题」在流水线里必须是两种结果
    if (state.current === undefined) {
      throw new DpError('DP.VERIFY.FAILED', `${host}:${project} 尚未部署过，没有可校验的 current`, {
        path: 'current',
        hint: '先跑一次 `dp apply` 部署出 current，再回来 verify',
      })
    }

    const ctx: TargetContext = {
      host,
      root: resolved.releaseRoot,
      releaseId: state.current,
      keep: resolved.keep,
      ...(state.previous !== undefined ? { previousReleaseId: state.previous } : {}),
    }
    const check = await verifyRelease(resolved.runner, ctx, staticConfigFor(input.projectConfig))

    // docker 目标：compose 的 ps 是**唯一**能证明服务真起来的手段
    // （static 的 fileExists 只看得到文件在不在，看不到容器状态）。
    // 两个都过才算过 —— 少跑一个就是给了一盏少一半的绿灯
    const dockerSpec = input.projectConfig.target?.docker
    if (dockerSpec !== undefined) {
      await verifyDocker({
        runner: resolved.runner,
        ctx,
        config: dockerConfigFor({
          project: input.project,
          env: flags.env ?? '',
          envVars: context.env,
          targetCtx: ctx,
          now: new Date(0),
          docker: dockerSpec,
        }),
        onStep: (step) => logger.info('verify.docker', { step: step.id, kind: step.kind }),
      })
    }

    if (!check.ok) {
      // 失败也要给一条能直接敲的下一步（docs/verify.md §6 的 onFailure 思路）：
      // 只说「不健康」而不说「现在该干什么」，等于把判断成本全推给用户
      throw new DpError('DP.VERIFY.FAILED', `健康检查未通过：${check.reason}`, {
        path: `releases/${state.current}`,
        hint: `检查 ${resolved.releaseRoot}/releases/${state.current} 的内容；确认要回退就跑 \`dp rollback --host ${host} --project ${project}\``,
      })
    }

    logger.info('verify.done', { releaseId: state.current })
    return {
      result: { host, project, releaseRoot: resolved.releaseRoot, releaseId: state.current, ok: true, warnings },
      exitCode: 0,
    }
  } catch (err) {
    const code = exitCodeFor(err)
    logger.error('verify.failed', { code: targetErrorFields(err).code })
    return {
      result: {
        host,
        project,
        releaseRoot: resolved?.releaseRoot ?? '',
        releaseId: resolved === undefined ? null : ((await safeCurrent(resolved)) ?? null),
        ok: false,
        warnings,
        error: targetErrorFields(err),
      },
      // 装配期失败（连不上、配置错）走各自既有码；健康检查不过固定是 2。
      // 这个映射**全在 exitCodeFor 里**，这里不做二次判断 —— 写
      // `code === 2 ? 2 : code` 这种恒等式只会让人以为这里另有规则
      exitCode: code,
    }
  } finally {
    await resolved?.close?.()
  }
}

/**
 * 失败路径上补一个 releaseId，方便人对着日志找版本。
 * 读不到就返回 null —— 这条只是锦上添花，不值得为它再抛一次错。
 */
async function safeCurrent(resolved: {
  readonly runner: Runner
  readonly releaseRoot: string
}): Promise<string | undefined> {
  try {
    return (await readReleaseState(resolved.runner, resolved.releaseRoot)).current
  } catch {
    return undefined
  }
}
