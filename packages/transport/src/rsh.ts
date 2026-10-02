/**
 * 给 rsync 的 `--rsh` 造 argv —— **纯函数，零 IO**。
 *
 * 契约来自 docs/spikes.md S5（实测 rsync 3.5.0）：
 *
 * ```
 * < -e 的 argv（按空白拆分）... >  [ -l <user> ] <host> rsync --server [--sender] <flags> <src> <dst>
 * ```
 *
 * 四条实测事实，各自对应本文件的一条约束：
 *
 *  1. **`%h` 不会被 rsync 替换** —— 实测传进去的是字面 `%h`。所以 rsh argv 里
 *     **绝不能出现主机名**（rsync 会自己追加），也绝不能指望 `%h`。
 *     混淆点：ssh **自己**的 ProxyCommand `%h`/`%p` 确实会被替换 —— 替换发生在
 *     ssh 进程内，rsync 只是把字符串原样转交。两个 `%h` 不是同一个东西。
 *  2. **不经过 shell** —— rsync 侧没有注入面（实测 `;touch` 只是普通 argv）。
 *  3. 无 user 前缀时省略 `-l <user>`。
 *  4. `RSYNC_RSH` 与 `-e` 等价。
 *
 * ## rsync 的 `-e` 有空白拆分限制（本文件最重要的一条约束）
 *
 * rsync 把 `-e` 的值按**空白**拆成多个 argv，且不做 shell 解析。所以
 * `-o ProxyCommand=ssh jump -W %h:%p` 里的空格会让它被切成三段而彻底错乱。
 * 结论：
 *  - `proxy-jump`（`-J a,b`）**无空白**，可以直接走 `-e`；
 *  - 两种 ProxyCommand 形态的 argv 可以构造（单测覆盖），但**不能**经由
 *    `rshOptionValue()` 交给 rsync —— 那条路要换 docs/transport.md §6 的
 *    dp-rsh 自建助手（argv 走 IPC，不经空白拆分）。本文件把这条边界做成显式断言。
 */
import { DpError } from '@dp/ports'
import {
  buildRshArgv as buildSshRshArgv,
  rshOptionValue,
  type KnownHostsMode,
  type SshAuthKind,
} from '@dp/ssh'

/**
 * 多跳的两种形态。
 *
 * 选 `proxy-jump` 的理由不只是"更短"：它是唯一**不含空白**的形态，
 * 因此唯一能原样交给 rsync `-e` 的形态。
 */
export type HopMode =
  /** `-J a,b`（OpenSSH 7.3+），走 direct-tcpip 转发 */
  | 'proxy-jump'
  /** `-o ProxyCommand=ssh <jump> -W %h:%p`，直连转发被拒时的退路 */
  | 'proxy-command-w'
  /** `-o ProxyCommand=ssh <jump> nc %h %p`，跳板禁 TCP 转发但允许 exec 时的退路（spikes.md S4） */
  | 'proxy-command-nc'

export const DEFAULT_CONNECT_TIMEOUT_SEC = 15

export interface RshOptions {
  /** 本机 ssh 可执行文件的绝对路径（来自 facts.tools.ssh） */
  readonly sshPath: string
  /**
   * 认证方式。key/agent 才会带 `BatchMode=yes` —— 密码类不能带，
   * 因为 BatchMode 会关掉 SSH_ASKPASS 靠的那个询问（@dp/ssh argv.ts 注释）。
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
 * **返回的 argv 不含主机名，也不含 `rsync --server`** —— 那半截是 rsync 自己追加的
 * （spikes.md S5 实测样本 `ARGC=8 [-l][dpuser][dp-target][rsync][--server]...`）。
 * 写上主机名会变成"连错两次"。
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
 * 这里额外做一件事：rsync 按空白拆分 `-e`，所以含空白的 argv 元素（典型就是
 * ProxyCommand 形态）**不能**这么用。@dp/ssh 的 `rshOptionValue` 会抛一个纯
 * 事实性错误；我们把它翻译成可执行的下一步。
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
          `原因：rsync 把 -e 的值按空白拆分且不过 shell（spikes.md S5），而 ${proxyCommand.slice(0, 40)}… 里含空格。` +
          '两条出路：1) 改用 -J 形态（hopMode 缺省即 proxy-jump，无空白）；' +
          '2) 走 docs/transport.md §6 的 dp-rsh 自建 remote-shell 助手，argv 经 IPC 传递不拆分',
        cause: err,
      })
    }
    throw err
  }
}
