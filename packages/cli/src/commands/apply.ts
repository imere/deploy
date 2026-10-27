/**
 * `dp apply` —— 真部署。**默认真执行**。
 *
 * 为什么不做成「默认干跑 + --yes 才真做」：那种设计的安全感来自「人会在确认
 * 提示前看一眼」，而铁律 0 明确不许交互 —— 没有确认环节，这层安全感就是假的，
 * 假安全感比明着默认执行更危险。所以方向反过来：apply 一定真做，想先看清楚
 * 就跑 `dp plan` 或 `dp apply --dry-run`，那两个都保证零副作用。
 *
 * 本文件只留编排；执行器的运行形态在 ./apply-assembly.ts，结果段在
 * ./apply-reports.ts，失败文案在 ./apply-failures.ts。
 */
import { makePlan } from '@dp/core'
import { listSourceEntries, normalizeSourceSpec } from '@dp/local'
import { ERR, DpError, type Step, type TargetContext } from '@dp/ports'
import type { Config } from '@dp/schema'
import { activateDocker, installDocker, verifyDocker, type DockerExecResult } from '@dp/target-docker'
import { activateNginx, installNginx, type NginxExecResult } from '@dp/target-nginx'
import { activateProcess, installProcess, verifyProcess, type ProcessExecResult } from '@dp/target-process'
import { activateSystemd, installSystemd, verifySystemd, type SystemdExecResult } from '@dp/target-systemd'
import { deploy, rollback } from '@dp/target-static'
import type { LoadedConfig } from '../config-file.js'
import { defaultApplyDeps, type ApplyDeps } from '../deps.js'
import { readFactsFile } from '../facts-source.js'
import { exitCodeFor, renderApplyJson, renderApplyPretty, type ApplyTargetResult } from '../output.js'
import { releaseIdFor } from '../release-id.js'
import { selectTargets } from '../targets.js'
import { staticConfigFor } from '../target-config.js'
import { resolveTarget, targetErrorFields } from '../target-resolve.js'
import type { ResolvedFlags, RunContext } from '../run.js'
import {
  type ApplyTargetInput,
  dockerRunFor,
  makeTransferHook,
  nginxRunFor,
  processRunFor,
  systemdRunFor,
  withParentDirs,
} from './apply-assembly.js'
import {
  activateFailedWarning,
  dockerFailureWarning,
  healingWarning,
  pickWorstError,
  processFailureWarning,
  systemdFailureWarning,
} from './apply-failures.js'
import {
  dockerReport,
  nginxReport,
  processReport,
  renderPlanBody,
  systemdReport,
} from './apply-reports.js'

/**
 * `runApply` 的配置来源与自动决定说明。
 *
 * 做成入参而不是新建一个命令，是因为零配置与配置文件**必须共用同一条执行链**：
 * 在 deploy 里另写一套编排，两条链迟早各自演化，而「同一份 target 在两条链上
 * 行为不同」是最难发现的一类 bug。
 */
export interface ApplyOptions {
  /**
   * 内存里装配好的配置。给了它就**不**再调 `loadConfig`。
   * 零配置没有配置文件，配置只在内存中：落一份用户没要过的配置文件等于替他决定
   * 「以后这个项目按这份配置部署」。
   */
  readonly config?: Config
  /** 自动决定的说明，逐条带进预览输出。`--json` 时走日志，不混进 stdout */
  readonly notes?: readonly string[]
}

export async function runApply(
  context: RunContext,
  flags: ResolvedFlags,
  options: ApplyOptions = {},
): Promise<number> {
  const started = new Date()
  const loaded: LoadedConfig = options.config !== undefined
    ? { config: options.config, path: '(零配置)', source: 'explicit' }
    : await context.loadConfig(flags)

  // 「自动不等于静默」：自动决定的事实在执行**之前**就要摆出来。
  // --json 时 stdout 只能有结果 JSON，所以走日志（它会自动落到 stderr）
  if (options.notes !== undefined && options.notes.length > 0) {
    if (flags.json) {
      context.logger.info('apply.notes', { notes: options.notes })
    } else {
      context.out(['自动决定：', ...options.notes.map((n) => `  · ${n}`)].join('\n'))
    }
  }

  const targets = selectTargets({
    config: loaded.config,
    project: flags.project,
    host: flags.host,
    all: flags.all,
    env: flags.env,
  })

  const results: ApplyTargetResult[] = []
  let worst = 0

  for (const target of targets) {
    const logger = context.logger.child({ host: target.host })
    const result = await applyOne(context, flags, {
      project: target.project,
      host: target.host,
      projectConfig: target.projectConfig,
      hostConfig: target.hostConfig,
      logger,
      now: started,
    })
    results.push(result.result)
    // 多目标时取更严重的那次：任一目标失败就不能报成功
    worst = Math.max(worst, result.exitCode)
  }

  context.out(flags.json ? renderApplyJson(results) : results.map(renderApplyPretty).join('\n\n'))
  return worst
}

async function applyOne(
  context: RunContext,
  flags: ResolvedFlags,
  target: ApplyTargetInput,
): Promise<{ readonly result: ApplyTargetResult; readonly exitCode: number }> {
  const { host, logger, project } = target
  const deps: ApplyDeps = context.deps ?? defaultApplyDeps()
  const releaseId = releaseIdFor(project, target.now)

  /** 部署前先把「将要发生什么」摆出来：人肉看日志和 CI 抓日志靠它对账 */
  const announce = (root: string, files: number): void => {
    logger.info('apply.begin', { project, releaseRoot: root, releaseId, files })
    // --json 时 stdout 必须是纯 JSON，这行只能走日志（它会自动落到 stderr）
    if (!flags.json) {
      context.out(`即将部署 ${project} → ${host}\n  发布根 ${root}\n  releaseId ${releaseId}\n  文件数 ${files}`)
    }
  }

  /** 执行器的逐步回调统一成一处：三个字段原样进日志，事件名由调用处给 */
  const onStep =
    (event: string) =>
    (step: Step): void => {
      logger.info(event, { step: step.id, kind: step.kind, title: step.title })
    }

  // 源清单与 facts 都在 try **里面**：装配期的失败（source 空、配置错、连不上）
  // 也必须是 ApplyTargetResult 里的一个 error，而不是抛到 main 的通用错误处理。
  // 否则 `--json` 失败时 stdout 会是空的 —— CI 里 `dp apply --json > r.json`
  // 拿到一个空文件，等于机器可读模式在最需要它的那一刻失效。
  let resolved: Awaited<ReturnType<typeof resolveTarget>> | undefined
  let exitCode = 0
  let result: ApplyTargetResult

  try {
    // ① 源清单先枚举：它只读本地文件系统，出问题时用户还没付任何代价
    const spec = normalizeSourceSpec(target.projectConfig.source.root, context.cwd)
    const rawEntries = await listSourceEntries(spec)
    if (rawEntries.length === 0) {
      throw new DpError(ERR.SOURCE.EMPTY, `项目 ${project} 的 source 是空的：${spec.root}`, {
        path: `projects.${project}.source`,
        hint: '构建产物为空，或 include/exclude 把所有文件都排除了。注意 "./dist" 与 "./dist/**" 的区别',
      })
    }
    const entries = withParentDirs(rawEntries)
    const fileCount = rawEntries.filter((e) => e.kind === 'file').length

    // ② Facts + Runner + 发布根。**复用 resolveTarget** —— status / verify /
    //    rollback 走同一条装配路径，规则只有这一份实现（否则会出现「apply 部署
    //    到 A、status 查到 B」这种最难查的分叉）。
    //    --facts 提供夹具时完全离线，此时没有连接、也就没有 runner
    resolved = await resolveTarget({
      context,
      target,
      deps,
      logger,
      ...(flags.factsFile !== undefined ? { factsOverride: await readFactsFile(flags.factsFile) } : {}),
    })

    const plan = makePlan({
      name: project,
      project: target.projectConfig,
      facts: resolved.facts,
      releaseId,
      sourceEntries: entries.map((e) => e.relativePath),
      ...(target.hostConfig.layout !== undefined ? { layout: target.hostConfig.layout } : {}),
    })

    // ctx 提前到这里：nginx 的 install 阶段要它（渲染上下文里的 release.current 来自它），
    // 而 install 必须在 deploy **之前**跑。放在原处会让 nginx 阶段拿到未定义的值
    const ctx: TargetContext = {
      host,
      root: plan.releaseRoot,
      releaseId,
      keep: resolved.keep,
    }

    // nginx 装配。confd 推导不出会在这里抛（DP.PERM.CONFD_NOT_WRITABLE），
    // 发生时机是「一个字节都还没写」，所以它属于装配期失败而不是部署失败
    const nginx = nginxRunFor(target, ctx, flags.env ?? '', context.env, target.now, resolved.facts)
    const docker = dockerRunFor(target, ctx, flags.env ?? '', context.env, target.now)
    // unitDir 推导同理：DP.PERM.UNIT_DIR_NOT_WRITABLE 也发生在装配期，一个字节都没写
    const systemd = systemdRunFor(target, ctx, flags.env ?? '', context.env, target.now, resolved.facts)
    const process = processRunFor(target, ctx, flags.env ?? '', context.env, target.now)

    // ④ --dry-run：算完就停，一个字节都不写
    if (flags.dryRun) {
      announce(plan.releaseRoot, fileCount)
      // nginx 走**真**执行器的 dryRun：影子校验需要盘上的文件才能跑，跑完再撤掉。
      // 跳掉它报个成功，等于把「这份 conf 到底能不能过 -t」这件事藏起来
      const dryRuns: NginxExecResult[] = []
      if (nginx !== undefined) {
        dryRuns.push(
          await installNginx({
            runner: resolved.runner,
            ctx,
            config: nginx.config,
            dryRun: true,
            onStep: onStep('apply.nginx.install'),
          }),
        )
        // activate 也走一遍：它只读现有 conf 做所有权判定，不写盘。
        // 跳过它就报成功，等于把「这份文件现在能不能被替换」藏起来了
        dryRuns.push(
          await activateNginx({
            runner: resolved.runner,
            ctx,
            config: nginx.config,
            dryRun: true,
            onStep: onStep('apply.nginx.activate'),
          }),
        )
      }
      // docker 侧：install 的 stat 照跑（文件在不在是真的），pull / up 不跑，
      // ps 照跑（只读，结论是真的）。执行器自己按「在机器上有没有留下作用」记 skipped
      const dockerDryRuns: DockerExecResult[] = []
      const dockerDryRunWarnings: string[] = []
      if (docker !== undefined) {
        // dry-run 没部署，所以 release 目录里**本来就没有** compose 文件 ——
        // install 的 stat 必然失败，而那不是配置错误，是「什么都没做」的正常结果。
        // 把它当致命错会让 --dry-run 第一次跑必红，于是没人再跑它；
        // 当成成功又会谎报「文件都在」。所以：如实说出来，然后继续跑 ps
        // （那是真正有价值的只读信息：现在线上跑的是哪一版）
        try {
          dockerDryRuns.push(
            await installDocker({
              runner: resolved.runner,
              ctx,
              config: docker.config,
              dryRun: true,
              onStep: onStep('apply.docker.install'),
            }),
          )
        } catch (err) {
          const f = targetErrorFields(err)
          if (f.code !== ERR.DOCKER.FILE_MISSING) throw err
          dockerDryRunWarnings.push(
            `DP.DOCKER.FILE_MISSING（--dry-run 预期如此）：${f.message}。` +
              '--dry-run 不部署，所以这些文件现在还不在盘上；真跑 dp apply 时它们随 release 一起上传',
          )
        }
        dockerDryRuns.push(
          await activateDocker({
            runner: resolved.runner,
            ctx,
            config: docker.config,
            dryRun: true,
            onStep: onStep('apply.docker.activate'),
          }),
        )
        // verify 也走一遍：ps 是只读的，dry-run 跑它给出的结论是真的。
        // wait: false 时它更是唯一一道关 —— dry-run 跳过它就等于藏起了
        // 「新版本起来之后服务到底是不是活的」这个唯一能回答的问题
        dockerDryRuns.push(
          await verifyDocker({
            runner: resolved.runner,
            ctx,
            config: docker.config,
            dryRun: true,
            onStep: onStep('apply.docker.verify'),
          }),
        )
      }
      // systemd 走**真**执行器的 dryRun：影子校验（`systemd-analyze verify`）是只读的，
      // 它给的结论是真的；写进去的候选随即被撤销，执行器自己记 skipped。
      // 跳掉它报个成功，等于把「这份 unit 到底起不起来」藏起来
      const systemdDryRuns: SystemdExecResult[] = []
      const systemdDryRunWarnings: string[] = []
      if (systemd !== undefined) {
        systemdDryRuns.push(
          await installSystemd({
            runner: resolved.runner,
            ctx,
            config: systemd.config,
            dryRun: true,
            onStep: onStep('apply.systemd.install'),
          }),
        )
        // activate 的备份/替换/reload/restart 在 dryRun 下全部 skipped，但所有权判定照跑 ——
        // 跳过它就报成功，等于把「这份 unit 现在能不能被替换」藏起来了
        systemdDryRuns.push(
          await activateSystemd({
            runner: resolved.runner,
            ctx,
            config: systemd.config,
            dryRun: true,
            onStep: onStep('apply.systemd.activate'),
          }),
        )
        // verify 照跑：`is-active` 只读，而它回答的是「服务现在活着吗」。
        // 但它报的是**部署前**的状态（dryRun 什么都没部署），所以不通过时
        // 记成告警而不是错误 —— 报成错误会让 --dry-run 在任何还没部署过的机器上必红，
        // 于是没人再跑它；而那条信息本身仍然如实说出来了
        try {
          systemdDryRuns.push(
            await verifySystemd({
              runner: resolved.runner,
              ctx,
              config: systemd.config,
              dryRun: true,
              onStep: onStep('apply.systemd.verify'),
            }),
          )
        } catch (err) {
          systemdDryRunWarnings.push(
            `DP.SYSD.NOT_ACTIVE（--dry-run 只报告部署前的状态）：${targetErrorFields(err).message}。` +
              '--dry-run 没有部署也没有重启服务，所以这是这台机器现在的状态，不是本次部署的结论',
          )
        }
      }
      // process 侧：install 把脚本写进版本目录再撤掉，activate 在 dryRun 下
      // 既不真停也不真起（停进程不可撤销）。执行器按「机器上有没有留下作用」记 skipped
      const processDryRuns: ProcessExecResult[] = []
      const processDryRunWarnings: string[] = []
      if (process !== undefined) {
        processDryRuns.push(
          await installProcess({
            runner: resolved.runner,
            ctx,
            config: process.config,
            dryRun: true,
            onStep: onStep('apply.process.install'),
          }),
        )
        processDryRuns.push(
          await activateProcess({
            runner: resolved.runner,
            ctx,
            config: process.config,
            dryRun: true,
            onStep: onStep('apply.process.activate'),
          }),
        )
        // 同 systemd 的 verify：只读，结论真实，但描述的是部署前的现场，所以记告警
        try {
          processDryRuns.push(
            await verifyProcess({
              runner: resolved.runner,
              ctx,
              config: process.config,
              dryRun: true,
              onStep: onStep('apply.process.verify'),
            }),
          )
        } catch (err) {
          processDryRunWarnings.push(
            `DP.PROC.NOT_RUNNING（--dry-run 只报告部署前的状态）：${targetErrorFields(err).message}。` +
              '--dry-run 没有启动任何进程，所以这是这台机器现在的状态，不是本次部署的结论',
          )
        }
      }
      // --json 时 stdout 只能有那一个 JSON 文档，正文走日志
      if (flags.json) {
        logger.info('apply.dry_run', { releaseId, steps: plan.steps.length, wrote: false })
      } else {
        context.out(`\n${renderPlanBody(plan)}`)
      }
      result = {
        project,
        host,
        releaseId,
        filesWritten: 0,
        rolledBack: false,
        warnings: [...dockerDryRunWarnings, ...systemdDryRunWarnings, ...processDryRunWarnings],
        steps: plan.steps.map((s) => ({ id: s.id, kind: s.kind, ok: true })),
        probeNotes: resolved.probeNotes,
        dryRun: true,
        ...(nginx !== undefined ? { nginx: nginxReport(nginx.confd, dryRuns) } : {}),
        // install 没跑成时不造 docker 段：空段等于声称「拉过了、起过了」
        ...(docker !== undefined && dockerDryRuns.length > 0 ? { docker: dockerReport(dockerDryRuns, docker) } : {}),
        // install 一定跑成（失败即抛，走不到这里），所以这里无条件造段
        ...(systemd !== undefined ? { systemd: systemdReport(systemdDryRuns, systemd.unitDir) } : {}),
        ...(process !== undefined ? { process: processReport(processDryRuns) } : {}),
      }
      return { result, exitCode: 0 }
    }

    announce(plan.releaseRoot, fileCount)

    // ⑤ 真执行。previousReleaseId **不填** —— deploy() 自己从索引里读，
    //    重复造一遍只会制造两个可能不一致的来源。

    // 远端改走传输层，本地保持逐条 writeFile —— 见 makeTransferHook 的说明
    const transferHook =
      target.hostConfig.local === true
        ? undefined
        : await makeTransferHook({
            context,
            deps,
            logger,
            hostConfig: target.hostConfig,
            host,
            spec,
            entries,
            releaseRoot: plan.releaseRoot,
            releaseId,
            remoteFacts: resolved.facts,
          })

    // ⑥ nginx / systemd install：**都先于 deploy**。
    // 失败时一个字节都还没写进 confd / unitDir、更没碰发布根，所以直接按该错误码退，
    // 不跑 deploy、也不回滚（没有东西可回滚）
    const nginxResults: NginxExecResult[] = []
    if (nginx !== undefined) {
      nginxResults.push(
        await installNginx({
          runner: resolved.runner,
          ctx,
          config: nginx.config,
          onStep: onStep('apply.nginx.install'),
        }),
      )
    }

    // systemd 的 install 与 nginx 同款：只写影子目录 + `systemd-analyze verify`，
    // 完全不碰 unitDir 里正在生效的 unit。顺序理由见 systemdRunFor 的注释
    const systemdResults: SystemdExecResult[] = []
    if (systemd !== undefined) {
      systemdResults.push(
        await installSystemd({
          runner: resolved.runner,
          ctx,
          config: systemd.config,
          onStep: onStep('apply.systemd.install'),
        }),
      )
    }

    let deployed: Awaited<ReturnType<typeof deploy>>
    try {
      deployed = await deploy({
        runner: resolved.runner,
        ctx,
        entries,
        config: staticConfigFor(target.projectConfig),
        ...(transferHook !== undefined ? { transfer: transferHook } : {}),
        onStep: onStep('apply.step'),
      })
    } catch (err) {
      // ── 失败处理 ────────────────────────────────────────────────
      // deploy() 在 DP.VERIFY.FAILED 上**已经**把 current 指回上一版了
      // （见 target-static 的 verify 分支），所以这里绝不能再 rollback 一次 ——
      // 那会连退两版，把本来还能用的版本也换掉。
      const alreadyCompensated = err instanceof DpError && err.code === ERR.VERIFY.FAILED
      const warnings: string[] = []
      let rolledBack = alreadyCompensated
      let needsHealing = false
      let rbExit = 0

      if (!alreadyCompensated) {
        try {
          await rollback(resolved.runner, ctx)
          rolledBack = true
        } catch (rbErr) {
          needsHealing = true
          rbExit = exitCodeFor(rbErr)
          warnings.push(healingWarning(plan.releaseRoot, rbErr))
        }
      } else {
        warnings.push('本次已由 deploy 自动回退到上一版')
      }

      logger.error('apply.failed', { code: targetErrorFields(err).code, rolledBack, needsHealing })
      const mapped = exitCodeFor(err)
      // needsHealing 取更严重的那次：回滚也失败意味着环境已经不只是「这次没成」
      exitCode = needsHealing ? Math.max(mapped, rbExit) : mapped
      result = {
        project,
        host,
        releaseId,
        filesWritten: 0,
        rolledBack,
        warnings,
        steps: [],
        probeNotes: resolved.probeNotes,
        dryRun: false,
        error: targetErrorFields(err),
        ...(needsHealing ? { needsHealing: true } : {}),
      }
      return { result, exitCode }
    }

    for (const w of deployed.warnings) logger.warn('apply.warning', { warning: w })

    // ⑦ nginx activate：**后于 deploy**。此时 current 已指向新版本，conf 里的
    // ${release.current} 软链正好服务新内容
    let nginxError: { code: string; message: string; path?: string; hint?: string } | undefined
    /** 保留原对象：退出码由 exitCodeFor 按错误码映射，只留结构化副本就映射不了 */
    let nginxCause: unknown
    if (nginx !== undefined) {
      try {
        nginxResults.push(
          await activateNginx({
            runner: resolved.runner,
            ctx,
            config: nginx.config,
            onStep: onStep('apply.nginx.activate'),
          }),
        )
      } catch (err) {
        // 执行器**已经**把 conf 还原并重新 -t 过了，所以这里不回滚 release。
        // 退出码取这个错误的映射：发布了但 conf 没换，不能报成功
        nginxError = targetErrorFields(err)
        nginxCause = err
        logger.error('apply.nginx.failed', { code: nginxError.code })
      }
    }

    const nginxSection = nginx === undefined ? undefined : nginxReport(nginx.confd, nginxResults)

    // ⑦ systemd activate + verify：**在 deploy 之后**。此时 current 已指向新版本，
    // unit 里的 ${release.current} 软链正好服务新内容。
    // 失败不回滚 release，理由与 nginx activate 同款：版本本身是好的，
    // 为了一份 unit 的问题退掉一次成功的发布，只会把两件独立的事绑成一次失败。
    // 执行器也不做补偿（unit 已落盘且已 daemon-reload，退回去也换不回服务）
    let systemdCause: unknown
    if (systemd !== undefined) {
      try {
        systemdResults.push(
          await activateSystemd({
            runner: resolved.runner,
            ctx,
            config: systemd.config,
            onStep: onStep('apply.systemd.activate'),
          }),
        )
        // verify 排在 activate 之后：restart 返回 0 只说明命令发出去了，
        // 服务随后自己退掉时退出码仍是 0，is-active 才是「活着吗」的唯一答案
        systemdResults.push(
          await verifySystemd({
            runner: resolved.runner,
            ctx,
            config: systemd.config,
            onStep: onStep('apply.systemd.verify'),
          }),
        )
      } catch (err) {
        systemdCause = err
        logger.error('apply.systemd.failed', { code: targetErrorFields(err).code })
      }
    }

    const systemdSection = systemd === undefined ? undefined : systemdReport(systemdResults, systemd.unitDir)

    // ⑦ process：**install 在 deploy 之后**，activate 再其后，verify 最后。
    // 顺序理由见 processRunFor 的注释：脚本写在 deploy 造出来的版本目录里。
    const processResults: ProcessExecResult[] = []
    /** 保留原对象：退出码由 exitCodeFor 按错误码映射，只留结构化副本就映射不了 */
    let processCause: unknown
    if (process !== undefined) {
      try {
        processResults.push(
          await installProcess({
            runner: resolved.runner,
            ctx,
            config: process.config,
            onStep: onStep('apply.process.install'),
          }),
        )
        processResults.push(
          await activateProcess({
            runner: resolved.runner,
            ctx,
            config: process.config,
            onStep: onStep('apply.process.activate'),
          }),
        )
        // verify 排在 activate 之后：start 脚本立即返回，进程随后自己退掉时退出码仍是 0，
        // kill -0 才是唯一能证明「服务真的活着」的那条命令
        processResults.push(
          await verifyProcess({
            runner: resolved.runner,
            ctx,
            config: process.config,
            onStep: onStep('apply.process.verify'),
          }),
        )
      } catch (err) {
        // 不回滚 release。停进程不可撤销，activate 失败时机器上是什么状态由
        // pidfile 与 ps 说话 —— 这里只保证把那句话说清楚，见 processFailureWarning
        processCause = err
        logger.error('apply.process.failed', { code: targetErrorFields(err).code })
      }
    }

    // ⑦ docker：**install 在 deploy 之后**，activate 再其后。
    // 顺序理由见 dockerRunFor 的注释：compose 文件随 release 上传，install 只是 stat 确认，
    // 排在传输之前它永远失败或什么也没证明。
    const dockerResults: DockerExecResult[] = []
    let dockerError: { code: string; message: string; path?: string; hint?: string } | undefined
    /** 保留原对象：退出码由 exitCodeFor 按错误码映射，只留结构化副本就映射不了 */
    let dockerCause: unknown
    if (docker !== undefined) {
      try {
        dockerResults.push(
          await installDocker({
            runner: resolved.runner,
            ctx,
            config: docker.config,
            onStep: onStep('apply.docker.install'),
          }),
        )
        dockerResults.push(
          await activateDocker({
            runner: resolved.runner,
            ctx,
            config: docker.config,
            onStep: onStep('apply.docker.activate'),
          }),
        )
        // verify 排在 activate 之后：up --wait 关掉时（compose.wait=false）
        // 这是唯一一道关。失败不回滚 release —— 执行器也没做任何补偿，
        // 机器上跑的是哪一版由 ps 说话，不由这里猜
        dockerResults.push(
          await verifyDocker({
            runner: resolved.runner,
            ctx,
            config: docker.config,
            onStep: onStep('apply.docker.verify'),
          }),
        )
      } catch (err) {
        // 不回滚 release，理由与 nginx activate 失败同款：版本本身是好的
        // （deploy 的健康检查过了），退掉它只会把「compose 的问题」变成「一次服务中断」。
        // 执行器也没有做任何补偿动作，所以机器上跑的是什么由 ps 决定，不由这里猜
        dockerError = targetErrorFields(err)
        dockerCause = err
        logger.error('apply.docker.failed', { code: dockerError.code })
      }
    }

    // install 失败时一个结果都没有（第一个阶段就抛了），这时**不造** docker 段：
    // 报一个「没有步骤、没有拉取、没有启动」的段，等于在结果里声称这些事发生过
    const dockerSection = docker === undefined || dockerResults.length === 0 ? undefined : dockerReport(dockerResults, docker)
    // install 失败时同样不造 process 段：它会声称「没写脚本、没启动」，
    // 而实际发生的是「脚本写了但某个阶段抛了」—— 让读的人以为机器上什么都没动过
    const processSection = process === undefined || processResults.length === 0 ? undefined : processReport(processResults)
    // activate 的告警排在发布告警**之后**：它描述的是「版本已切、conf/unit 没换」，
    // 排在前面会让人以为发布本身也出了问题
    const warnings = [
      ...deployed.warnings,
      ...(nginxSection?.warnings ?? []),
      ...(nginx !== undefined && nginxError !== undefined
        ? [activateFailedWarning(deployed.releaseId, nginx.current, nginxError)]
        : []),
      ...(systemdSection?.warnings ?? []),
      ...(systemdCause !== undefined ? [systemdFailureWarning(systemdCause, deployed.releaseId)] : []),
      ...(processSection?.warnings ?? []),
      ...(processCause !== undefined ? [processFailureWarning(processCause, deployed.releaseId)] : []),
      // docker 的告警排在最后：它描述的是「版本已切、服务没起来」，
      // 排在前面会让人以为发布本身也出了问题
      ...(dockerSection?.warnings ?? []),
      ...(dockerCause !== undefined ? [dockerFailureWarning(dockerCause, deployed.releaseId)] : []),
    ]

    // 四个目标都可能失败，结果里只报一个：取更严重的那个。
    // 报其中一个而吞掉另一个，等于把「这次部署有两处问题」说成一处
    const causes: readonly unknown[] = [nginxCause, systemdCause, processCause, dockerCause]
    const worstCause = pickWorstError(causes)

    result = {
      project,
      host,
      releaseId: deployed.releaseId,
      ...(deployed.previousReleaseId !== undefined ? { previousReleaseId: deployed.previousReleaseId } : {}),
      filesWritten: deployed.filesWritten,
      rolledBack: false,
      warnings,
      steps: deployed.steps.map((s) => ({ id: s.id, kind: s.kind, ok: s.ok })),
      probeNotes: resolved.probeNotes,
      dryRun: false,
      ...(nginxSection !== undefined ? { nginx: nginxSection } : {}),
      ...(systemdSection !== undefined ? { systemd: systemdSection } : {}),
      ...(processSection !== undefined ? { process: processSection } : {}),
      ...(dockerSection !== undefined ? { docker: dockerSection } : {}),
      ...(worstCause !== undefined ? { error: targetErrorFields(worstCause) } : {}),
    }
    // 退出码不能因为「发布了但服务没起来」就报成功：CI 需要据此通知。
    // 四个目标都可能有原因，取最严重的那次（映射规则全在 exitCodeFor 里）
    for (const cause of causes) {
      if (cause !== undefined) exitCode = Math.max(exitCode, exitCodeFor(cause))
    }
    logger.info('apply.done', { releaseId: deployed.releaseId, filesWritten: deployed.filesWritten })
    return { result, exitCode }
  } catch (err) {
    // 走到这里的是装配期失败（计划/路径/权限等）：没有产生副作用，也没什么可回滚的
    logger.error('apply.aborted', { code: targetErrorFields(err).code })
    return {
      result: {
        project,
        host,
        releaseId,
        filesWritten: 0,
        rolledBack: false,
        warnings: [],
        steps: [],
        probeNotes: resolved?.probeNotes ?? [],
        dryRun: flags.dryRun,
        error: targetErrorFields(err),
      },
      exitCode: exitCodeFor(err),
    }
  } finally {
    // 无论成败都必须断开：漏掉 close 会让进程挂到 socket 超时。
    // resolved 可能还没拿到（装配期就失败了），所以这里必须是可选调用
    await resolved?.close?.()
  }
}
