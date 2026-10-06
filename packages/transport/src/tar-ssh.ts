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

/**
 * tar-ssh 两侧的构造输入。
 *
 * `become` 只作用于**远端解包端**：本机 tar 就在本机跑，给它套提权包装既没用，
 * 还会改变「本机到底执行了什么」这件事。放在这里而不是让两侧各从请求里读一次，
 * 是为了让「提权落在哪半边」只有一个地方说了算。
 */
export interface TarArgvOptions {
  readonly localTarPath: string
  readonly rsh: RshOptions
  readonly remoteTarget: string
  /** 远端解包命令是否需要提权包装 */
  readonly become?: TransferRequest['become']
}

/**
 * 两侧的 argv 必须**成对**返回，而不是两个各自独立的返回值。
 *
 * 成对而不是分开：任一半单独执行都不成立 —— 本机端产出的归档流
 * 没人接，远端端的 stdin 没人喂。分开传就会出现「只起了一半」的调用，而这种调用
 * 不报错，只是默默挂着。
 */
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
 *
 * @param req 传输声明。清单为空直接拒绝：空的归档流在两端都「成功」，
 *   而那会让「部署成功」变成一句无法证伪的话
 * @param options 本机 tar 路径、rsh、目标标识，以及远端解包的提权方式
 * @returns 两侧 argv。`--` 之后才是文件清单，之后追加的任何东西都不会被当成选项
 * @throws DpError DP.SOURCE.EMPTY（清单为空）
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

/**
 * 远端解包命令拼成一行，**只用于日志与结果展示**。
 *
 * 绝不拿它去 spawn：拼成串就意味着要靠一次拆分才能变回 argv，而拆分的规则两边
 * 未必一致（引号、空白、转义）。展示用的字符串与执行用的 argv 必须是两份东西，
 * 让同一份既展示又执行是这类包装最经典的出错口。
 *
 * @param argv 远端解包端的一整条 argv（含 ssh 选项与提权包装）
 * @returns 逐项转义后拼成的一行命令，供人读；不是可执行输入
 */
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
 *
 * @param pair `buildTarArgv` 给出的两侧 argv
 * @param options 超时 / spawn 注入 / dryRun
 * @returns tar-ssh 路径的传输结果。`filesTransferred` 是**我们打包的条目数**，
 *   不是「对面收到了几个」—— 归档流没有回执，报成后者就是谎报
 * @throws DpError DP.VERIFY.FAILED（本机打包失败）、DP.SSH.CONNECT_FAILED（远端 255）、
 *   DP.SSH.TOOL_MISSING（远端 127，目标机没有 tar）、DP.PATH.NOT_WRITABLE（远端解包失败）
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
