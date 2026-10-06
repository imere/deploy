/**
 * rsync 传输 —— argv 构造是**纯函数**，执行是可注入 IO。
 *
 * 分界的理由：argv 里每一个字节都可能决定"连错机器"或"删掉不该删的目录"，
 * 而它完全由两个 Facts + 一个请求决定。所以它必须能在**没有任何 rsync 二进制、
 * 没有任何网络**的机器上被 100% 断言。IO 只从 `runRsync` 才开始。
 *
 * 提权走 `--rsync-path`，复用 `@dp/ssh` 的 `wrapCommand`，
 * 不自己拼 sudo —— 拼错一次就是"以为提权了其实没提权"，最坏情况是静默以普通
 * 用户身份写一半然后失败。
 */
import { DpError } from '@dp/ports'
import { quoteArg, wrapCommand } from '@dp/ssh'
import { redact } from '@dp/log'
import { runProcess, summarizeFailure, type RunProcessResult } from './proc.js'
import { buildRshArgv, rshValueForRsync, type RshOptions } from './rsh.js'
import type { TransferRequest, TransferResult, SpawnImpl } from './types.js'

/**
 * 构造 rsync argv 需要的外部输入。
 *
 * 三样东西全部来自**探测**而不是配置：`rsyncPath` 与 `rsh.sshPath` 是 `facts.tools`
 * 的实证结果，`remoteTarget` 只是个标识。让调用方直接传命令路径，就等于允许
 * 「配置里写一个并不存在的 rsync」—— 而协商是按 facts 做的，两处会悄悄分叉。
 */
export interface RsyncArgvOptions {
  /** 本机 rsync 绝对路径与本机 ssh 绝对路径（均来自 facts.tools） */
  readonly rsyncPath: string
  readonly rsh: RshOptions
  /** 目标主机标识，不含 user 前缀。rsync 自己追加 `[-l user] host`，所以它只在目标串里出现 */
  readonly remoteTarget: string
  /**
   * 额外要求保留 owner/group。默认**不再追加** `-o -g`：多数的部署身份没有 chown 权限，
   * 显式追加强制保留会让 rsync 对**每一个**条目去 chown/chgrp —— 做不到时要么报一堆
   * 权限错误把真正的传输错误淹掉，要么静默丢掉属主而让人以为保留了。
   * 需要它时必须显式打开：那时用户已经确认自己有这个权限。
   */
  readonly preserveOwner?: boolean
}

const rsyncPath = (req: TransferRequest): string =>
  req.remoteRoot.endsWith('/') ? req.remoteRoot : `${req.remoteRoot}/`

/**
 * `--rsync-path` 的值：用提权命令把远端 `rsync` **这一个词**包起来。
 *
 * 只包装一个词而不是写整条命令，是因为 `--rsync-path` 是**前缀**：rsync 会在后面
 * 追加 `--server` 及它自己的参数。补写完整命令就会变成「我们要执行的命令」，
 * 少一个 `--server` 就对不上协议，而对不上时 rsync 报的是别的错。
 *
 * @param become 远端提权方式（@dp/ports）。`undefined` 或 `type: 'none'` 表示不提权
 * @returns 逐项转义过的提权前缀；**不提权时返回 undefined**，让调用方根本不加这个
 *   选项 —— 加一个空值会让 rsync 去执行一个空命令
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
 *
 * @param req 传输声明。清单为空直接拒绝 —— 空清单会让"部署成功"变成一句无法证伪的话
 * @param options rsync 路径、rsh、目标标识，以及是否额外保留属主
 * @returns 可直接 spawn 的 argv，不经 shell
 * @throws DpError DP.SOURCE.EMPTY（清单为空）、DP.CONFIG.INVALID（目标标识为空串）；
 *   rsh 含空白时由 `rshValueForRsync` 抛
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
 * 退出码 → 「这次传输算不算成」的判定表。
 *
 * **23/24 绝不能「静默」当成功**：它们表示"部分文件在传输过程中变了或消失了"。
 * 所以这里 `ok: true` 但 `partial: true`，由 `runRsync` 把它翻成一条 warning ——
 * 直接判失败会让「源目录里有个临时文件被清掉」这种无害抖动也把部署打断，
 * 而完全不报则会让部署看起来绿、目标上的文件其实是缺的（最难查的一类事故）。
 *
 * 255 必须**再往下细分**（认证 / 主机密钥 / 连接）：rsync 对 ssh 层的失败一律只给 255，
 * 而这三类的处置完全不是一回事 —— 认证失败要去看 identityFile 与 authorized_keys，
 * 主机密钥不匹配要人确认目标机身份（永不自动放行），连接失败才去查端口与防火墙。
 * 合成一个「ssh 失败」就等于把用户扔进三种排查里随机挑一个，平均要试三次。
 *
 * @param code rsync 自己的退出码，原值传进来（不归一化）
 * @param stderr 原始 stderr。里面的路径与用户会在进 message 前被脱敏
 * @returns `ok` 是否算成功、`partial` 是否只是部分成功（23/24）、失败时 `error` 带可执行的 hint。
 *   **不抛错**：判定与处置分开，让调用方能先记日志再决定
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

/**
 * 只有**真能从输出里读出来**的字段才放在这里 —— 读不出来的字段一律留空而不是填 0，
 * 因为 0 会被上层当成「确实传了 0 个」，而那是和「没读出来」相反的一个结论。
 *
 * `--stats` 给得出文件数与字节数，但给不出「哪些文件失败了」这类结论；
 * 缺的这种就不硬造一个字段，报告里还有退出码可以判定成败。
 */
export interface RsyncStats {
  readonly filesTransferred: number
  readonly bytes?: number
  /** 传输途中消失/变化的文件，源到目标不一致的信号 */
  readonly vanished: readonly string[]
}

/**
 * 从 rsync 的 stdout 里读统计。
 *
 * 优先读 `--stats` 的汇总行而不是自己数 itemize 行：汇总行是 rsync 自己算的权威数字，
 * 而逐行数 `%i` 行会把目录项与 `*deleting` 项也算进去 —— 两边口径不同，
 * 「我传了几个文件」就会因读法不同而变。
 *
 * 汇总行读不到时**退回 0 而不抛错**：统计数字读不出来不该让一次已经成功的传输失败，
 * 它只是少了一个数字，而报告里还有退出码可以判定成败。
 *
 * @param stdout rsync 的完整 stdout（含 `--stats` 段与 itemize 行）
 * @returns 文件数与字节数（读不出字节数时不带这个键），以及被判定为「源与目标不一致」的条目
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

/**
 * 起 rsync 并把退出码翻译成结果。23/24 走 warning，不静默当成功。
 *
 * 这里是**唯一**把 `classifyRsyncExit` 的结论变成 throw 的地方：判定与抛错分开，
 * 是为了让退出码分类可以脱离子进程被逐条断言，而执行层只管「该不该抛」。
 *
 * @param argv `buildRsyncArgv` 的产出，不经 shell
 * @param options 超时 / spawn 注入 / dryRun。dryRun 下 `filesTransferred` 恒为 0：
 *   一个从清单推出来的数字会让人以为真的搬了东西
 * @returns rsync 路径的传输结果，外加 `partial`（部分传输）。`command` 是脱敏后的 argv
 * @throws DpError 由 `classifyRsyncExit` 判定出的那个码（认证 / 主机密钥 / 连接 / 权限 / 缺工具 /
 *   验证失败）；超时与 prompt 由 `runProcess` 抛
 */
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
