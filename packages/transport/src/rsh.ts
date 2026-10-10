import { DpError } from '@dp/ports'
import {
  buildRshArgv as buildSshRshArgv,
  rshOptionValue,
  type KnownHostsMode,
  type SshAuthKind,
} from '@dp/ssh'

/**
 * 多跳的两种形态。
 */
export type HopMode =
  /** `-J a,b`（OpenSSH 7.3+），走 direct-tcpip 转发 */
  | 'proxy-jump'
  /** `-o ProxyCommand=ssh <jump> -W %h:%p`，直连转发被拒时的退路 */
  | 'proxy-command-w'
  /** `-o ProxyCommand=ssh <jump> nc %h %p`，跳板禁 TCP 转发但允许 exec 时的退路 */
  | 'proxy-command-nc'

/**
 * 连接阶段的兜底超时（**秒**），写进 ssh 的 `-o ConnectTimeout=`。
 */
export const DEFAULT_CONNECT_TIMEOUT_SEC = 15

/**
 * 造 `--rsh` / `-e` 需要的 ssh 选项。
 */
export interface RshOptions {
  /** 本地 ssh 可执行文件的绝对路径（来自 facts.tools.ssh） */
  readonly sshPath: string
  /**
   * 认证方式。key/agent 才会带 `BatchMode=yes` —— 密码类不能带，因为 BatchMode 会关掉 SSH_ASKPASS 靠的那个询问（@dp/ssh argv.ts 注释）。
   */
  readonly authKind: SshAuthKind

  readonly knownHostsMode: KnownHostsMode
  readonly userKnownHostsFile?: string
  readonly identityFile?: string
  readonly port?: number
  readonly connectTimeoutSec?: number
  /** 按到达目标的顺序：[jump1, jump2] */
  readonly hops?: readonly string[]
  readonly hopMode?: HopMode
  readonly extraOptions?: readonly string[]
}

const hasWhitespace = (s: string): boolean => /[\s]/.test(s)

/**
 * 构造 `--rsh` 的 argv 前缀。
 *
 * @param options ssh 路径、认证方式、主机密钥策略、跳板链等。`hops` 顺序即到达顺序，
 * **最后一跳是目标机**，所以它不进 `-J`
 * @returns `--rsh` 的 argv 前缀，**不含主机名**，也不含 `rsync --server` 那半截
 * @throws DpError DP.CONFIG.INVALID：ProxyCommand 形态收到多跳（它只表达一跳）、
 * 跳板标识含空白或为空（无法作为单个 argv）、ConnectTimeout 不是正整数秒
 */
export function buildRshArgv(options: RshOptions): readonly string[] {
  const hops = options.hops ?? []
  const hopMode = options.hopMode ?? 'proxy-jump'
  const connectTimeoutSec = options.connectTimeoutSec ?? DEFAULT_CONNECT_TIMEOUT_SEC

  if (hops.length > 1 && hopMode !== 'proxy-jump') {
    // ProxyCommand 只表达一跳的转发；多跳链只能交给 -J 或自建助手
    throw new DpError('DP.CONFIG.INVALID', `ProxyCommand 形态只支持一跳，收到 ${hops.length} 跳`, {
      path: 'hosts.*.hops',
      hint: '多跳请用 -J（hopMode 默认值）；只有单跳且跳板禁 TCP 转发时才有必要退到 ProxyCommand',
    })
  }
  if (hops.length > 0) {
    for (const h of hops) {
      if (h.trim() === '' || hasWhitespace(h)) {
        throw new DpError('DP.CONFIG.INVALID', `跳板标识含空白，无法作为单个 argv 传给 ssh：${JSON.stringify(h)}`, {
          path: 'hosts.*.hops',
          hint: "写成 'user@host' 或 'user@host:port'，一个跳板一个元素",
        })
      }
    }
  }
  if (!Number.isInteger(connectTimeoutSec) || connectTimeoutSec <= 0) {
    throw new DpError('DP.CONFIG.INVALID', `ConnectTimeout 必须为正整数秒：${connectTimeoutSec}`, {
      path: 'hosts.*.connectTimeout',
      hint: '写 15 或 30 这样的整数；连接超时必须由我们自己兜底，不能让 ssh 无限等（铁律 0）',
    })
  }

  // 跳板链：-J 是 ssh 自己的选项，不进 remoteArgv（那里只放远端命令）
  const proxyJump = hopMode === 'proxy-jump' && hops.length > 0 ? hops.join(',') : undefined
  // ProxyCommand 含空格，只能作为 extraOptions 里的 -o 值整体存在
  const proxyCommand =
    hops.length > 0 && hopMode !== 'proxy-jump'
      ? hopMode === 'proxy-command-w'
        ? `ssh ${hops[0]} -W %h:%p`
        : `ssh ${hops[0]} nc %h %p`
      : undefined

  const extra = [
    ...(options.extraOptions ?? []),
    ...(proxyCommand === undefined ? [] : ['-o', `ProxyCommand=${proxyCommand}`]),
    '-o',
    `ConnectTimeout=${connectTimeoutSec}`,
  ]

  const argv = buildSshRshArgv({
    sshPath: options.sshPath,
    authKind: options.authKind,
    knownHostsMode: options.knownHostsMode,
    identitiesOnly: true,
    ...(options.identityFile !== undefined ? { identityFile: options.identityFile } : {}),
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.userKnownHostsFile !== undefined ? { userKnownHostsFile: options.userKnownHostsFile } : {}),
    ...(proxyJump !== undefined ? { proxyJump } : {}),
    extraOptions: extra,
  })

  return argv
}

/**
 * 把 rsh argv 压成 rsync `-e` 接受的那个**单字符串**。
 *
 * @param argv `buildRshArgv` 的返回值（不含主机名）
 * @returns 可以直接交给 rsync `-e` 的单字符串
 * @throws DpError DP.CONFIG.INVALID：argv 里有含空白的元素（典型是 ProxyCommand 形态），
 * hint 里给出两条出路（改 `-J` 形态 / 走 dp-rsh 助手）
 */
export function rshValueForRsync(argv: readonly string[]): string {
  try {
    return rshOptionValue(argv)
  } catch (err) {
    const proxyCommand = argv.find((a) => a.startsWith('ProxyCommand='))
    if (proxyCommand !== undefined) {
      throw new DpError('DP.CONFIG.INVALID', 'ProxyCommand 形态的 rsh 无法通过 rsync 的 -e 传递', {
        path: 'hosts.*.hops',
        hint:
          `原因：rsync 把 -e 的值按空白拆分且不过 shell，而 ${proxyCommand.slice(0, 40)}… 里含空格。` +
          '两条出路：1) 改用 -J 形态（hopMode 缺省即 proxy-jump，无空白）；' +
          '2) 走 dp-rsh 自建 remote-shell 助手，argv 经 IPC 传递不拆分',
        cause: err,
      })
    }
    throw err
  }
}
