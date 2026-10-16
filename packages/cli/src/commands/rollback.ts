/**
 * `dp rollback` —— 把 current 指回上一版。
 *
 * 唯一的写命令，也是三条新命令里唯一没有 `--dry-run` 的一条：回滚要么做要么不做，
 * 「演练一次回滚」没有对应语义 —— 演练本身就是切一次。
 *
 * 职责边界很清楚：**只切换，不清理**。删版本是 apply 里 prune 的活，理由见
 * target-static 的 prune 注释：上一版是被保护的版本，把清理混进回滚，
 * 一次失败的回滚就可能顺手毁掉唯一的退路。
 */
import { readReleaseState, rollback, verifyRelease } from '@dp/target-static'
import { isDockerExecFailure, rollbackDocker } from '@dp/target-docker'
import { isProcessExecFailure, rollbackProcess } from '@dp/target-process'
import { isSystemdExecFailure, rollbackSystemd } from '@dp/target-systemd'
import { DpError, type TargetContext } from '@dp/ports'
import type { HostConfig, ProjectConfig } from '@dp/schema'
import { defaultApplyDeps } from '../deps.js'
import { dockerConfigFor } from '../docker-config.js'
import { processConfigFor } from '../process-config.js'
import { resolveUnitDir, systemdConfigFor } from '../systemd-config.js'
import { EXIT_FAILURE, EXIT_VERIFY_FAILED, exitCodeFor } from '../output.js'
import { renderOpsJson, renderOpsPretty, type RollbackResult } from '../output-ops.js'
import { selectTargets } from '../targets.js'
import { staticConfigFor, switchStrategyFor } from '../target-config.js'
import { resolveTarget, targetErrorFields, type ResolvedTargetInput } from '../target-resolve.js'
import type { ResolvedFlags, RunContext } from '../run.js'
import type { LoadedConfig } from '../config-file.js'

export async function runRollback(context: RunContext, flags: ResolvedFlags): Promise<number> {
  const loaded: LoadedConfig = await context.loadConfig(flags)
  const targets = selectTargets({
    config: loaded.config,
    project: flags.project,
    host: flags.host,
    all: flags.all,
    env: flags.env,
  })

  const deps = context.deps ?? defaultApplyDeps()
  const results: RollbackResult[] = []
  let worst = 0

  for (const target of targets) {
    const logger = context.logger.child({ host: target.host })
    const { result, exitCode } = await rollbackOne(context, deps, {
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
      ? renderOpsJson('rollback', results)
      : results.map((r) => renderOpsPretty('rollback', r)).join('\n\n'),
  )
  return worst
}

interface RollbackInput {
  readonly project: string
  readonly host: string
  readonly projectConfig: ProjectConfig
  readonly hostConfig: HostConfig
  readonly logger: ReturnType<RunContext['logger']['child']>
}

async function rollbackOne(
  context: RunContext,
  deps: ResolvedTargetInput['deps'],
  input: RollbackInput,
  flags: ResolvedFlags,
): Promise<{ readonly result: RollbackResult; readonly exitCode: number }> {
  const { host, project, logger } = input
  const warnings: string[] = []
  /** 目标侧**成功返回**过的目标名。顺序等于「机器上已经被改过哪些东西」 */
  const appliedTargets: string[] = []
  let resolved: Awaited<ReturnType<typeof resolveTarget>> | undefined
  let from: string | null = null
  /**
   * 失败之前，目标侧有没有真的在机器上留下过改动。
   *
   * 两条路都得算：① 某个目标的回滚**成功返回**了（appliedTargets）—— 它干完才轮到下一个；
   * ② 某个目标的回滚跑了几步之后**自己炸了** —— 那几步的结论一样在盘上
   * （unit 已还原、进程已停），只是后面的步骤没走到。只认①的话，「unit 换了但 restart
   * 失败」会被报成 needsHealing: false，而那台机器上明显有件回滚了的 unit 需要人看一眼。
   *
   * 判据取自执行器自己的步骤轨迹（`ok` 且非 `skipped` = 在机器上留下了作用），
   * 而不是在 CLI 里重推一遍「这一步大概做了什么」—— 重推等于又写一份。
   */
  const targetTouched = (err: unknown): boolean => {
    if (appliedTargets.length > 0) return true
    const cause = err instanceof Error ? err.cause : undefined
    const applied = (steps: readonly { readonly ok: boolean; readonly skipped: boolean }[]): boolean =>
      steps.some((s) => s.ok && !s.skipped)
    if (isDockerExecFailure(cause)) return applied(cause.steps)
    if (isSystemdExecFailure(cause)) return applied(cause.steps)
    if (isProcessExecFailure(cause)) return applied(cause.steps)
    return false
  }

  try {
    resolved = await resolveTarget({ context, target: input, deps, logger })
    const state = await readReleaseState(resolved.runner, resolved.releaseRoot)
    from = state.current ?? null

    // 没有上一版就别动 current。target-static 的 rollback() 也会拒，但那时
    // 已经读过一遍索引了；在这里先拒能让错误文案带上完整的项目/主机上下文
    if (state.current === undefined || state.previous === undefined) {
      throw new DpError('DP.VERIFY.FAILED', `${host}:${project} 没有可回退的版本`, {
        path: 'current',
        hint:
          state.current === undefined
            ? '尚未部署过，没有历史版本可回退'
            : `当前只有 ${state.releases.length} 个版本（${state.releases.join(' | ')}），至少要有两个才能回退`,
      })
    }

    // releaseId 填的是**本次要激活的版本**。rollback() 本身不从这里取目标
    // （它自己读索引），这里填它是为了让 ctx 对步骤与日志如实描述这次动作。
    // 传 current 会让日志出现「回滚到当前版本」这种自相矛盾的行
    const ctx: TargetContext = {
      host,
      root: resolved.releaseRoot,
      releaseId: state.previous,
      previousReleaseId: state.current,
      keep: resolved.keep,
    }

    logger.info('rollback.begin', { from: state.current, to: state.previous })

    // **ctx 的语义要按目标侧执行器的读法重建一遍**：
    // 上面那个 ctx（给 static 的 rollback 用）里 previousReleaseId = state.current ——
    // 那正是 static 的语义（从 current 退到 previous）。而下面三个执行器都把
    // previousReleaseId 读成「要退回的那一版」，直接传下去会让它们拿**当前版本**的
    // compose / 上一份 unit / 上一版脚本重跑一遍 —— 那不是回滚，而且报告会显示成功。
    //
    // 目标侧全部**先于**切 current：反过来（先切 current 再让目标侧退）会在它们失败时
    // 留下一份指向新版本、而服务还停在新版本的状态 —— 指针与实际服务对不上，
    // 而 current 已经是旧的了，排查者会以为服务已经退回去了
    const targetCtx: TargetContext = {
      host,
      root: resolved.releaseRoot,
      releaseId: state.current,
      previousReleaseId: state.previous,
      keep: resolved.keep,
    }

    const dockerSpec = input.projectConfig.target?.docker
    if (dockerSpec !== undefined) {
      // state.previous 已经过了上面的判定，这里必然存在。
      // **不吞它的错误**：没有上一版时执行器抛 DP.DOCKER.NO_PREVIOUS，
      // 把它报成「回滚成功」是本仓最不能接受的一种假结果
      await rollbackDocker({
        runner: resolved.runner,
        ctx: targetCtx,
        config: dockerConfigFor({
          project: input.project,
          env: flags.env ?? '',
          envVars: context.env,
          targetCtx,
          now: new Date(0),
          docker: dockerSpec,
        }),
        onStep: (step) => logger.info('rollback.docker', { step: step.id, kind: step.kind }),
      })
      appliedTargets.push('docker')
    }

    // systemd：靠 `<unit>.dp-backup` 还原上一份 unit，执行器自己管那个备份。
    // 所以它要的是**目标机上还留着的上一份 unit**，而不是 releaseId ——
    // 这里只保证它算出与 apply 时同一个 unitDir，否则它会去还原另一个文件
    const systemdSpec = input.projectConfig.target?.systemd
    if (systemdSpec !== undefined) {
      const unitDir = resolveUnitDir({
        facts: resolved.facts,
        ...(input.projectConfig.target !== undefined ? { target: input.projectConfig.target } : {}),
      })
      await rollbackSystemd({
        runner: resolved.runner,
        ctx: targetCtx,
        config: systemdConfigFor({
          project: input.project,
          env: flags.env ?? '',
          envVars: context.env,
          targetCtx,
          now: new Date(0),
          systemd: systemdSpec,
          unitDir,
        }),
        onStep: (step) => logger.info('rollback.systemd', { step: step.id, kind: step.kind }),
      })
      appliedTargets.push('systemd')
    }

    // process：靠**上一版目录里那份启动脚本**起回来（脚本在渲染期就把 command /
    // 参数 / 工作目录烘进去了，所以跑上一版的脚本才是「回到那个版本」）。
    // 没有备份可退时执行器抛 DP.PROC.NO_PREVIOUS —— 版本被 prune 掉的现场必须报出来，
    // 起一个空的等于报告了一次从未存在过的服务
    const processSpec = input.projectConfig.target?.process
    if (processSpec !== undefined) {
      await rollbackProcess({
        runner: resolved.runner,
        ctx: targetCtx,
        config: processConfigFor({
          project: input.project,
          env: flags.env ?? '',
          envVars: context.env,
          targetCtx,
          now: new Date(0),
          process: processSpec,
        }),
        onStep: (step) => logger.info('rollback.process', { step: step.id, kind: step.kind }),
      })
      appliedTargets.push('process')
    }

    const to = await rollback(resolved.runner, ctx, switchStrategyFor(input.projectConfig))

    // 实测结果与预期对不上，必须报出来。
    //
    // `rollback()` 在索引里有 ≥2 个版本时取的是 **releases 的倒数第二个**，
    // 而本命令的「上一版」是 **current 在 releases 里的前一个位置**。current 是
    // 最后一个时两者一致；current 落在中间时（部署 r1/r2/r3 → 回滚一次 → current=r2）
    // 就不一致 —— 第二次回滚会取到 current 自己，于是「报成功但一个指针都没动」，
    // 而用户以为又退了一版。这是正常操作就能走到的状态，不是理论边界。
    if (to !== state.previous) {
      warnings.push(
        `回滚目标与预期不一致：预期 ${state.previous}，实际切到 ${to}` +
          (to === state.current ? '（等于当前版本，等于没切）' : '') +
          `。索引里 current 不在 releases 末尾时会出现这种情况`,
      )
      logger.error('rollback.inconsistent', { expected: state.previous, actual: to })
      return {
        result: {
          host,
          project,
          releaseRoot: resolved.releaseRoot,
          from: state.current,
          to,
          needsHealing: to !== state.current,
          warnings,
          error: {
            code: 'DP.STATE.INCONSISTENT',
            message:
              `回滚目标与预期不一致：预期回退到 ${state.previous}，实际切到 ${to}` +
              (to === state.current ? '（与当前版本相同，没有发生切换）' : ''),
            hint:
              `索引 releases = [${state.releases.join(' | ')}]，current = ${state.current}。` +
              'current 不在末尾时「上一版」有两种读法，本命令按位置取（current 的前一个）。' +
              `要回到某个具体版本就手动把 current 指过去：${resolved.releaseRoot}/releases/<id>`,
          },
        },
        exitCode: EXIT_FAILURE,
      }
    }

    // 回滚后**再验一次**：切过去不等于能用。只切不验的话，一个同样坏掉的
    // 上一版会被无声地切上去，而命令报成功 —— 这正是 verify 存在的理由
    const check = await verifyRelease(
      resolved.runner,
      { ...ctx, releaseId: to },
      staticConfigFor(input.projectConfig),
    )

    if (!check.ok) {
      // 到这一步 current 已经切过去了。此时再自动切回去等于在一个已知不健康的
      // 状态上做第二次未经确认的变更 —— 反而更难排查。明确报出来让人决定
      warnings.push(
        `已切回 ${to}，但它健康检查不过：${check.reason}。需要人工介入确认环境，未再自动切换`,
      )
      logger.error('rollback.needs_healing', { to, reason: check.reason })
      return {
        result: {
          host,
          project,
          releaseRoot: resolved.releaseRoot,
          from,
          to,
          needsHealing: true,
          warnings,
          error: {
            code: 'DP.VERIFY.FAILED',
            message: `已切回 ${to}，但它健康检查不过，需要人工介入：${check.reason}`,
            hint: `人工确认 ${resolved.releaseRoot}/releases/ 下哪个版本可用，然后手动把 current 指过去`,
          },
        },
        exitCode: EXIT_VERIFY_FAILED,
      }
    }

    logger.info('rollback.done', { from, to })
    return {
      result: { host, project, releaseRoot: resolved.releaseRoot, from, to, needsHealing: false, warnings },
      exitCode: 0,
    }
  } catch (err) {
    logger.error('rollback.failed', { code: targetErrorFields(err).code, from, appliedTargets })
    const touched = targetTouched(err)
    // 目标侧一旦留下过改动，current 指向哪已经无法从这里判定，所以 `to` 保持 null，
    // 由 needsHealing 承担「要有人上机器看一眼」这件事 —— 写 false 等于用整条命令的失败
    // 掩盖了一次已经发生的、只有一半的回滚
    if (touched) {
      warnings.push(
        '目标侧的回滚已经改动了机器（' +
          (appliedTargets.length > 0 ? `${appliedTargets.join(' / ')} 已跑完` : '执行器在半途失败，已完成的那几步留在盘上') +
          '），随后失败 —— current 是否被切换过无法从这里判定，需要人工核对后再决定是否继续回退',
      )
    }
    return {
      result: {
        host,
        project,
        releaseRoot: resolved?.releaseRoot ?? '',
        from,
        to: null,
        needsHealing: touched,
        warnings,
        error: targetErrorFields(err),
      },
      exitCode: exitCodeFor(err),
    }
  } finally {
    await resolved?.close?.()
  }
}
