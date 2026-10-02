/**
 * `dp apply` —— 真部署。**默认真执行**。
 *
 * 为什么不做成「默认干跑 + --yes 才真做」：那种设计的安全感来自「人会在确认
 * 提示前看一眼」，而铁律 0 明确不许交互 —— 没有确认环节，这层安全感就是假的，
 * 假安全感比明着默认执行更危险。所以方向反过来：apply 一定真做，想先看清楚
 * 就跑 `dp plan` 或 `dp apply --dry-run`，那两个都保证零副作用。
 */
import { makePlan } from '@dp/core'
import { createLocalRunner, listSourceEntries, normalizeSourceSpec } from '@dp/local'
import { deploy, rollback, type StaticTargetConfig } from '@dp/target-static'
import { DpError, type Runner, type SourceEntry, type TargetContext } from '@dp/ports'
import type { HostConfig, ProjectConfig } from '@dp/schema'
import type { LoadedConfig } from '../config-file.js'
import { acquireFacts, readFactsFile } from '../facts-source.js'
import { exitCodeFor, renderApplyJson, renderApplyPretty, type ApplyTargetResult } from '../output.js'
import { releaseIdFor } from '../release-id.js'
import { selectTargets } from '../targets.js'
import type { ResolvedFlags, RunContext } from '../run.js'

/** 与 configSchema 里 release.keep 的默认值一致；config 没写 release 段时用它 */
const DEFAULT_KEEP = 5

/**
 * 补齐每条条目缺失的父目录条目。
 *
 * 为什么必须补：`source: "./dist"`（mode `self`）会把目录名也映射进
 * relativePath（`dist/index.html`），可 `listSourceEntries` 的遍历是从 root
 * 的**内容**开始的，于是这个顶层目录本身从来不会成为一条条目。结果是
 * deploy() 逐条写文件时，`releases/<id>.incoming/dist` 这个父目录压根没被建过，
 * writeFile 直接 ENOENT。
 *
 * 换成 `"./dist/**"`（mode `contents`）不会踩到 —— 因为那时顶层目录不进路径。
 * 也就是说**最顺手的那个写法反而是坏的**，所以必须在 CLI 这层补齐：
 * 目标机实现不该为了调用方的枚举习惯兜底，而 CLI 才是同时知道 source spec
 * 和 deploy 契约的那一层。
 */
function withParentDirs(entries: readonly SourceEntry[]): readonly SourceEntry[] {
  const present = new Set(entries.map((e) => e.relativePath))
  const parents = new Set<string>()
  for (const entry of entries) {
    const parts = entry.relativePath.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      const parent = parts.slice(0, i).join('/')
      if (!present.has(parent)) parents.add(parent)
    }
  }
  // 浅的先建：deploy() 逐条 mkdir/writeFile，不保证父目录先于子目录出现
  const dirs = [...parents]
    .sort((a, b) => a.split('/').length - b.split('/').length)
    .map((relativePath): SourceEntry => ({ kind: 'dir', relativePath }))
  return [...dirs, ...entries]
}

/**
 * static 目标只认 `healthcheck.fileExists` 一种校验（不需要起进程、不碰 shell）。
 * 其余 healthcheck 形态（command / http / tcp）属于后续目标的能力，这里
 * **不假装支持** —— 没映射就不会被读，也就不会给出虚假的「已校验」。
 */
function staticConfigFor(project: ProjectConfig): StaticTargetConfig {
  const fileExists = project.healthcheck?.fileExists
  return fileExists === undefined ? {} : { healthcheck: { fileExists } }
}

function errorFields(err: unknown): { code: string; message: string; path?: string; hint?: string } {
  if (err instanceof DpError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.path !== undefined ? { path: err.path } : {}),
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
    }
  }
  return { code: 'DP.CLI.INTERNAL', message: err instanceof Error ? err.message : String(err) }
}

/**
 * needsHealing（docs/transaction.md §3）时的告警文案。
 *
 * 这是「明确承认」而不是把错误吞掉：保留现场不继续自动操作，说清现在环境是
 * A 部分生效、B 部分没回滚，并给一条**人能直接敲**的下一步命令。
 */
function healingWarning(root: string, rbErr: unknown): string {
  return [
    'DP.HEALING.REQUIRED: 环境处于部分回滚状态 —— 新版本已部分生效，回滚未能完成',
    `下一步：1) 人工查看 ${root}/releases 下的版本目录；`,
    `2) 把 ${root}/current 指回可用版本（Linux/macOS：ln -sfn <root>/releases/<版本> ${root}/current` +
      `；Windows 无软链权限时把 ${root}/current 目录内容替换为该版本）；`,
    '3) 确认服务正常后再重跑 dp apply',
    `回滚失败原因：${errorFields(rbErr).message}`,
  ].join('\n')
}

export async function runApply(context: RunContext, flags: ResolvedFlags): Promise<number> {
  const started = new Date()
  const loaded: LoadedConfig = await context.loadConfig(flags)
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

interface ApplyTargetInput {
  readonly project: string
  readonly host: string
  readonly projectConfig: ProjectConfig
  readonly hostConfig: HostConfig
  readonly logger: ReturnType<RunContext['logger']['child']>
  readonly now: Date
}

async function applyOne(
  context: RunContext,
  flags: ResolvedFlags,
  target: ApplyTargetInput,
): Promise<{ readonly result: ApplyTargetResult; readonly exitCode: number }> {
  const { host, logger, project } = target
  const releaseId = releaseIdFor(project, target.now)

  /** 部署前先把「将要发生什么」摆出来：人肉看日志和 CI 抓日志靠它对账 */
  const announce = (root: string, files: number): void => {
    logger.info('apply.begin', { project, releaseRoot: root, releaseId, files })
    // --json 时 stdout 必须是纯 JSON，这行只能走日志（它会自动落到 stderr）
    if (!flags.json) {
      context.out(`即将部署 ${project} → ${host}\n  发布根 ${root}\n  releaseId ${releaseId}\n  文件数 ${files}`)
    }
  }

  // 源清单与 facts 都在 try **里面**：装配期的失败（source 空、配置错、连不上）
  // 也必须是 ApplyTargetResult 里的一个 error，而不是抛到 main 的通用错误处理。
  // 否则 `--json` 失败时 stdout 会是空的 —— CI 里 `dp apply --json > r.json`
  // 拿到一个空文件，等于机器可读模式在最需要它的那一刻失效。
  let facts: Awaited<ReturnType<typeof acquireFacts>> | undefined
  let exitCode = 0
  let result: ApplyTargetResult

  try {
    // ① 源清单先枚举：它只读本机文件系统，出问题时用户还没付任何代价
    const spec = normalizeSourceSpec(target.projectConfig.source.root, context.cwd)
    const rawEntries = await listSourceEntries(spec)
    if (rawEntries.length === 0) {
      throw new DpError('DP.SOURCE.EMPTY', `项目 ${project} 的 source 是空的：${spec.root}`, {
        path: `projects.${project}.source`,
        hint: '构建产物为空，或 include/exclude 把所有文件都排除了。注意 "./dist" 与 "./dist/**" 的区别',
      })
    }
    const entries = withParentDirs(rawEntries)
    const fileCount = rawEntries.filter((e) => e.kind === 'file').length

    // ② Facts。--facts 提供夹具时完全离线，此时没有连接、也就没有 runner
    facts =
      flags.factsFile !== undefined
        ? { facts: await readFactsFile(flags.factsFile), probeNotes: [] as readonly string[], close: undefined }
        : await acquireFacts({
            hostId: host,
            host: target.hostConfig,
            projectName: project,
            ...(target.projectConfig.release?.root !== undefined
              ? { releaseRoot: target.projectConfig.release.root }
              : {}),
            logger,
          })

    const plan = makePlan({
      name: project,
      project: target.projectConfig,
      facts: facts.facts,
      releaseId,
      sourceEntries: entries.map((e) => e.relativePath),
      ...(target.hostConfig.layout !== undefined ? { layout: target.hostConfig.layout } : {}),
    })

    // ③ Runner。远端复用 acquireFacts 连好的那条连接（探测看到的机器与写入的
    //    机器物理上同一台）；本机现造一个。
    let runner: Runner
    if (facts.runner !== undefined) {
      runner = facts.runner
    } else if (target.hostConfig.local === true) {
      runner = createLocalRunner(facts.facts)
    } else {
      // 绝不能在这里悄悄退回本机 Runner：那会把「部署到远端」变成「部署到自己机器上」
      throw new DpError('DP.CONFIG.INVALID', `--facts 只能用于 local 主机，${host} 是远端主机`, {
        path: '--facts',
        hint: `远端部署需要真连接才能写入文件，删掉 --facts 重跑（远端事实会现场探测）`,
      })
    }

    // ④ --dry-run：算完就停，一个字节都不写
    if (flags.dryRun) {
      announce(plan.releaseRoot, fileCount)
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
        warnings: [],
        steps: plan.steps.map((s) => ({ id: s.id, kind: s.kind, ok: true })),
        probeNotes: facts.probeNotes,
        dryRun: true,
      }
      return { result, exitCode: 0 }
    }

    announce(plan.releaseRoot, fileCount)

    // ⑤ 真执行。previousReleaseId **不填** —— deploy() 自己从索引里读，
    //    重复造一遍只会制造两个可能不一致的来源。
    const ctx: TargetContext = {
      host,
      root: plan.releaseRoot,
      releaseId,
      keep: target.projectConfig.release?.keep ?? DEFAULT_KEEP,
    }

    let deployed: Awaited<ReturnType<typeof deploy>>
    try {
      deployed = await deploy({
        runner,
        ctx,
        entries,
        config: staticConfigFor(target.projectConfig),
        onStep: (step) => {
          logger.info('apply.step', { step: step.id, kind: step.kind, title: step.title })
        },
      })
    } catch (err) {
      // ── 失败处理 ────────────────────────────────────────────────
      // deploy() 在 DP.VERIFY.FAILED 上**已经**把 current 指回上一版了
      // （见 target-static 的 verify 分支），所以这里绝不能再 rollback 一次 ——
      // 那会连退两版，把本来还能用的版本也换掉。
      const alreadyCompensated = err instanceof DpError && err.code === 'DP.VERIFY.FAILED'
      const warnings: string[] = []
      let rolledBack = alreadyCompensated
      let needsHealing = false
      let rbExit = 0

      if (!alreadyCompensated) {
        try {
          await rollback(runner, ctx)
          rolledBack = true
        } catch (rbErr) {
          needsHealing = true
          rbExit = exitCodeFor(rbErr)
          warnings.push(healingWarning(plan.releaseRoot, rbErr))
        }
      } else {
        warnings.push('本次已由 deploy 自动回退到上一版')
      }

      logger.error('apply.failed', { code: errorFields(err).code, rolledBack, needsHealing })
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
        probeNotes: facts.probeNotes,
        dryRun: false,
        error: errorFields(err),
        ...(needsHealing ? { needsHealing: true } : {}),
      }
      return { result, exitCode }
    }

    for (const w of deployed.warnings) logger.warn('apply.warning', { warning: w })

    result = {
      project,
      host,
      releaseId: deployed.releaseId,
      ...(deployed.previousReleaseId !== undefined ? { previousReleaseId: deployed.previousReleaseId } : {}),
      filesWritten: deployed.filesWritten,
      rolledBack: false,
      warnings: deployed.warnings,
      steps: deployed.steps.map((s) => ({ id: s.id, kind: s.kind, ok: s.ok })),
      probeNotes: facts.probeNotes,
      dryRun: false,
    }
    logger.info('apply.done', { releaseId: deployed.releaseId, filesWritten: deployed.filesWritten })
    return { result, exitCode: 0 }
  } catch (err) {
    // 走到这里的是装配期失败（计划/路径/权限等）：没有产生副作用，也没什么可回滚的
    logger.error('apply.aborted', { code: errorFields(err).code })
    return {
      result: {
        project,
        host,
        releaseId,
        filesWritten: 0,
        rolledBack: false,
        warnings: [],
        steps: [],
        probeNotes: facts?.probeNotes ?? [],
        dryRun: flags.dryRun,
        error: errorFields(err),
      },
      exitCode: exitCodeFor(err),
    }
  } finally {
    // 无论成败都必须断开：漏掉 close 会让进程挂到 socket 超时。
    // facts 可能还没拿到（装配期就失败了），所以这里必须是可选调用
    await facts?.close?.()
  }
}

/** dry-run 时的 plan 正文。与 plan 命令同源，让人看到的和真跑时一致 */
function renderPlanBody(plan: { steps: readonly { id: string; kind: string; title: string }[]; releaseRoot: string; warnings: readonly string[] }): string {
  const lines = [`plan · 发布根 ${plan.releaseRoot} · ${plan.steps.length} 步`, '']
  plan.steps.forEach((s, i) => lines.push(`  ${i + 1}. [${s.kind}] ${s.title}`))
  if (plan.warnings.length > 0) {
    lines.push('', '告警', ...plan.warnings.map((w) => `  ! ${w}`))
  }
  lines.push('', '未写入任何文件（--dry-run）')
  return lines.join('\n')
}
