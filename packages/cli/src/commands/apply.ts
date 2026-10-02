/**
 * `dp apply` —— 真部署。**默认真执行**。
 *
 * 为什么不做成「默认干跑 + --yes 才真做」：那种设计的安全感来自「人会在确认
 * 提示前看一眼」，而铁律 0 明确不许交互 —— 没有确认环节，这层安全感就是假的，
 * 假安全感比明着默认执行更危险。所以方向反过来：apply 一定真做，想先看清楚
 * 就跑 `dp plan` 或 `dp apply --dry-run`，那两个都保证零副作用。
 */
import { makePlan } from '@dp/core'
import { createLocalRunner, listSourceEntries, normalizeSourceSpec, type SourceSpec } from '@dp/local'
import { deploy, rollback, type StaticTargetConfig } from '@dp/target-static'
import { chooseTransport, type TransferRequest, type TransportKind, type TransportPreference } from '@dp/transport'
import { DpError, type BecomeConfig, type Runner, type SourceEntry, type TargetContext } from '@dp/ports'
import type { HostConfig, ProjectConfig } from '@dp/schema'
import type { LoadedConfig } from '../config-file.js'
import { defaultApplyDeps, type ApplyDeps } from '../deps.js'
import { acquireFacts as acquireFactsDefault, parseSshTarget, readFactsFile, resolveAuth } from '../facts-source.js'
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

/**
 * 配置里的 `transport.strategy` → 传输包的偏好链。
 *
 * 名字**对不上**是刻意的：配置面向用户写 `rsync` / `local`，传输包用
 * `rsync-ssh` / `local-copy`（后者强调「拷贝」而非「本地」）。所以这层映射
 * 必须显式写出来 —— 直接 `as` 断言等于把「用户写了 local 却静默走远端传输」
 * 这种错配置也一并放过去。
 *
 * `local-copy` 从链上剔掉：远端部署里它永远不成立，留着只会让协商在链尾
 * 报一个用户看不懂的失败。
 */
const KIND_ALIASES: Readonly<Record<string, TransportKind>> = {
  rsync: 'rsync-ssh',
  'tar-ssh': 'tar-ssh',
  sftp: 'sftp',
  scp: 'scp',
  local: 'local-copy',
}

function transportPreference(hostConfig: HostConfig, path: string): TransportPreference | undefined {
  const strategy = hostConfig.transport?.strategy
  if (strategy === undefined) return undefined
  const mapped: TransportKind[] = []
  for (const raw of strategy) {
    const kind = KIND_ALIASES[raw]
    if (kind === undefined) {
      throw new DpError('DP.CONFIG.INVALID', `未知的传输方式：${raw}`, {
        path,
        hint: `合法值：${Object.keys(KIND_ALIASES).join(' | ')}`,
      })
    }
    if (kind !== 'local-copy') mapped.push(kind)
  }
  // 全是 local-copy 等价于「没写偏好」——给协商一条空链它会退回默认链，
  // 而用户明写的东西被悄悄丢掉是最难发现的一类行为
  return mapped.length === 0 ? undefined : mapped
}

/**
 * schema 的 become（配置形态）→ ports 的 become（运行形态）。
 *
 * 两个形状不一样是刻意的：配置形态带 method / passwordRef（凭据解析是
 * schema 的职责），运行形态只描述「怎么提权」。
 *
 * 有两类配置**明确拒绝**而不是凑一个值出来 —— 歧义靠拒绝，不靠默认值：
 *  - `custom`：schema 里没有承载命令模板的字段，凑一个就是凭空发明行为；
 *  - `method: stdin | pty`：要密码的提权，而运行形态没有密码通道。
 */
function becomeFor(hostConfig: HostConfig, path: string): BecomeConfig | undefined {
  const b = hostConfig.become
  if (b === undefined) return undefined
  switch (b.type) {
    case 'none':
      return { type: 'none' }
    case 'sudo': {
      // stdin / pty 意味着「sudo 要问密码」。传输层没有密码通道（passwordRef 是
      // schema 的事，BecomeConfig 里根本没有承载它的字段），而 @dp/ssh 对
      // nonInteractive=false 的处理是**直接拒绝**（become.ts：铁律 0 不许等 stdin）。
      // 与其让它在深处抛一句看不懂的 refusal，不如在这里说清「没接」。
      if (b.method === 'stdin' || b.method === 'pty') {
        throw new DpError('DP.CONFIG.INVALID', `become.method=${b.method} 尚未接入传输层`, {
          path: `${path}.become.method`,
          hint: '传输层没有密码通道，带密码的 sudo 会撞铁律 0。请配免密 sudo（nopasswd）或改用 su',
        })
      }
      return {
        type: 'sudo',
        ...(b.user !== undefined ? { user: b.user } : {}),
        nonInteractive: true,
      }
    }
    case 'doas':
      return { type: 'doas', ...(b.user !== undefined ? { user: b.user } : {}) }
    case 'su': {
      if (b.user === undefined || b.user === '') {
        throw new DpError('DP.CONFIG.INVALID', 'become.type=su 必须写 become.user', {
          path: `${path}.become.user`,
          hint: "su 不给用户名就没有目标身份，写成 { \"type\": \"su\", \"user\": \"www-data\" }",
        })
      }
      return { type: 'su', user: b.user }
    }
    case 'custom':
      throw new DpError('DP.CONFIG.INVALID', 'become.type=custom 尚未接入传输层', {
        path: `${path}.become.type`,
        hint: 'custom 需要一条命令模板，而 schema 没有承载它的字段；请改用 sudo / su / doas',
      })
  }
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

/**
 * 远端部署的传输钩子 —— 一次协商，之后每次 deploy 调它就传一次。
 *
 * **为什么是「钩子」而不是把 apply 拆成「先 transfer 再 deploy」两步**：
 * deploy() 拥有 staging → rename → 换 current → verify → prune 这条链的全部补偿
 * 语义，其中「空版本拒绝」和「verify 不过就换回上一版」是**线上不出事**的两道闸。
 * 拆成两步意味着 CLI 要自己保证「传完再调 deploy」之间 staging 的归属，而一旦
 * 传输失败，CLI 就得自己补一套「删干净 staging」的逻辑 —— 那是第二份补偿实现，
 * 两份迟早不一致。所以这里只交出「把源搬进这个目录」这一个动作，其余全留给 deploy。
 *
 * 顺带得到一个免费的好处：`stagingDir` 由 deploy 传进来，而不是 CLI 算好了传进去 ——
 * 于是「传输写到哪里」与「deploy 认为的 staging 在哪里」在类型上就不可能分叉。
 */
interface TransferHookInput {
  readonly context: RunContext
  readonly deps: ApplyDeps
  readonly logger: ReturnType<RunContext['logger']['child']>
  readonly hostConfig: HostConfig
  readonly host: string
  readonly spec: SourceSpec
  readonly entries: readonly SourceEntry[]
  readonly releaseRoot: string
  readonly releaseId: string
  readonly remoteFacts: Awaited<ReturnType<typeof acquireFactsDefault>>['facts']
}

async function makeTransferHook(
  input: TransferHookInput,
): Promise<(stagingDir: string) => Promise<{ readonly filesWritten: number; readonly warnings: readonly string[] }>> {
  const { context, deps, logger, hostConfig, host, spec, entries, releaseRoot, releaseId, remoteFacts } = input
  const hostPath = `hosts.${host}`

  if (hostConfig.ssh === undefined) {
    throw new DpError('DP.CONFIG.INVALID', `主机 ${host} 既没有 local: true 也没有 ssh`, {
      path: hostPath,
      hint: '远端部署需要 ssh 目标；本机目标请写 { "local": true }（它走逐条 writeFile，不经过传输层）',
    })
  }

  const target = parseSshTarget(hostConfig.ssh, `${hostPath}.ssh`)
  const auth = resolveAuth(context.env, `${hostPath}.ssh`)
  const preferred = transportPreference(hostConfig, `${hostPath}.transport.strategy`)

  // 只传**文件**条目：rsync / tar 都会自己建父目录，而目录条目传进去只是
  // 多余的 argv，还会让 tar 的「传输了几个条目」这个计数偏大
  const fileEntries = entries.filter((e) => e.kind === 'file').map((e) => e.relativePath)

  const localFacts = await deps.probeLocalFacts()
  const choice = chooseTransport({
    local: localFacts,
    remote: remoteFacts,
    kind: 'remote',
    ...(preferred !== undefined ? { preferred } : {}),
  })

  // 协商结论必须显式可见（transport.md §7）：用户有权知道「为什么这次没走 rsync」
  logger.info('apply.transport', {
    kind: choice.kind,
    remoteRoot: `${releaseRoot}/releases/${releaseId}.incoming`,
    entries: fileEntries.length,
    rejected: choice.rejected.length,
    reasons: choice.reasons,
    ...(choice.rejected.length > 0
      ? { rejectedItems: choice.rejected.map((r) => `${r.kind}: ${r.reason}`) }
      : {}),
  })

  // 多跳还没进 schema（AGENTS.md：多跳尚未实现）。不加 `hops` 字段是对的 ——
  // 为一个还不存在的配置项写 `(hostConfig as { hops?: ... })` 只是换个写法骗过类型
  // 检查，运行时永远是 undefined，还会让人以为多跳已经通了。
  // 端口走 rsh 的 -p，不进 sshTarget：rsync 自己会在目标串后追加 host，
  // 写成 user@host:2222 会被当成主机名的一部分
  const sshTarget = target.user !== undefined ? `${target.user}@${target.host}` : target.host
  const become = becomeFor(hostConfig, hostPath)

  return async (stagingDir: string): Promise<{ readonly filesWritten: number; readonly warnings: readonly string[] }> => {
    const expected = `${releaseRoot}/releases/${releaseId}.incoming`
    if (stagingDir !== expected) {
      // 传错目录 = 把文件写到正在服务的目录或版本目录里，两种都是事故。
      // 所以这里拒绝，而不是「用 CLI 自己算的那个」。
      throw new DpError('DP.CONFIG.INVALID', `传输目标与 deploy 的 staging 不一致：${stagingDir}`, {
        path: hostPath,
        hint: `期望 ${expected}`,
      })
    }

    const request: TransferRequest = {
      kind: 'remote',
      localRoot: spec.root,
      entries: fileEntries,
      remoteRoot: stagingDir,
      host,
      sshTarget,
      ...(auth.type === 'key' ? { identityFile: auth.identityFile } : {}),
      ...(target.port !== undefined ? { port: target.port } : {}),
      ...(become !== undefined ? { become } : {}),
      deleteExtraneous: hostConfig.transport?.delete ?? false,
    }

    // preferred **必须**传下去。上面那次 chooseTransport 只是「提前校验 + 打日志」；
    // transfer() 内部会再协商一次，而它只认 deps.preferred —— 不传就等于用户写的
    // strategy 被丢掉、日志里的 kind 与实际执行的方式不一致（写 tar-ssh 却跑 rsync）。
    const result = await deps.transfer(request, {
      localFacts,
      remoteFacts,
      logger,
      ...(preferred !== undefined ? { preferred } : {}),
    })
    return { filesWritten: result.filesTransferred, warnings: result.warnings }
  }
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

  // 源清单与 facts 都在 try **里面**：装配期的失败（source 空、配置错、连不上）
  // 也必须是 ApplyTargetResult 里的一个 error，而不是抛到 main 的通用错误处理。
  // 否则 `--json` 失败时 stdout 会是空的 —— CI 里 `dp apply --json > r.json`
  // 拿到一个空文件，等于机器可读模式在最需要它的那一刻失效。
  let facts: Awaited<ReturnType<typeof acquireFactsDefault>> | undefined
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
        : await deps.acquireFacts({
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

    // 远端改走传输层，本机保持逐条 writeFile —— 见 makeTransferHook 的说明
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
            remoteFacts: facts.facts,
          })

    let deployed: Awaited<ReturnType<typeof deploy>>
    try {
      deployed = await deploy({
        runner,
        ctx,
        entries,
        config: staticConfigFor(target.projectConfig),
        ...(transferHook !== undefined ? { transfer: transferHook } : {}),
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
