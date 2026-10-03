/**
 * 拼 argv —— **纯函数，零 IO**。
 *
 * 这里是"命令注入"的唯一出口。铁律：任何用户可控的片段（路径、远端脚本、
 * known_hosts 里的主机名）都必须先过 `quoteArg`，且它是**唯一**允许把
 * 字符串拼进 shell 语义的地方。
 *
 * 关于 rsync `--rsh`：下面的契约都是实测出来的，四条事实逐条影响本文件：
 *  1. `%h` **不会**被替换 —— 所以 rshArgv 里绝不能出现 `%h`
 *  2. 不经过 shell —— rsync 侧没有注入面
 *  3. 无 user 前缀时 rsync 会省略 `-l <user>`，用它自己的本地用户名
 *  4. `RSYNC_RSH` 与 `-e` 等价
 */
import { DpError } from '@dp/ports'
import type { KnownHostsMode } from './driver.js'

// ------------------------------------------------------------
// POSIX 单引号转义
// ------------------------------------------------------------

/** 只需引号的字符集：尽量少引，让常见路径保持人眼可读（错误信息里会显示） */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * POSIX 单引号转义。
 *
 * 规则只有一条：把内容整体塞进一对单引号，里面的单引号按 `'\''` 断开再续上。
 * 这条规则**没有例外** —— `$`、反引号、换行、空格、`;` 全部因为落在单引号内
 * 而失去特殊含义。不做 Windows cmd 转义：远端是 POSIX 才是主场景，
 * 硬塞 cmd 规则只会制造"看起来转义了其实没转义"的假安全感。
 */
export function quoteArg(arg: string): string {
  if (arg === '') return "''"
  if (SHELL_SAFE.test(arg)) return arg
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/** 逐参数转义后用空格拼成一条脚本。只在必须过一层 shell 时用（su -c、sh -c）。 */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}

/**
 * 把 argv 变成一条**远端命令字符串**。
 *
 * 存在的理由：ssh2 的 `exec()` 只接受一个字符串（`client.exec(command, ...)`），
 * 所以这条路径上**没有 ssh 帮我们转义** —— 拼接时的转义是这里唯一的防线。
 * 原生 ssh 路径不需要它：`buildSshArgv` 把远端命令作为独立 argv 追加，
 * 转义由 ssh 自己负责（事实 2：不过 shell）。
 *
 * 换行一律**拒绝**而不是转义：换行在远端 shell 里是命令分隔符，
 * 而且任何 argv 元素里出现换行本身就说明上游拼接错了。
 */
export function buildRemoteCommand(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new DpError('DP.CONFIG.INVALID', 'buildRemoteCommand 收到空 argv', {
      hint: '至少给出可执行文件名',
    })
  }
  for (const arg of argv) {
    if (arg.includes('\n') || arg.includes('\r') || arg.includes('\0')) {
      throw new DpError('DP.CONFIG.INVALID', '远端命令参数含换行或 NUL，已拒绝', {
        hint: '换行与 NUL 在远端 shell 里都是注入面（换行是命令分隔符，NUL 会截断 C 层字符串）。把它们换成一个参数内部的空格或显式的 sh -c 脚本',
      })
    }
  }
  return argv.map(quoteArg).join(' ')
}

/**
 * 把「远端环境变量」变成 `-o SetEnv=K=V` 选项。
 *
 * OpenSSH 7.6+ 才有 SetEnv。**注意**：服务端 `sshd_config` 的 `AcceptEnv`
 * 没有列出这个名字时，ssh 会**静默忽略**它 —— 所以这仍然是「配了才生效」的能力，
 * 这一点在 hint 里写明，不假装它是必然生效的。
 *
 * 键名只允许 POSIX 环境变量名那套字符；值里禁换行/NUL（原因同上）。
 */
export function setEnvOptions(env: Readonly<Record<string, string>>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new DpError('DP.CONFIG.INVALID', `非法环境变量名：${JSON.stringify(k)}`, {
        hint: '只能用 POSIX 环境变量名：字母或下划线开头，后接字母、数字、下划线',
      })
    }
    if (v.includes('\n') || v.includes('\r') || v.includes('\0')) {
      throw new DpError('DP.CONFIG.INVALID', `环境变量 ${k} 的值含换行或 NUL，已拒绝`, {
        hint: '凭据与多行内容不走环境变量',
      })
    }
    out.push('-o', `SetEnv=${k}=${v}`)
  }
  return out
}

// ------------------------------------------------------------
// ssh 客户端 argv
// ------------------------------------------------------------

export type SshAuthKind = 'key' | 'agent' | 'password' | 'keyboard-interactive'

export interface SshArgvOptions {
  readonly authKind: SshAuthKind
  readonly port?: number
  readonly identityFile?: string
  /** 无 agent 可用时禁用公钥，避免 ssh 挨个试过把失败计数打满 */
  readonly identitiesOnly?: boolean
  readonly knownHostsMode: KnownHostsMode
  /** accept-new / tofu / off 时用于隔离的 known_hosts 路径；strict 时用系统默认 */
  readonly userKnownHostsFile?: string
  readonly proxyJump?: string
  /** 调用方追加的裸选项，如 `-o KexAlgorithms=...`（抗量子策略） */
  readonly extraOptions?: readonly string[]
  /** 远端环境变量。走 OpenSSH 的 SetEnv；服务端 AcceptEnv 没放行时 ssh 会静默忽略 */
  readonly setEnv?: Readonly<Record<string, string>>
  readonly remoteArgv?: readonly string[]
}

/**
 * 认证相关的三个选项。
 *
 * 为什么 password 分支**不加** `BatchMode=yes`：OpenSSH 的 BatchMode 会关闭
 * 密码/键盘交互式询问，而 SSH_ASKPASS 正是靠这条询问被触发的（实测
 * 走的就是 `SSH_ASKPASS_REQUIRE=force` 而非 BatchMode）。所以非密钥认证的兜底是：
 *  - stdin 直接 ignore（`stdio: ['ignore', ...]`）
 *  - 输出里嗅探 prompt 立即杀掉（prompt.ts）
 *  - 超时杀进程树（native.ts）
 * 三层里没有一层会"等人类输入"。这比 BatchMode 更严格 —— 它能连"我们没预料到的
 * prompt"也变成一次快速失败。
 */
function authOptions(kind: SshAuthKind, identitiesOnly: boolean): string[] {
  if (kind === 'key' || kind === 'agent') {
    const opts = ['-o', 'BatchMode=yes', '-o', 'NumberOfPasswordPrompts=0']
    if (kind === 'key' && identitiesOnly) opts.push('-o', 'IdentitiesOnly=yes')
    return opts
  }
  // 密码类：靠 askpass 喂，且只允许询问一次 —— 问第二次就说明第一次错了
  return ['-o', 'NumberOfPasswordPrompts=1']
}

/** 主机密钥策略 → OpenSSH 选项。见 driver.ts 的 KnownHostsMode 注释。 */
export function knownHostsOptions(
  mode: KnownHostsMode,
  userKnownHostsFile: string | undefined,
): string[] {
  switch (mode) {
    case 'strict':
      // 只信任 known_hosts 里已有的，未知即拒。默认必须是这个。
      return ['-o', 'StrictHostKeyChecking=yes']
    case 'accept-new':
      return ['-o', 'StrictHostKeyChecking=accept-new', ...knownHostsFileArgs(userKnownHostsFile)]
    case 'tofu':
      // 指纹记在我们自己的 pin 文件里，不污染系统 known_hosts。
      // accept-new 只会自动接受"未知"主机，"已知但变了"OpenSSH 自己会拒 ——
      // 所以 tofu 的不一致检测是免费的，由 native.ts 把 stderr 归类成 MISMATCH。
      return [
        '-o',
        'StrictHostKeyChecking=accept-new',
        ...knownHostsFileArgs(userKnownHostsFile ?? defaultPinPath()),
      ]
    case 'off':
      return ['-o', 'StrictHostKeyChecking=no', ...knownHostsFileArgs('/dev/null')]
  }
}

function knownHostsFileArgs(path: string | undefined): string[] {
  return path === undefined ? [] : ['-o', `UserKnownHostsFile=${path}`]
}

/** tofu 模式的默认 pin 文件位置。放 `.local/state` 而不是 tmpdir —— pin 必须活过重启。 */
export function defaultPinPath(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'}/.local/state`
  return `${stateHome}/dp/known_hosts.pinned`
}

/**
 * 拼本机 `ssh` 的 argv。
 *
 * 关键：**远端命令作为独立 argv 追加，不经过任何 shell**。`ssh host cmd arg`
 * 是 OpenSSH 自己做的事：它把 host 之后的全部 argv 拼成一条远程命令字符串发过去
 * （远端由 sshd 交给用户 shell 解析）。这是唯一的边界 —— 想用管道/`&&` 就必须由
 * 调用方显式传 `['sh','-c', script]`，见 runner.ts。
 */
export function buildSshArgv(options: SshArgvOptions): string[] {
  const argv: string[] = []

  if (options.port !== undefined) argv.push('-p', String(options.port))
  if (options.identityFile !== undefined) argv.push('-i', options.identityFile)
  if (options.proxyJump !== undefined) argv.push('-o', `ProxyJump=${options.proxyJump}`)

  argv.push(...authOptions(options.authKind, options.identitiesOnly ?? true))
  argv.push(...knownHostsOptions(options.knownHostsMode, options.userKnownHostsFile))

  // 永远不要转发 agent（把钥匙交给中间机器）
  argv.push('-o', 'ForwardAgent=no')
  // BatchMode 下我们要的是干净的非 tty 流；不声明 pty，\n 不会被 CRLF 污染
  argv.push('-T')
  // 命令超时我们自己管，不让 ssh 自己挂死
  argv.push('-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2')

  if (options.extraOptions !== undefined) argv.push(...options.extraOptions)
  if (options.setEnv !== undefined) argv.push(...setEnvOptions(options.setEnv))
  if (options.remoteArgv !== undefined) argv.push(...options.remoteArgv)

  return argv
}

/** host 目标串。`user` 为空则不带前缀（rsync 与 ssh 都按本地用户名处理） */
export function hostTarget(host: string, user?: string): string {
  return user === undefined || user === '' ? host : `${user}@${host}`
}

// ------------------------------------------------------------
// rsync --rsh 契约
// ------------------------------------------------------------

/**
 * 给 rsync 的 `--rsh` 前缀。
 *
 * **不含 host，也不含 `%h`** —— rsync 会自己在后面追加 `[-l user] host rsync --server ...`
 * （实测样本：`ARGC=8 [-l][dpuser][dp-target][rsync][--server][flags][.][/tmp/dst1/]`）。
 * 写上 host 会变成"连错两次"。
 */
export function buildRshArgv(options: SshArgvOptions & { readonly sshPath: string }): string[] {
  return [options.sshPath, ...buildSshArgv({ ...options, remoteArgv: undefined })]
}

/** rsync 的 `-e` 只接受单个字符串；按空白拆分（事实 2：rsync 侧不过 shell） */
export function rshOptionValue(rshArgv: readonly string[]): string {
  for (const a of rshArgv) {
    if (/[\s"'\\$`]/.test(a)) {
      throw new Error(
        `rshArgv 含空白或 shell 特殊字符，无法作为 -e 的单参数传给 rsync：${JSON.stringify(a)}`,
      )
    }
  }
  return rshArgv.join(' ')
}

// ------------------------------------------------------------
// sftp 批量脚本
// ------------------------------------------------------------

/**
 * sftp `-b` 批处理脚本。
 *
 * 走 `sftp -b -` 从 stdin 喂脚本：整个脚本是**一个 argv 参数流**（`-b -`），
 * 不经过 shell。批量模式里命令不是 shell，**引号由 sftp 自己解析**，规则与
 * POSIX shell 不同（sftp 认 `\` 转义与双引号，单引号不特殊）。
 */
export function buildSftpBatch(commands: readonly string[]): string {
  return `${commands.map((c) => (c.endsWith('\n') ? c : `${c}\n`)).join('')}quit\n`
}

/** sftp 批量脚本里的参数引用：双引号包裹 + 反斜杠转义 */
export function sftpQuote(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('sftp 参数不能含换行：换行在 -b 脚本里是命令分隔符')
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
