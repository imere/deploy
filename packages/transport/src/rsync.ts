/**
 * rsync 传输 —— argv 构造是**纯函数**，执行是可注入 IO。
 *
 * 分界的理由：argv 里每一个字节都可能决定"连错机器"或"删掉不该删的目录"，
 * 而它完全由两个 Facts + 一个请求决定。所以它必须能在**没有任何 rsync 二进制、
 * 没有任何网络**的机器上被 100% 断言。IO 只从 `runRsync` 才开始。
 *
 * 提权走 `--rsync-path`（docs/transport.md §6），复用 `@dp/ssh` 的 `wrapCommand`，
 * 不自己拼 sudo —— 拼错一次就是"以为提权了其实没提权"，最坏情况是静默以普通
 * 用户身份写一半然后失败。
 */
import { DpError } from '@dp/ports'
import { quoteArg, wrapCommand } from '@dp/ssh'
import { redact } from '@dp/log'
import { runProcess, summarizeFailure, type RunProcessResult } from './proc.js'
import { buildRshArgv, rshValueForRsync, type RshOptions } from './rsh.js'
import type { TransferRequest, TransferResult, SpawnImpl } from './types.js'

export interface RsyncArgvOptions {
  /** 本机 rsync 绝对路径与本机 ssh 绝对路径（均来自 facts.tools） */
  readonly rsyncPath: string
  readonly rsh: RshOptions
  /** 目标主机标识，不含 user 前缀。rsync 自己追加 `[-l user] host`，所以它只在目标串里出现 */
  readonly remoteTarget: string
  /**
   * 保留 owner/group。默认**不带** `-o -g`：多数部署用户没有 chown 权限，
   * 带了会在每台机器上稳定失败（spikes.md S7 的教训：看起来有 ≠ 真能用）。
   */
  readonly preserveOwner?: boolean
}

const rsyncPath = (req: TransferRequest): string =>
  req.remoteRoot.endsWith('/') ? req.remoteRoot : `${req.remoteRoot}/`

/**
 * 提权后的远端 rsync 前缀。
 *
 * `--rsync-path` 是**前缀**而非完整命令：rsync 自己会在后面追加 `--server`。
 * 所以这里包装的只有 `rsync` 这一个词。
 */
export function buildRsyncPath(become: TransferRequest['become']): string | undefined {
  if (become === undefined || become.type === 'none') return undefined
  return wrapCommand(['rsync'], become).map(quoteArg).join(' ')
}

/**
 * 纯函数：rsync 的完整 argv。
 *
 * 关键选项各自的**原因**：
 *  - `-a` 而不是逐项列 `-rlptD`：等价，少写；但不含 `-o -g`（见上）
 *  - `--delete` 按 `deleteExtraneous`，**默认关**（往非我们管理的目录做删除不可接受）
 *  - `--itemize-changes`：让输出可解析，而不是靠人看 `sending incremental file list`
 *  - `--human-readable=0`：机器读，人格式的 "1.23K" 要反解
 *  - `--out-format=%i %n`：逐行可解析；不指定时 rsync 对 0 字节文件会整行省略
 */
export function buildRsyncArgv(
  req: TransferRequest,
  options: RsyncArgvOptions,
): readonly string[] {
  if (req.entries.length === 0) {
    throw new DpError('DP.SOURCE.EMPTY', '源清单为空，拒绝传输', {
      hint: '构建产物为空，或 include/exclude 把所有文件都排除了',
    })
  }
  if (options.remoteTarget.trim() === '') {
    throw new DpError('DP.CONFIG.INVALID', '远端目标标识为空', { hint: 'remote 传输需要 sshTarget 或 host' })
  }

  const argv: string[] = [options.rsyncPath, '-a']

  if (options.preserveOwner === true) argv.push('-o', '-g')
  if (req.deleteExtraneous === true) argv.push('--delete')
  if (req.dryRun === true) argv.push('--dry-run')

  argv.push('--itemize-changes', '--human-readable=0', '--out-format=%i %n', '--stats')
  argv.push('-e', rshValueForRsync(buildRshArgv(options.rsh)))

  const rsyncPathOpt = buildRsyncPath(req.become)
  if (rsyncPathOpt !== undefined) argv.push(`--rsync-path=${rsyncPathOpt}`)

  // 源是本机路径；远端写成 `host:path`，path 走 @dp/ssh 的 quoteArg（唯一转义出口）
  const src = `${req.localRoot.replace(/\/+$/, '')}/`
  for (const e of req.entries) {
    argv.push(`${src}${e.split('/').join('/')}`)
  }
  argv.push(`${options.remoteTarget}:${quoteArg(rsyncPath(req))}`)
  return argv
}

// ------------------------------------------------------------
// 退出码 → 结果
// ------------------------------------------------------------

/**
 * rsync 的退出码分类。
 *
 * **23/24 绝不能「静默」当成功**：它们表示"部分文件在传输过程中变了或消失了"。
 * 所以这里 `ok: true` 但 `partial: true`，由 `runRsync` 把它翻成一条 warning ——
 * 直接判失败会让「源目录里有个临时文件被清掉」这种无害抖动也把部署打断，
 * 而完全不报则会让部署看起来绿、目标上的文件其实是缺的（最难查的一类事故）。
 * 255 是 ssh 层失败（rsync 自己给不出更细的码），要带上 ssh 的原话。
 */
export function classifyRsyncExit(
  code: number,
  stderr: string,
): { readonly ok: boolean; readonly partial: boolean; readonly error?: DpError } {
  const detail = summarizeFailure(redactString(stderr))
  if (code === 0) return { ok: true, partial: false }
  if (code === 23 || code === 24) return { ok: true, partial: true }
  if (code === 25) {
    return {
      ok: false,
      partial: false,
      error: new DpError('DP.VERIFY.FAILED', `rsync 全部文件传输失败：${detail}`, {
        hint: '检查目标目录权限与磁盘空间；或在目标机装上 rsync',
      }),
    }
  }
  if (code === 11 || code === 12) {
    return {
      ok: false,
      partial: false,
      error: new DpError('DP.PATH.NOT_WRITABLE', `目标机路径或权限问题（rsync ${code}）：${detail}`, {
        hint: '确认目标目录存在且当前身份可写。需要提权就配 hosts.*.become（我们只包装，不替你改 sudoers）',
      }),
    }
  }
  if (code === 127) {
    return {
      ok: false,
      partial: false,
      error: new DpError('DP.SSH.TOOL_MISSING', `目标机找不到 rsync（exit 127）：${detail}`, {
        hint: '要么在目标机装 rsync，要么在配置里把传输方式降级为 tar-ssh（两端都有 tar 时可用）',
      }),
    }
  }
  if (code === 255) {
    return { ok: false, partial: false, error: sshError(detail) }
  }
  return {
    ok: false,
    partial: false,
    error: new DpError('DP.VERIFY.FAILED', `rsync 失败（exit ${code}）：${detail}`, {
      hint: '带 --dry-run 重跑看它到底要做什么；同时确认传输方式与两端工具仍然匹配',
    }),
  }
}

function sshError(detail: string): DpError {
  const auth = /permission denied|authentication failed|too many authentication failures|too many failures/i.test(
    detail,
  )
  if (auth) {
    return new DpError('DP.SSH.AUTH_FAILED', `ssh 认证失败：${detail}`, {
      hint: '检查 identityFile / 远端 authorized_keys。铁律 0：不会退化成交互式密码输入',
    })
  }
  const hostKey = /host key verification failed|no matching host key|remote host identification/i.test(
    detail,
  )
  if (hostKey) {
    return new DpError('DP.SSH.HOST_KEY_MISMATCH', `主机密钥校验失败：${detail}`, {
      hint: '确认目标机身份后再更新 known_hosts。主机密钥不匹配永不自动放行',
    })
  }
  return new DpError('DP.SSH.CONNECT_FAILED', `ssh 连接失败：${detail}`, {
    hint: '检查主机可达性、端口、防火墙与跳板链',
  })
}

/** ssh 的 stderr 会带出目标机上的路径与用户，必须过一遍脱敏才能进 message */
function redactString(text: string): string {
  const out = redact(text, {})
  return typeof out === 'string' ? out : String(out)
}

// ------------------------------------------------------------
// 输出解析
// ------------------------------------------------------------

export interface RsyncStats {
  readonly filesTransferred: number
  readonly bytes?: number
  /** 传输途中消失/变化的文件，源到目标不一致的信号 */
  readonly vanished: readonly string[]
}

/**
 * 解析 rsync 的机器可读输出。
 *
 * 优先用 `--stats` 的汇总行（权威），拿不到再退到 itemize 行计数 —— 汇总行
 * 在老版本 rsync 上格式可能变，届时至少不崩。
 */
export function parseRsyncOutput(stdout: string): RsyncStats {
  const filesMatch = /Number of regular files transferred:\s*([\d,]+)/.exec(stdout)
  const bytesMatch = /Total file size:\s*([\d,]+)/.exec(stdout)
  const vanished: string[] = []

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    // %i 的形状是「1 个更新类型 + 10 个属性字符」，例如 `>f+++++++++` / `cd+++++++++`。
    // 目标上多出来的（*deleting）与新建的（全 +）都是"源到目标不一致"的信号。
    const code = line.slice(0, 11)
    if (code.startsWith('*') || code.slice(1).includes('+++++++++')) {
      vanished.push(line.trim())
    }
  }

  const toNum = (m: RegExpExecArray | null): number | undefined => {
    if (m === null) return undefined
    const n = Number(m[1]!.replaceAll(',', ''))
    return Number.isFinite(n) ? n : undefined
  }

  const files = toNum(filesMatch)
  return {
    filesTransferred: files ?? 0,
    ...(toNum(bytesMatch) !== undefined ? { bytes: toNum(bytesMatch) } : {}),
    vanished,
  }
}

// ------------------------------------------------------------
// 执行
// ------------------------------------------------------------

export interface RunRsyncOptions {
  readonly timeoutMs?: number
  readonly spawnImpl?: SpawnImpl
  readonly dryRun?: boolean
}

/** 起 rsync 并把退出码翻译成结果。23/24 走 warning，不静默当成功。 */
export async function runRsync(
  argv: readonly string[],
  options: RunRsyncOptions = {},
): Promise<TransferResult & { readonly partial: boolean }> {
  const result: RunProcessResult = await runProcess(argv, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
    label: 'rsync',
  })

  const verdict = classifyRsyncExit(result.code, result.stderr)
  if (verdict.error !== undefined) throw verdict.error

  const stats = parseRsyncOutput(result.stdout)
  const warnings: string[] = []
  if (verdict.partial) {
    warnings.push(
      `rsync 部分传输（exit ${result.code}）：有文件在传输过程中被改动或消失。目标上的内容可能与源不一致，请重跑一次核对`,
    )
  }
  for (const v of stats.vanished) warnings.push(`rsync 报告：${v}`)

  return {
    kind: 'rsync-ssh',
    filesTransferred: options.dryRun === true ? 0 : stats.filesTransferred,
    ...(stats.bytes !== undefined ? { bytes: stats.bytes } : {}),
    command: argv,
    exitCode: result.code,
    warnings,
    partial: verdict.partial,
    ...(options.dryRun === true ? { dryRun: true } : {}),
  }
}
