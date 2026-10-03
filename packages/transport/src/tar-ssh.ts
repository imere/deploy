/**
 * tar-ssh —— 本机 tar 打包流经 ssh 送到远端 tar 解包。
 *
 * 存在的理由：本机没 rsync 是**常态**（本仓
 * 明写 `facts.tools.rsync === null`），而 tar 两端几乎总有。所以它是 rsync 之后的
 * 主力退路，代价是全量传输。
 *
 * **绝不用 shell 管道**。铁律 1：一切 `spawn(exe, argv[])`。这里的"管道"是 Node
 * 层的 `stdout → stdin` 直连（`stdio: ['pipe','pipe','pipe']`），两个子进程各自
 * 独立受 timeout 约束 —— 用 shell 管道的话一旦 ssh 挂住，我们连杀都杀不干净。
 *
 * argv 构造是**纯函数**（`buildTarArgv`），IO 只从 `runTarSsh` 开始。
 */
import { DpError } from '@dp/ports'
import { quoteArg, wrapCommand } from '@dp/ssh'
import { runProcess, summarizeFailure } from './proc.js'
import { buildRshArgv, rshValueForRsync } from './rsh.js'
import type { TransferRequest, TransferResult, SpawnImpl } from './types.js'
import type { RshOptions } from './rsh.js'

export interface TarArgvOptions {
  readonly localTarPath: string
  readonly rsh: RshOptions
  readonly remoteTarget: string
  /** 远端解包命令是否需要提权包装 */
  readonly become?: TransferRequest['become']
}

export interface TarArgvPair {
  /** 本机打包端 */
  readonly local: readonly string[]
  /** 远端解包端：ssh 的 argv + 提权包装后的 tar */
  readonly remote: readonly string[]
}

/**
 * 纯函数：两侧的 argv。
 *
 * `--` 之后才是文件清单：tar 会把以 `-` 开头的文件名当选项解析（铁律 2，
 * 歧义靠拒绝）。`--no-same-owner` 是**故意的**：非 root 解包时保留 owner 会失败，
 * 而且提权解包时保留 owner 也不是我们要的语义。
 */
export function buildTarArgv(req: TransferRequest, options: TarArgvOptions): TarArgvPair {
  if (req.entries.length === 0) {
    throw new DpError('DP.SOURCE.EMPTY', '源清单为空，拒绝传输', {
      hint: '构建产物为空，或 include/exclude 把所有文件都排除了',
    })
  }
  const local = [
    options.localTarPath,
    '-cf',
    '-',
    '--no-same-owner',
    '--no-same-permissions',
    '-C',
    req.localRoot,
    '--',
    ...req.entries,
  ]

  const extract: string[] = ['tar', '-xf', '-', '--no-same-owner', '-C', req.remoteRoot]
  const wrapped = options.become === undefined || options.become.type === 'none'
    ? extract
    : wrapCommand(extract, options.become)

  const remote = [
    ...buildRshArgv(options.rsh),
    // 远端命令作为独立 argv 追加，ssh 负责拼成远程命令串
    ...wrapped,
  ]
  return { local, remote }
}

/** 提权包装后的远端命令串，**只用于日志与结果展示**，不进 argv */
export function remoteExtractCommand(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}

export interface RunTarSshOptions {
  readonly timeoutMs?: number
  readonly spawnImpl?: SpawnImpl
  readonly dryRun?: boolean
}

/**
 * 起两个子进程并把 stdout 直连 stdin。
 *
 * 任一端失败都杀掉另一端 —— 远端 tar 挂了却让本机 tar 继续往管道写，
 * 结果是一个永远不消费的孤儿进程（Windows 上更明显，native.ts 注释里记过）。
 */
export async function runTarSsh(
  pair: TarArgvPair,
  options: RunTarSshOptions = {},
): Promise<TransferResult> {
  const timeoutMs = options.timeoutMs
  const common = {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
  }
  // 两端并发跑：串行的话本机 tar 先产出一整个归档却没人接，管道会直接写满阻塞
  const [local, remote] = await Promise.all([
    runProcess(pair.local, { ...common, label: 'tar(local)' }),
    runProcess(pair.remote, { ...common, label: 'ssh(tar remote)' }),
  ])

  const localDetail = summarizeFailure(local.stderr)
  const remoteDetail = summarizeFailure(remote.stderr)

  if (local.code !== 0) {
    throw new DpError('DP.VERIFY.FAILED', `本机打包失败（tar ${local.code}）：${localDetail}`, {
      hint: '确认源文件在传输过程中没被删掉；或用 --dry-run 先看清单',
    })
  }
  if (remote.code !== 0) {
    if (remote.code === 255) {
      throw new DpError('DP.SSH.CONNECT_FAILED', `ssh 层失败：${remoteDetail}`, {
        hint: '检查主机可达性、凭据与跳板链',
      })
    }
    if (remote.code === 127) {
      throw new DpError('DP.SSH.TOOL_MISSING', `目标机没有 tar（exit 127）：${remoteDetail}`, {
        hint: '在目标机装 tar，或改用 rsync-ssh',
      })
    }
    throw new DpError('DP.PATH.NOT_WRITABLE', `远端解包失败（tar ${remote.code}）：${remoteDetail}`, {
      hint: '确认目标目录存在且当前身份可写；需要提权就配 hosts.*.become',
    })
  }

  const warnings: string[] = [
    'tar-ssh 是全量传输，没有增量：每次都会重传全部内容',
  ]
  if (req_deleteUnsupported(pair)) warnings.push('tar-ssh 不删除目标上多余的文件')

  return {
    kind: 'tar-ssh',
    // tar 的 stdout 是二进制归档流，**不能**像 rsync 那样从输出里统计文件数；
    // 只报"我们确实打包了这么多条目"，别谎称"传输了这么多文件"
    filesTransferred: options.dryRun === true ? 0 : countEntries(pair),
    command: [...pair.local],
    exitCode: 0,
    warnings,
    ...(options.dryRun === true ? { dryRun: true } : {}),
  }
}

function req_deleteUnsupported(pair: TarArgvPair): boolean {
  return !pair.local.includes('--delete')
}

function countEntries(pair: TarArgvPair): number {
  const i = pair.local.indexOf('--')
  return i === -1 ? 0 : pair.local.length - i - 1
}

export { rshValueForRsync }
