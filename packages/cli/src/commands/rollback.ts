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
   * 指针**已经切过去**的版本号；没切过就是 null。
   *
   * 指针先切、服务后起（见下面的顺序说明），所以「服务没起来」这类失败发生时
   * 指针已经是上一版了 —— 那是本次在机器上留下的改动，`needsHealing` 必须算上它，
   * 否则会报「机器上没有本次留下的东西」，而 current 明明动过了。
   */
  let switchedTo: string | null = null
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
    const targetCtx: TargetContext = {
      host,
      root: resolved.releaseRoot,
      releaseId: state.current,
      previousReleaseId: state.previous,
      keep: resolved.keep,
    }

    // ① **先切指针，② 再让目标侧重启服务**。
    //
    // 顺序只能这个方向，真机给的答案：三个「起服务」的目标跑的是**上一版目录里烘好的
    // 那份脚本**，而脚本里的路径是 `${release.current}` 那根软链 —— 软链在服务进程
    // 启动那一刻才被解析。先起服务、后切软链，起出来的是**新版本**的代码：命令报成功，
    // 线上跑的还是新版本。CI 的 process 场景就是这么红的（`回滚后还在提供新版本`）。
    //
    // 反过来担心的「指针退回去了但服务没起来」是另一种失败，而它**响**：服务起不来
    // 会抛错、needsHealing 为真；起来了但不对，末尾的 verify 也会红。上面那种错
    // 没有任何一层能发现。两种错只能选一个时，选会响的那个。
    const to = await rollback(resolved.runner, ctx, switchStrategyFor(input.projectConfig))
    switchedTo = to

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
          '。索引里 current 不在 releases 末尾时会出现这种情况',
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
    // 指针先切、服务后起，所以「切过指针」本身就是本次留在机器上的改动 ——
    // 即使目标侧一步都没走成也得算进去，否则会报「机器上没有本次留下的东西」，
    // 而 current 明明已经指到上一版了
    const touched = targetTouched(err) || switchedTo !== null
    if (touched) {
      warnings.push(
        '回滚已经在机器上留下改动（' +
          [
            switchedTo !== null ? `current 已切到 ${switchedTo}` : '',
            appliedTargets.length > 0 ? `${appliedTargets.join(' / ')} 已跑完` : '',
            appliedTargets.length === 0 ? '执行器在半途失败，已完成的那几步留在盘上' : '',
          ]
            .filter((s) => s !== '')
            .join('；') +
          '），随后失败 —— 需要人工核对后再决定是否继续回退',
      )
    }
    return {
      result: {
        host,
        project,
        releaseRoot: resolved?.releaseRoot ?? '',
        from,
        to: switchedTo,
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
