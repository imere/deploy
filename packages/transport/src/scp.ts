/**
 * scp 传输 —— 纯 argv + 注入式执行。
 *
 * 定位：**最后手段**（OpenSSH 9+ 的 scp 默认走 sftp 协议，
 * `-O` 只是为兼容老目标）。所以 `buildScpArgv` 显式带 `-O`，让行为确定，
 * 不依赖本机 scp 的版本默认值。
 *
 * 相对 rsync 的硬损失：不增量、不能删多余文件。所以 `deleteExtraneous`
 * 在这条路上**被拒绝而不是静默忽略** —— 静默忽略会让用户以为远端被清干净了。
 */
import { DpError } from '@dp/ports'
import { quoteArg, wrapCommand } from '@dp/ssh'
import { runProcess, summarizeFailure } from './proc.js'
import { buildRshArgv } from './rsh.js'
import type { TransferRequest, TransferResult, SpawnImpl } from './types.js'
import type { RshOptions } from './rsh.js'

/**
 * scp 侧构造 argv 的输入。
 *
 * 形状与 rsync 那套**刻意保持一致**（本机可执行文件路径 + 同一份 rsh + 目标标识）：
 * 两种传输在同一条偏好链上，调用方换一条路时不该重新学一套字段 —— 字段形状一变，
 * 「换传输方式」就变成一次需要改调用点的迁移。
 */
export interface ScpArgvOptions {
  /** 本机 scp 绝对路径（facts.tools.scp） */
  readonly scpPath: string
  /** 复用同一套 ssh 选项。scp 的 `-o` 与 ssh 同名同义 */
  readonly rsh: RshOptions
  readonly remoteTarget: string
}

/**
 * scp 的完整 argv。**纯函数**。
 *
 * `-O` 写死而不是留默认值：OpenSSH 9+ 的 scp 默认改走 sftp 协议，老目标机只认传统
 * SCP 协议。不写死的话，同一份配置会随**本机** scp 的版本不同而连出不同的结果，
 * 而版本恰恰是没人去看的东西。
 *
 * `deleteExtraneous` 与 `become` 在这里**抛错而不是静默忽略**：scp 协议既没有
 * 「删多余文件」也没有「包装远端命令」的位置。静默忽略的后果是用户以为远端被清干净了、
 * 以为提权生效了，而两者都没发生 —— 报告说做了、实际没做，是最难发现的一类错。
 *
 * @param req 传输声明
 * @param options scp 路径、rsh 选项与目标标识
 * @returns 可直接 spawn 的 argv
 * @throws DpError DP.SOURCE.EMPTY（清单为空）、DP.PREF.UNSUPPORTED（请求了 --delete，
 *   或请求了远端提权 —— 后者在 rsync 上有 `--rsync-path` 可以落，scp 没有）
 */
export function buildScpArgv(req: TransferRequest, options: ScpArgvOptions): readonly string[] {
  if (req.entries.length === 0) {
    throw new DpError('DP.SOURCE.EMPTY', '源清单为空，拒绝传输', {
      hint: '构建产物为空，或 include/exclude 把所有文件都排除了',
    })
  }
  if (req.deleteExtraneous === true) {
    throw new DpError('DP.PREF.UNSUPPORTED', 'scp 不支持删除目标上多出来的文件', {
      path: 'transport.delete',
      hint: 'scp 协议没有这个能力。想清理远端目录请用 rsync-ssh 的 --delete，或在目标机上显式清理',
    })
  }

  const argv: string[] = [options.scpPath, '-r', '-p', '-O', ...buildRshArgv(options.rsh).slice(1)]
  // scp 没有 `--dry-run` 这个选项，干跑就是 `-n`。
  // 千万别反过来：把 `-n` 加在**真跑**那条分支上，等于每一次真实传输都只做演练，
  // 退出码还是 0 —— 部署看起来全绿，目标机上一个字节都没变。
  if (req.dryRun === true) argv.push('-n')

  // 提权：scp 没有 --rsync-path，对应机制是给 ssh 的 RemoteCommand 之外的
  // 包装 —— 用 become 包住远端 scp 的 -t 指令做不到（协议内），所以这里只在
  // 远端目录需要提权时显式拒绝而不是假装支持。
  if (req.become !== undefined && req.become.type !== 'none') {
    throw new DpError('DP.PREF.UNSUPPORTED', 'scp 路径不支持远端提权', {
      path: 'hosts.*.become',
      hint: 'scp 协议没有可以包装远端命令的位置（rsync 有 --rsync-path）。需要提权请改用 rsync-ssh 或 tar-ssh',
    })
  }

  const src = `${req.localRoot.replace(/\/+$/, '')}/`
  for (const e of req.entries) argv.push(`${src}${e}`)
  const remote = `${options.remoteTarget}:${quoteArg(req.remoteRoot.endsWith('/') ? req.remoteRoot : `${req.remoteRoot}/`)}`
  argv.push(remote)
  return argv
}

export interface RunScpOptions {
  readonly timeoutMs?: number
  readonly spawnImpl?: SpawnImpl
  readonly dryRun?: boolean
  /** 清单条目数。scp 成功时不报告任何统计，所以文件数只能由调用方给的清单推 */
  readonly expectedEntries?: number
}

/**
 * 起 scp 并把退出码翻译成结果：255 单独认成 **ssh 层**失败而不混进「scp 失败」。
 *
 * 之所以要分这一层：scp 把 ssh 的错误原样冒上来，
 * 都归到「传输失败」会让人去查目标目录权限，而实际是连都没连上 —— 排障方向直接错，
 * 且这两类的处置完全不相干。
 *
 * @param argv `buildScpArgv` 的产出
 * @param options 超时 / spawn 注入 / dryRun。`expectedEntries` 是文件数的**唯一来源**：
 *   scp 成功时不输出任何统计，从 argv 反推条目数是猜，而猜出来的文件数会让人以为
 *   scp 做了它没做的事
 * @returns scp 路径的传输结果。dryRun 下 `filesTransferred` 恒为 0
 * @throws DpError DP.SSH.CONNECT_FAILED（255）、DP.PATH.NOT_WRITABLE（目标不可写 /
 *   找不到）、DP.VERIFY.FAILED（其它非 0 退出码）；超时与 prompt 由 `runProcess` 抛
 */
export async function runScp(
  argv: readonly string[],
  options: RunScpOptions = {},
): Promise<TransferResult> {
  const result = await runProcess(argv, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
    label: 'scp',
  })

  if (result.code !== 0) {
    const detail = summarizeFailure(result.stderr)
    if (result.code === 255) {
      throw new DpError('DP.SSH.CONNECT_FAILED', `scp 的 ssh 层失败：${detail}`, {
        hint: '检查主机可达性与凭据',
      })
    }
    if (result.code === 1 || /not found|no such file/i.test(detail)) {
      throw new DpError('DP.PATH.NOT_WRITABLE', `scp 传输失败：${detail || `exit ${result.code}`}`, {
        hint: '确认目标目录存在且可写',
      })
    }
    throw new DpError('DP.VERIFY.FAILED', `scp 失败（exit ${result.code}）：${detail}`, {
      hint: '带 --dry-run 重跑；scp 无增量与删除能力，考虑改用 rsync-ssh',
    })
  }

  return {
    kind: 'scp',
    // scp 成功时不输出任何机器可读统计：从 argv 反推条目数是**猜**，
    // 而"猜出来的文件数"会让人以为 scp 做了它没做的事。调用方给清单数。
    filesTransferred: options.dryRun === true ? 0 : (options.expectedEntries ?? 0),
    command: argv,
    exitCode: result.code,
    warnings: ['scp 是最后手段：不走增量，也无法删除目标上多余的文件'],
    ...(options.dryRun === true ? { dryRun: true } : {}),
  }
}

export { wrapCommand }
