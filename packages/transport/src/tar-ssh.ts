import { DpError } from '@dp/ports'
import { quoteArg, wrapCommand } from '@dp/ssh'
import { runProcess, summarizeFailure } from './proc.js'
import { buildRshArgv, rshValueForRsync } from './rsh.js'
import type { TransferRequest, TransferResult, SpawnImpl } from './types.js'
import type { RshOptions } from './rsh.js'

const FULL_TRANSFER = 'tar-ssh 是全量传输，没有增量：每次都会重传全部内容'

/**
 * tar-ssh 两侧的构造输入。
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
 */
export interface TarArgvPair {
  /** 本地打包端 */
  readonly local: readonly string[]
  /** 远端解包端：ssh 的 argv + 提权包装后的 tar */
  readonly remote: readonly string[]
}

/**
 * 同时产出本地与远端两段 argv，两侧同源于一次解析
 *
 * @param req 传输声明。清单为空直接拒绝：空的归档流在两端都「成功」，
 * 而那会让「部署成功」变成一句无法证伪的话
 * @param options 本地 tar 路径、rsh、目标标识，以及远端解包的提权方式
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
 * @param pair `buildTarArgv` 给出的两侧 argv
 * @param options 超时 / spawn 注入 / dryRun
 * @returns tar-ssh 路径的传输结果。`filesTransferred` 是**我们打包的条目数**，
 * 不是「对面收到了几个」—— 归档流没有回执，报成后者就是谎报
 * @throws DpError DP.VERIFY.FAILED（本地打包失败）、DP.SSH.CONNECT_FAILED（远端 255）、
 * DP.SSH.TOOL_MISSING（远端 127，目标机没有 tar）、DP.PATH.NOT_WRITABLE（远端解包失败）
 */
export async function runTarSsh(
  pair: TarArgvPair,
  options: RunTarSshOptions = {},
): Promise<TransferResult> {
  // tar-ssh 没有服务端干跑：真演练就是**不起进程**。以前这里照跑一遍、只把
  // 条目数报成 0 —— 那等于声称验证过远端，而远端一个字节都没被碰过。
  if (options.dryRun === true) {
    return {
      kind: 'tar-ssh',
      filesTransferred: 0,
      command: [...pair.local],
      exitCode: 0,
      warnings: [
        FULL_TRANSFER,
        'dry-run 没有起 tar：远端目录能否解包、磁盘是否够、链路是否通，这次一概没被验证',
      ],
      dryRun: true,
    }
  }

  const timeoutMs = options.timeoutMs
  const common = {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
  }
  // 两端并发跑：串行的话本地 tar 先产出一整个归档却没人接，管道会直接写满阻塞
  const [local, remote] = await Promise.all([
    runProcess(pair.local, { ...common, label: 'tar(local)' }),
    runProcess(pair.remote, { ...common, label: 'ssh(tar remote)' }),
  ])

  const localDetail = summarizeFailure(local.stderr)
  const remoteDetail = summarizeFailure(remote.stderr)

  if (local.code !== 0) {
    throw new DpError('DP.VERIFY.FAILED', `本地打包失败（tar ${local.code}）：${localDetail}`, {
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

  const warnings: string[] = [FULL_TRANSFER]
  if (req_deleteUnsupported(pair)) warnings.push('tar-ssh 不删除目标上多余的文件')

  return {
    kind: 'tar-ssh',
    // tar 的 stdout 是二进制归档流，**不能**像 rsync 那样从输出里统计文件数；
    filesTransferred: countEntries(pair),
    command: [...pair.local],
    exitCode: 0,
    warnings,
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
