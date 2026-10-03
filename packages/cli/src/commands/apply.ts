/**
 * `dp apply` —— 真部署。**默认真执行**。
 *
 * 为什么不做成「默认干跑 + --yes 才真做」：那种设计的安全感来自「人会在确认
 * 提示前看一眼」，而铁律 0 明确不许交互 —— 没有确认环节，这层安全感就是假的，
 * 假安全感比明着默认执行更危险。所以方向反过来：apply 一定真做，想先看清楚
 * 就跑 `dp plan` 或 `dp apply --dry-run`，那两个都保证零副作用。
 */
import { makePlan } from '@dp/core'
import { listSourceEntries, normalizeSourceSpec, type SourceSpec } from '@dp/local'
import {
  activateDocker,
  installDocker,
  isDockerExecFailure,
  verifyDocker,
  type DockerExecResult,
  type DockerTargetConfig,
} from '@dp/target-docker'
import { activateNginx, installNginx, type NginxExecResult, type NginxTargetConfig } from '@dp/target-nginx'
import { deploy, rollback } from '@dp/target-static'
import { chooseTransport, type TransferRequest, type TransportKind, type TransportPreference } from '@dp/transport'
import { DpError, type BecomeConfig, type SourceEntry, type TargetContext } from '@dp/ports'
import type { HostConfig, ProjectConfig } from '@dp/schema'
import type { LoadedConfig } from '../config-file.js'
import { defaultApplyDeps, type ApplyDeps } from '../deps.js'
import { acquireFacts as acquireFactsDefault, parseSshTarget, readFactsFile, resolveAuth } from '../facts-source.js'
import { nginxConfigFor, releaseCurrentPath, resolveConfd } from '../nginx-config.js'
import { dockerConfigFor } from '../docker-config.js'
import {
  exitCodeFor,
  renderApplyJson,
  renderApplyPretty,
  type ApplyTargetResult,
  type DockerTargetResult,
  type NginxTargetResult,
} from '../output.js'
import { releaseIdFor } from '../release-id.js'
import { selectTargets } from '../targets.js'
import { staticConfigFor } from '../target-config.js'
import { resolveTarget } from '../target-resolve.js'
import type { ResolvedFlags, RunContext } from '../run.js'

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

/**
 * nginx 的「两个阶段」在本仓是什么关系。
 *
 * 顺序是 ① installNginx → ② deploy → ③ activateNginx，不是随手排的：
 *  - install 放最前，因为它能在**碰任何生产目录之前**把坏 conf 挡掉（渲染 + 影子校验）；
 *  - conf 里的 root 用 `${release.current}` **软链**而不是具体版本目录，所以先切版本
 *    再换 conf 是安全的。反过来（先换 conf 再切版本）会在发布失败时留下一份指向
 *    还没就绪目录的 conf —— 而那种状态要等到下一次部署或下一次重启才暴露；
 *  - install 与 activate 分开，是因为 activate 要备份、原子替换、复验、reload，
 *    每一步都碰生产 confd；而 install 写的是影子目录。
 */
interface NginxRun {
  readonly config: NginxTargetConfig
  readonly confd: string
  /** `${release.current}` 展开后的软链路径，失败说明要用它 —— 见 releaseCurrentPath */
  readonly current: string
}

function nginxRunFor(
  target: ApplyTargetInput,
  ctx: TargetContext,
  env: string,
  envVars: Readonly<Record<string, string | undefined>>,
  now: Date,
  facts: Awaited<ReturnType<typeof acquireFactsDefault>>['facts'],
): NginxRun | undefined {
  const spec = target.projectConfig.target?.nginx
  if (spec === undefined) return undefined
  const confd = resolveConfd({ facts, ...(target.projectConfig.target !== undefined ? { target: target.projectConfig.target } : {}) })
  return {
    confd,
    current: releaseCurrentPath(ctx),
    config: nginxConfigFor({
      project: target.project,
      env,
      envVars,
      targetCtx: ctx,
      now,
      nginx: spec,
      confd,
    }),
  }
}

/**
 * 两个阶段的结论并成一段。`ownership` 取 install 的判定 —— activate 判的是同一份
 * 文件，重复报一次只会让人以为发生过两次判定。
 */
function nginxReport(
  confd: string,
  results: readonly NginxExecResult[],
): NginxTargetResult {
  const steps = results.flatMap((r) => r.steps.map((s) => ({ id: s.id, kind: s.kind, ok: s.ok, skipped: s.skipped })))
  const first = results[0]
  const last = results[results.length - 1]
  if (first === undefined || last === undefined) {
    // 调用点保证至少一个阶段（配了 nginx 就一定有 install），所以这是代码错误而非部署失败
    throw new Error('nginxReport 收到了空的结果列表')
  }
  return {
    confd,
    file: last.file,
    ...(first.ownership !== undefined ? { ownership: first.ownership } : {}),
    dryRun: last.dryRun,
    reloaded: results.some((r) => r.reloaded),
    skipped: steps.filter((s) => s.skipped).map((s) => s.id),
    steps,
    warnings: results.flatMap((r) => r.warnings),
  }
}

/**
 * activate 失败时机器处在什么状态。**不写「已回滚」**是刻意的：
 * conf 失败而版本本身是好的（deploy 的健康检查过了），为一个 conf 问题把一次
 * 成功的发布退掉，是把两件独立的事绑成一次失败。旧 conf 指向的是 `release.current`
 * 软链，所以线上仍然在服务，不是悬空。
 */
function activateFailedWarning(
  releaseId: string,
  /** `${release.current}` 展开后的真实软链位置。confd 里没有 current 这种东西，
   *  把 confd 拼上去会指向一个根本不存在的路径 */
  currentPath: string,
  f: { readonly code: string; readonly message: string },
): string {
  return [
    `版本已切到 ${releaseId}，conf 未更新，nginx 仍在用旧的 conf（它的 root 指向 ${currentPath} 软链，所以服务没有中断）。`,
    `失败原因 [${f.code}]：${f.message}`,
    '下一步：按 nginx 的原话修好 target.nginx 的配置后重跑 dp apply。',
    '**不要回滚这次发布** —— 版本本身是好的，退掉它只会把「一个 conf 问题」变成「一次服务中断」。',
  ].join('\n')
}

/**
 * docker 的「两个阶段」在本仓是什么关系 —— **与 nginx 相反**。
 *
 * 顺序是 ① deploy → ② installDocker → ③ activateDocker，不是随手排的：
 * compose 文件是**随 release 上传**的，而 installDocker 做的只是「stat 确认它们都在」
 * （它一条 exec 都不发，见 executor.ts）。所以把它排在 deploy 之前只有两种结局：
 * 要么它永远失败（文件还没传上去），要么它通过但什么也没证明。
 * 反过来，install 排在 deploy 之后是**唯一**有意义的顺序：传输刚落地就核对，
 * 坏在传输阶段时能立刻指到「这个文件没传上去」，而不是在 up 之后报一句
 * compose 自己找不到文件的、与部署毫无关系的话。
 *
 * static 负责 `releases/<id>` / `current` 切换 / keep N；docker 只做 ②③。
 */
interface DockerRun {
  readonly config: DockerTargetConfig
  /** compose 的项目目录。失败文案里要给用户「文件本该在哪」，所以提前算好同源的一份 */
  readonly projectDir: string
  /** 用户写的那一份（未经渲染）。报错与报告里说的是配置值，不是渲染后的 argv */
  readonly projectName: string
}

function dockerRunFor(
  target: ApplyTargetInput,
  ctx: TargetContext,
  env: string,
  envVars: Readonly<Record<string, string | undefined>>,
  now: Date,
): DockerRun | undefined {
  const spec = target.projectConfig.target?.docker
  if (spec === undefined) return undefined
  return {
    config: dockerConfigFor({ project: target.project, env, envVars, targetCtx: ctx, now, docker: spec }),
    // 与 argv 里的 cwd 同源：releaseDir 是 compose.ts 唯一的拼法，这里不另拼一次
    projectDir: `${ctx.root.replace(/\/+$/, '')}/releases/${ctx.releaseId}`,
    projectName: spec.compose.projectName,
  }
}

/**
 * install + activate 的结论并成一段。
 *
 * `services` 刻意不来自这两个阶段：它们不读 ps。verify / rollback 才读。
 * 在这里造一个 services 字段就得编一份「服务列表」出来，而那正是「报告了没发生的事」。
 */
function dockerReport(
  results: readonly DockerExecResult[],
  run: Pick<DockerRun, 'projectDir'> & { readonly projectName: string },
): DockerTargetResult {
  const steps = results.flatMap((r) => r.steps.map((s) => ({ id: s.id, kind: s.kind, ok: s.ok, skipped: s.skipped })))
  const last = results[results.length - 1]
  if (last === undefined) {
    // 调用点保证配了 docker 就有 install，所以这是代码错误而非部署失败
    throw new Error('dockerReport 收到了空的结果列表')
  }
  const ran = (id: string): boolean => results.some((r) => r.steps.some((s) => s.id === id && s.ok && !s.skipped))
  // services 只来自 verify/rollback 阶段。install / activate 不读 ps，
  // 所以它们的结果里根本没有这个字段 —— 这里不编一个空数组出来
  const services = results.find((r) => r.services !== undefined)?.services
  return {
    projectName: run.projectName,
    projectDir: run.projectDir,
    dryRun: last.dryRun,
    pulled: ran('docker.pull'),
    started: ran('docker.up'),
    skipped: steps.filter((s) => s.skipped).map((s) => s.id),
    steps,
    warnings: results.flatMap((r) => r.warnings),
    ...(services !== undefined ? { services: [...services] } : {}),
  }
}

/**
 * 失败时把执行器给的 healing 逐条带出来。
 *
 * 这不是「附赠信息」：执行器刻意**不做任何自动补偿**（自动 down 会连停掉目标机上
 * 同名的其它项目，自动 up 上一版会把「失败」与「已回滚」两个语义混进一个结果），
 * 所以那几条命令是用户唯一的下一步。吞掉它们等于留下一个「报失败但不说怎么修」
 * 的部署。
 */
function dockerFailureWarning(failure: unknown, releaseId: string): string {
  // 执行器把失败现场挂在 DpError.cause 上（ports 的 DpError 走 Error 的 cause，
  // 不是自定义字段）。传错对象会让 healing 整段消失 —— 而那是唯一的下一步
  if (!isDockerExecFailure(failure)) {
    return 'docker 阶段失败，但没能拿到结构化的失败现场（这不该发生，请连同配置报 issue）'
  }
  const lines = [
    `docker 阶段失败 [${failure.step}]：版本 ${releaseId} 已部署，但服务没有按新版本起来。`,
    '**没有执行任何自动补偿** —— 跑着的可能是上一版的容器（它仍在服务），也可能已经被换了一半。',
    '下一步（逐条执行）：',
    ...failure.healing.map((h, i) => `  ${i + 1}. ${h}`),
  ]
  if (failure.output !== undefined) lines.push(`docker 原话：\n${failure.output}`)
  return lines.join('\n')
}

/** 从抛出的错误里取出执行器挂上去的失败现场。传错对象会让 healing 整段消失 */
function dockerFailureOf(err: unknown): unknown {
  return err instanceof Error ? err.cause : undefined
}

/**
 * 两个原因都有时，报更严重的那个（按退出码）。`undefined` 那个先被排除。
 *
 * 严重程度只由 `exitCodeFor` 决定，不在这里另立一套排序 —— 一旦这里有自己的
 * 「哪个更严重」判断，它就会和 CI 看到的退出码对不上。
 */
function pickWorseError(a: unknown, b: unknown): { code: string; message: string; path?: string; hint?: string } {
  const fa = a === undefined ? undefined : errorFields(a)
  const fb = b === undefined ? undefined : errorFields(b)
  if (fa === undefined) return fb as { code: string; message: string }
  if (fb === undefined) return fa
  return exitCodeFor(a) >= exitCodeFor(b) ? fa : fb
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
  let resolved: Awaited<ReturnType<typeof resolveTarget>> | undefined
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
            onStep: (step) => logger.info('apply.nginx.install', { step: step.id, kind: step.kind, title: step.title }),
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
            onStep: (step) => logger.info('apply.nginx.activate', { step: step.id, kind: step.kind, title: step.title }),
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
              onStep: (step) => logger.info('apply.docker.install', { step: step.id, kind: step.kind, title: step.title }),
            }),
          )
        } catch (err) {
          const f = errorFields(err)
          if (f.code !== 'DP.DOCKER.FILE_MISSING') throw err
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
            onStep: (step) => logger.info('apply.docker.activate', { step: step.id, kind: step.kind, title: step.title }),
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
            onStep: (step) => logger.info('apply.docker.verify', { step: step.id, kind: step.kind, title: step.title }),
          }),
        )
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
        warnings: dockerDryRunWarnings,
        steps: plan.steps.map((s) => ({ id: s.id, kind: s.kind, ok: true })),
        probeNotes: resolved.probeNotes,
        dryRun: true,
        ...(nginx !== undefined ? { nginx: nginxReport(nginx.confd, dryRuns) } : {}),
        // install 没跑成时不造 docker 段：空段等于声称「拉过了、起过了」
        ...(docker !== undefined && dockerDryRuns.length > 0 ? { docker: dockerReport(dockerDryRuns, docker) } : {}),
      }
      return { result, exitCode: 0 }
    }

    announce(plan.releaseRoot, fileCount)

    // ⑤ 真执行。previousReleaseId **不填** —— deploy() 自己从索引里读，
    //    重复造一遍只会制造两个可能不一致的来源。

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
            remoteFacts: resolved.facts,
          })

    // ⑥ nginx install：**先于 deploy**。
    // 失败时一个字节都还没写进 confd、更没碰发布根，所以直接按该错误码退，
    // 不跑 deploy、也不回滚（没有东西可回滚）
    const nginxResults: NginxExecResult[] = []
    if (nginx !== undefined) {
      nginxResults.push(
        await installNginx({
          runner: resolved.runner,
          ctx,
          config: nginx.config,
          onStep: (step) => logger.info('apply.nginx.install', { step: step.id, kind: step.kind, title: step.title }),
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
        probeNotes: resolved.probeNotes,
        dryRun: false,
        error: errorFields(err),
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
            onStep: (step) => logger.info('apply.nginx.activate', { step: step.id, kind: step.kind, title: step.title }),
          }),
        )
      } catch (err) {
        // 执行器**已经**把 conf 还原并重新 -t 过了，所以这里不回滚 release。
        // 退出码取这个错误的映射：发布了但 conf 没换，不能报成功
        nginxError = errorFields(err)
        nginxCause = err
        logger.error('apply.nginx.failed', { code: nginxError.code })
      }
    }

    const nginxSection = nginx === undefined ? undefined : nginxReport(nginx.confd, nginxResults)

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
            onStep: (step) => logger.info('apply.docker.install', { step: step.id, kind: step.kind, title: step.title }),
          }),
        )
        dockerResults.push(
          await activateDocker({
            runner: resolved.runner,
            ctx,
            config: docker.config,
            onStep: (step) => logger.info('apply.docker.activate', { step: step.id, kind: step.kind, title: step.title }),
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
            onStep: (step) => logger.info('apply.docker.verify', { step: step.id, kind: step.kind, title: step.title }),
          }),
        )
      } catch (err) {
        // 不回滚 release，理由与 nginx activate 失败同款：版本本身是好的
        // （deploy 的健康检查过了），退掉它只会把「compose 的问题」变成「一次服务中断」。
        // 执行器也没有做任何补偿动作，所以机器上跑的是什么由 ps 决定，不由这里猜
        dockerError = errorFields(err)
        dockerCause = err
        logger.error('apply.docker.failed', { code: dockerError.code })
      }
    }

    // install 失败时一个结果都没有（第一个阶段就抛了），这时**不造** docker 段：
    // 报一个「没有步骤、没有拉取、没有启动」的段，等于在结果里声称这些事发生过
    const dockerSection = docker === undefined || dockerResults.length === 0 ? undefined : dockerReport(dockerResults, docker)
    // activate 的告警排在发布告警**之后**：它描述的是「版本已切、conf 没换」，
    // 排在前面会让人以为发布本身也出了问题
    const warnings = [
      ...deployed.warnings,
      ...(nginxSection?.warnings ?? []),
      ...(nginx !== undefined && nginxError !== undefined
        ? [activateFailedWarning(deployed.releaseId, nginx.current, nginxError)]
        : []),
      // docker 的告警排在最后：它描述的是「版本已切、服务没起来」，
      // 排在前面会让人以为发布本身也出了问题
      ...(dockerSection?.warnings ?? []),
      ...(dockerCause !== undefined ? [dockerFailureWarning(dockerFailureOf(dockerCause), deployed.releaseId)] : []),
    ]

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
      ...(dockerSection !== undefined ? { docker: dockerSection } : {}),
      // 两边都失败时取更严重的那个：nginx 报 conf 没换、docker 报服务没起来，
      // 报其中一个而吞掉另一个，等于把「这次部署有两处问题」说成一处
      ...(nginxError !== undefined || dockerError !== undefined
        ? { error: pickWorseError(nginxCause, dockerCause) }
        : {}),
    }
    // 退出码不能因为「发布了但服务没起来」就报成功：CI 需要据此通知。
    // 两个原因都可能有，取更严重的那次（映射规则全在 exitCodeFor 里）
    if (dockerCause !== undefined) {
      exitCode = exitCodeFor(dockerCause)
    }
    if (nginxCause !== undefined) {
      exitCode = Math.max(exitCode, exitCodeFor(nginxCause))
    }
    logger.info('apply.done', { releaseId: deployed.releaseId, filesWritten: deployed.filesWritten })
    return { result, exitCode }
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
        probeNotes: resolved?.probeNotes ?? [],
        dryRun: flags.dryRun,
        error: errorFields(err),
      },
      exitCode: exitCodeFor(err),
    }
  } finally {
    // 无论成败都必须断开：漏掉 close 会让进程挂到 socket 超时。
    // resolved 可能还没拿到（装配期就失败了），所以这里必须是可选调用
    await resolved?.close?.()
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
