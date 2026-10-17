/**
 * `dp apply` 的装配层 —— 把配置翻译成各执行器的运行形态。
 *
 * 只做「配置 → 运行形态」的翻译，不做任何编排：步骤顺序与失败处理在 apply.ts。
 */
import type { SourceSpec } from '@dp/local'
import { DpError, type SourceEntry, type TargetContext } from '@dp/ports'
import { dirname, sep } from 'node:path'
import type { HostConfig, ProjectConfig } from '@dp/schema'
import type { DockerTargetConfig } from '@dp/target-docker'
import type { NginxTargetConfig } from '@dp/target-nginx'
import type { ProcessTargetConfig } from '@dp/target-process'
import type { SystemdTargetConfig } from '@dp/target-systemd'
import { chooseTransport, type TransferRequest, type TransportKind, type TransportPreference } from '@dp/transport'
import { becomeFor } from '../become.js'
import type { ApplyDeps } from '../deps.js'
import { dockerConfigFor } from '../docker-config.js'
import { type FactsResult, hopJumpStrings, resolveAuth, resolveSshEndpoint } from '../facts-source.js'
import { nginxConfigFor, releaseCurrentPath, resolveConfd } from '../nginx-config.js'
import { processConfigFor } from '../process-config.js'
import { resolveUnitDir, systemdConfigFor } from '../systemd-config.js'
import type { RunContext } from '../run.js'

/**
 * 补齐每条条目缺失的父目录条目。
 *
 * 为什么必须补：`source: "./dist"`（mode `self`）会把目录名也映射进
 * relativePath（`dist/index.html`），可 `listSourceEntries` 的遍历是从 root
 * 的**内容**开始的，于是这个顶层目录本身从来不会成为一条条目。结果是
 * deploy() 逐条写文件时，`releases/<id>.incoming/dist` 这个父目录压根没被建过，
 * writeFile 直接 ENOENT。
 *
 * deploy() 逐条 mkdir/writeFile，不保证目录先于文件出现，所以清单里必须自带目录。
 *
 * 补的还不只是中间层：**版本目录本身**也得有人建。contents 形态（`"./dist/**"`）
 * 下顶层目录不进路径，条目全是 `index.html` 这种单段路径时中间层一个都没有 ——
 * 而 deploy() 不会自己 mkdir 版本目录，于是第一次 writeFile 必然 ENOENT。
 * 也就是说**最顺手的那个写法反而是坏的**，所以必须在 CLI 这层补齐：
 * 目标机实现不该为了调用方的枚举习惯兜底，而 CLI 才是同时知道 source spec
 * 和 deploy 契约的那一层。
 */
export function withParentDirs(entries: readonly SourceEntry[]): readonly SourceEntry[] {
  const present = new Set(entries.map((e) => e.relativePath))
  // 空 relativePath 展开回版本目录本身（joinPath 丢掉空段），不是「相对当前目录」
  const parents = new Set<string>([''])
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
 * 清单条目相对的那个本地基目录 —— 传输层拼源路径的那个底。
 *
 * `self` 模式下 `listSourceEntries` 把源目录自己的名字也写进了 relativePath
 * （root 是 `/work/dist` 时条目是 `dist/index.html`），所以条目相对的是 root 的
 * **父目录**；拿 `spec.root` 去拼会得到 `/work/dist/dist/index.html`。真机上的
 * 后果是 rsync 报 23（部分文件不存在）→ 0 个文件 → 上层只能说「source 里没有
 * 任何文件」，而真因是这一个目录名被算了两次。
 *
 * 分隔符统一成正斜杠：拼出来的串要进 rsync / scp 的 argv，Windows 侧的 `\`
 * 到了 POSIX 远端就是路径里的一段字面量。
 */
export function sourceBaseFor(spec: SourceSpec): string {
  const base = spec.mode === 'self' ? dirname(spec.root) : spec.root
  return base.split(sep).join('/')
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

export function transportPreference(hostConfig: HostConfig, path: string): TransportPreference | undefined {
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

export interface ApplyTargetInput {
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
  readonly remoteFacts: FactsResult['facts']
}

export async function makeTransferHook(
  input: TransferHookInput,
): Promise<(stagingDir: string) => Promise<{ readonly filesWritten: number; readonly warnings: readonly string[] }>> {
  const { context, deps, logger, hostConfig, host, spec, entries, releaseRoot, releaseId, remoteFacts } = input
  const hostPath = `hosts.${host}`

  const auth = resolveAuth(context.env)
  const endpoint = resolveSshEndpoint(hostConfig, hostPath, auth)
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

  // 协商结论必须显式可见：用户有权知道「为什么这次没走 rsync」
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

  // sshTarget 只带**最后一跳**（目标机）：hops 的最后一跳就是目标机。
  // 其余跳走 rsh 侧 —— transport 的 hops 只含跳板、不含目标机（它会被拼进 -J，
  // 再由 rsync 把 sshTarget 追加在后面）。两处若都把目标机算进去，
  // 就成了 `ssh -J jump,target target`：多一次认证，且目标机往往不允许自己连自己。
  // 端口走 rsh 的 -p，不进 sshTarget：rsync 自己会在目标串后追加 host，
  // 写成 user@host:2222 会被当成主机名的一部分
  const sshTarget = endpoint.user !== undefined ? `${endpoint.user}@${endpoint.host}` : endpoint.host
  const hopJumps = hopJumpStrings(endpoint.hops)
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
      localRoot: sourceBaseFor(spec),
      entries: fileEntries,
      remoteRoot: stagingDir,
      host,
      sshTarget,
      // 跳板链交给 rsh 侧的 -J：多跳时不传就等于直连目标机
      ...(hopJumps !== undefined ? { hops: hopJumps } : {}),
      ...(auth.type === 'key' ? { identityFile: auth.identityFile } : {}),
      ...(endpoint.port !== undefined ? { port: endpoint.port } : {}),
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

    // 传输**没报错**却报 0 个文件，是「看起来成功其实没搬动」唯一的信号，
    // 而到这一步只能靠重现那条命令去查 —— 所以把 argv 打出来（command 已脱敏）。
    // 平时是 debug（信息太碎），0 个文件时提到 warn：那时它就是排障的第一手材料。
    if (result.filesTransferred === 0) {
      logger.warn('apply.transport.empty', {
        kind: result.kind,
        exitCode: result.exitCode,
        argv: result.command,
      })
    } else {
      logger.debug('apply.transport.argv', { argv: result.command })
    }

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
export interface NginxRun {
  readonly config: NginxTargetConfig
  readonly confd: string
  /** `${release.current}` 展开后的软链路径，失败说明要用它 —— 见 releaseCurrentPath */
  readonly current: string
}

export function nginxRunFor(
  target: ApplyTargetInput,
  ctx: TargetContext,
  env: string,
  envVars: Readonly<Record<string, string | undefined>>,
  now: Date,
  facts: FactsResult['facts'],
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
 * systemd 的四个阶段在本仓是什么关系 —— **与 nginx 同款，与 docker 相反**。
 *
 * 顺序是 ① install → ② deploy → ③ activate → ④ verify：
 *  - install 放最前，因为它只写影子目录（`<release 目录>/.dp/`）并跑 `systemd-analyze verify`，
 *    能在**碰任何生效 unit 之前**把坏 unit 挡掉。影子目录特意落在 release 目录下而不是 unitDir 之下：
 *    systemd 会递归扫描 unit 路径，放那儿等于往机器里塞一份同名重复 unit；
 *  - unit 的 `ExecStart` / `WorkingDirectory` 用 `${release.current}` **软链**，所以先切版本
 *    再换 unit 是安全的。反过来（先换 unit 再切版本）会留下一份指向还没就绪目录的 unit，
 *    而那种状态要等到下一次重启才暴露；
 *  - verify 排在 activate 之后：`systemctl restart` 返回 0 只说明它把命令发出去了，
 *    服务随后自己退掉时退出码仍然是 0，`is-active` 才是唯一能回答「服务现在活着吗」的那条命令。
 */
export interface SystemdRun {
  readonly config: SystemdTargetConfig
  /** 推导出来的 unit 目录。推导不出会在装配期抛（DP.PERM.UNIT_DIR_NOT_WRITABLE） */
  readonly unitDir: string
}

export function systemdRunFor(
  target: ApplyTargetInput,
  ctx: TargetContext,
  env: string,
  envVars: Readonly<Record<string, string | undefined>>,
  now: Date,
  facts: FactsResult['facts'],
): SystemdRun | undefined {
  const spec = target.projectConfig.target?.systemd
  if (spec === undefined) return undefined
  const unitDir = resolveUnitDir({
    facts,
    ...(target.projectConfig.target !== undefined ? { target: target.projectConfig.target } : {}),
  })
  return {
    unitDir,
    config: systemdConfigFor({ project: target.project, env, envVars, targetCtx: ctx, now, systemd: spec, unitDir }),
  }
}

/**
 * process 的四个阶段在本仓是什么关系 —— **与 docker 同款**。
 *
 * 顺序是 ① deploy → ② installProcess → ③ activate → ④ verify：
 * 启动/停止脚本写在 `<release 目录>/.dp/` 下，而那个目录由 deploy 造出来。
 * 把 install 排在 deploy 之前只有一种结局：它要么建出一个与 deploy 无关的目录，
 * 要么被 deploy 之后的清理顺手删掉 —— 两种情况下这个顺序都没有意义。
 *
 * 与 systemd 的差别不在顺序而在**回滚**：systemd 靠 `<unit>.dp-backup` 还原上一份 unit，
 * process 靠上一版目录里那份脚本重新起。所以它的 activate 必须「先停后起」，
 * 而停是不可撤销的 —— 停成功、起失败就是服务空窗，见 processFailureWarning。
 */
export interface ProcessRun {
  readonly config: ProcessTargetConfig
}

export function processRunFor(
  target: ApplyTargetInput,
  ctx: TargetContext,
  env: string,
  envVars: Readonly<Record<string, string | undefined>>,
  now: Date,
): ProcessRun | undefined {
  const spec = target.projectConfig.target?.process
  if (spec === undefined) return undefined
  return { config: processConfigFor({ project: target.project, env, envVars, targetCtx: ctx, now, process: spec }) }
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
export interface DockerRun {
  readonly config: DockerTargetConfig
  /** compose 的项目目录。失败文案里要给用户「文件本该在哪」，所以提前算好同源的一份 */
  readonly projectDir: string
  /** 用户写的那一份（未经渲染）。报错与报告里说的是配置值，不是渲染后的 argv */
  readonly projectName: string
}

export function dockerRunFor(
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
