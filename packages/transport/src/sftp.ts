/**
 * sftp 路径：批量脚本经 stdin 喂给 `sftp -b -`，逐文件 put。
 *
 * 它成立的条件最松 —— 只要 sshd 开了 sftp 子系统，不要求目标机装 rsync 或 tar；
 * 代价是既没有增量，也删不掉目标上多出来的文件（这两件事都被明确拒绝，不静默）。
 */
import { DpError } from '@dp/ports'
import { buildSftpBatch, sftpQuote } from '@dp/ssh'
import { runProcess, summarizeFailure } from './proc.js'
import { buildRshArgv } from './rsh.js'
import { sshOptionsForCopyTool } from './copy-opts.js'
import type { TransferRequest, TransferResult, SpawnImpl } from './types.js'
import type { RshOptions } from './rsh.js'

const NO_INCREMENTAL = 'sftp 是逐文件传输：没有增量，也无法删除目标上多余的文件'

/**
 * sftp 侧构造 argv 的输入。
 */
export interface SftpArgvOptions {
  /** 本地 sftp 绝对路径（facts.tools.sftp） */
  readonly sftpPath: string
  /** 复用同一套 ssh 选项。sftp 的 `-o` 与 ssh 同名同义 */
  readonly rsh: RshOptions
  readonly remoteTarget: string
}

/**
 * sftp 一次传输的完整产物：命令行与脚本**同源**产出，
 * 不可能出现改了清单却忘了改脚本的情况。
 */
export interface SftpPlan {
  /** 可直接 spawn 的 argv，末元素是目标标识 */
  readonly argv: readonly string[]
  /** `sftp -b -` 的批量脚本，从 stdin 喂 */
  readonly batch: string
  /**
   * 脚本里 put 的条数。sftp 批量模式不给机器可读回执，
   * 文件数只能来自我们自己下了几条 put —— 报别的数字就是猜。
   */
  readonly putCount: number
}

/**
 * 命令行与批量脚本同源产出：两者都从同一份清单算出，脚本里的 put 与清单逐条对应。
 *
 * @param req 传输声明。清单为空直接拒绝：一条 put 都没有却「成功」的传输会让
 * 「部署成功」变成一句无法证伪的话
 * @param options sftp 路径、rsh 选项与目标标识
 * @returns 命令行、批量脚本与 put 条数。脚本按「先建目录再传文件」排：sftp 的
 * put 不会自己建父目录，而带 `-` 前缀的 mkdir 忽略「已存在」的报错，于是同一份
 * 脚本既能建全新目录，也能往已存在的发布根里补文件
 * @throws DpError DP.SOURCE.EMPTY（清单为空）、DP.PREF.UNSUPPORTED（请求了
 * --delete，或请求了远端提权 —— sftp 子系统由 sshd 以登录用户的身份起，没有
 * 可以包装远端命令的位置）
 */
export function buildSftpPlan(req: TransferRequest, options: SftpArgvOptions): SftpPlan {
  if (req.entries.length === 0) {
    throw new DpError('DP.SOURCE.EMPTY', '源清单为空，拒绝传输', {
      hint: '构建产物为空，或 include/exclude 把所有文件都排除了',
    })
  }
  if (req.deleteExtraneous === true) {
    throw new DpError('DP.PREF.UNSUPPORTED', 'sftp 不支持删除目标上多出来的文件', {
      path: 'transport.delete',
      hint: '「多出来哪些」需要先递归列出远端再与本地清单比对，而 sftp 的批处理没有递归列目录。想清理远端目录请用 rsync-ssh 的 --delete，或在目标机上显式清理',
    })
  }
  if (req.become !== undefined && req.become.type !== 'none') {
    throw new DpError('DP.PREF.UNSUPPORTED', 'sftp 路径不支持远端提权', {
      path: 'hosts.*.become',
      hint: 'sftp 服务端由 sshd 以登录用户的身份起，脚本里没有可以包装成 sudo 的位置（rsync 有 --rsync-path，tar 走命令包装）。需要提权请改用 rsync-ssh 或 tar-ssh',
    })
  }

  const localRoot = req.localRoot.replace(/\/+$/, '')
  const remoteRoot = req.remoteRoot.replace(/\/+$/, '')

  const commands: string[] = []
  for (const dir of remoteDirs(remoteRoot, req.entries)) {
    commands.push(`-mkdir ${sftpQuote(dir)}`)
  }
  for (const entry of req.entries) {
    const relative = entry.replace(/^\/+/, '')
    commands.push(`put ${sftpQuote(`${localRoot}/${relative}`)} ${sftpQuote(`${remoteRoot}/${relative}`)}`)
  }

  return {
    argv: [
      options.sftpPath,
      '-b',
      '-',
      ...sshOptionsForCopyTool(buildRshArgv(options.rsh).slice(1)),
      options.remoteTarget,
    ],
    batch: buildSftpBatch(commands),
    putCount: req.entries.length,
  }
}

/**
 * 执行侧能覆盖的三件事：超时、spawn 注入、干跑。
 */
export interface RunSftpOptions {
  readonly timeoutMs?: number
  readonly spawnImpl?: SpawnImpl
  readonly dryRun?: boolean
}

/**
 * 把脚本经 stdin 喂给 sftp，再把非 0 退出码分成连不上 / 写不进 / 其它三类。
 *
 * @param plan `buildSftpPlan` 的产出。批量脚本从 stdin 喂 —— 那是协议数据，
 * 不是喂给交互式提示的人类输入，所以不违反「永不交互」
 * @param options 超时 / spawn 注入 / dryRun
 * @returns sftp 路径的传输结果。`filesTransferred` 取脚本里 put 的条数，不是
 * 「对面收到了几个」；dryRun 下不起进程，恒为 0
 * @throws DpError DP.SSH.CONNECT_FAILED（255）、DP.PATH.NOT_WRITABLE（目标目录
 * 建不出来 / 不可写）、DP.VERIFY.FAILED（其它非 0 退出码）；超时与 prompt 由
 * `runProcess` 抛
 */
export async function runSftp(plan: SftpPlan, options: RunSftpOptions = {}): Promise<TransferResult> {
  // sftp 没有服务端干跑：真演练就是**不起进程**。比「跑一遍但报 0」诚实得多，
  // 后者让人以为远端路径被验证过了。
  if (options.dryRun === true) {
    return {
      kind: 'sftp',
      filesTransferred: 0,
      command: plan.argv,
      exitCode: 0,
      warnings: [
        NO_INCREMENTAL,
        'dry-run 没有起 sftp：远端目录能否建出、磁盘是否够、链路是否通，这次一概没被验证',
      ],
      dryRun: true,
    }
  }

  const result = await runProcess(plan.argv, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
    stdin: plan.batch,
    label: 'sftp',
  })

  if (result.code !== 0) {
    const detail = summarizeFailure(result.stderr)
    if (result.code === 255) {
      throw new DpError('DP.SSH.CONNECT_FAILED', `sftp 的 ssh 层失败：${detail}`, {
        hint: '检查主机可达性与凭据；sftp 子系统被禁用时（sshd 的 Subsystem sftp 一行）也会落到这里',
      })
    }
    if (/no such file|not found|permission denied|cannot create|couldn't create/i.test(detail)) {
      throw new DpError('DP.PATH.NOT_WRITABLE', `sftp 传输失败：${detail || `exit ${result.code}`}`, {
        hint: '确认目标目录的父目录存在且登录身份可写；需要提权请改用 rsync-ssh 或 tar-ssh',
      })
    }
    throw new DpError('DP.VERIFY.FAILED', `sftp 失败（exit ${result.code}）：${detail}`, {
      hint: '带 --dry-run 重跑看清单；sftp 没有增量也没有删除能力，能装 rsync 就换回 rsync-ssh',
    })
  }

  return {
    kind: 'sftp',
    filesTransferred: plan.putCount,
    command: plan.argv,
    exitCode: result.code,
    warnings: [NO_INCREMENTAL],
  }
}

/** 目录层级，用于让父目录排在子目录前面 */
function depth(path: string): number {
  return path.split('/').filter((p) => p !== '').length
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i <= 0 ? path : path.slice(0, i)
}

function addAncestors(path: string, out: Set<string>): void {
  const parts = path.split('/').filter((p) => p !== '')
  for (let i = 1; i <= parts.length; i += 1) out.add(`/${parts.slice(0, i).join('/')}`)
}

function remoteDirs(remoteRoot: string, entries: readonly string[]): readonly string[] {
  const wanted = new Set<string>()
  addAncestors(remoteRoot, wanted)
  for (const entry of entries) {
    addAncestors(dirOf(`${remoteRoot}/${entry.replace(/^\/+/, '')}`), wanted)
  }
  return [...wanted].filter((d) => d !== '/' && d !== '').sort((a, b) => depth(a) - depth(b))
}
