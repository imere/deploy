import { ERR, DpError, assertPortInRange, parseSshTarget } from '@dp/ports'
import type { HopSpec, KnownHostsMode } from './driver.js'

// POSIX 单引号转义

/** 只需引号的字符集：尽量少引，让常见路径保持人眼可读（错误信息里会显示） */
const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/

/**
 * POSIX 单引号转义。
 *
 * @param arg 远端 shell 语境下的**一个词**。空串不代表"不需要引号"而是
 * "需要一个空参数"，所以它单独产出 `''` —— 原样返回空串会让 `sh -c` 少收一个参数，
 * 表现为远端脚本整体错位一个位置，而不是在原处报错。
 * @returns 可直接拼进脚本的参数。落在 SHELL_SAFE 内的原样返回（不加引号），
 * 是因为这些串会出现在错误信息与 dryRun 报告里，全加引号会让人读不出哪个是真路径。
 */
export function quoteArg(arg: string): string {
  if (arg === '') return "''"
  if (SHELL_SAFE.test(arg)) return arg
  return `'${arg.replaceAll("'", `'\\''`)}'`
}

/**
 * 逐参数转义后用空格拼成一条脚本。只在必须过一层 shell 时用（su -c、sh -c）。
 *
 * @param argv 要拼成一条 shell 字符串的参数，已按普通 argv 逐个转义
 * @returns 等价于在远端 shell 里依次展开这些参数的命令串
 */
export function quoteArgv(argv: readonly string[]): string {
  return argv.map(quoteArg).join(' ')
}

/**
 * 把 argv 变成一条**远端命令字符串**。
 *
 * @param argv 远端命令的 argv，已由调用方保证是**完整的**一条命令。
 * 要管道或 `&&` 就传 `['sh', '-c', script]` —— 在这里把两三条命令塞进来，
 * 等于把「这条脚本长什么样」的责任推给字符串拼接，而那一层已经不再有转义
 * @returns 拼好的命令串，每个元素都过了 {@link quoteArg}
 * @throws DpError 空 argv，或任一元素含换行 / `\r` / NUL（`DP.CONFIG.INVALID`）
 */
export function buildRemoteCommand(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new DpError(ERR.CONFIG.INVALID, 'buildRemoteCommand 收到空 argv', {
      hint: '至少给出可执行文件名',
    })
  }
  for (const arg of argv) {
    // NUL 在任何一层都能截断字符串（shell 与 C 都如此），没有引号能救它
    if (arg.includes('\0')) {
      throw new DpError(ERR.CONFIG.INVALID, '远端命令参数含 NUL，已拒绝', {
        hint: 'NUL 会在 shell 与 C 两层同时截断命令，无法用引号中和',
      })
    }
    // CR 会让带标签的输出行（DPW\t<path>\t<1>）被读成两行，而没有任何脚本需要它
    if (arg.includes('\r')) {
      throw new DpError(ERR.CONFIG.INVALID, '远端命令参数含 CR，已拒绝', {
        hint: 'CR 只在命令真正换行时才出现；脚本里的换行用 \\n',
      })
    }
  }
  // 换行**允许**，与「换行是命令分隔符」不冲突：分隔符只存在于引号之外，
  // 而下面每个不在 SHELL_SAFE 里的参数都会被单引号包住（SHELL_SAFE 不含换行，
  // 所以含换行的参数必然被引号包住），远端 shell 只会把它当成一个参数交给 sh -c。
  // 反过来，拒绝换行会让本包自己造的每一条脚本都发不出去 —— posix.ts 的
  // #dp-op 头与多行脚本体、probe.ts 的复合探测，全都是多行的。
  return argv.map(quoteArg).join(' ')
}

/**
 * 把「远端环境变量」变成 `-o SetEnv=K=V` 选项。
 *
 * @param env 要设置的远端环境变量。遍历顺序即输出顺序，不排序也不去重 ——
 * 重复的键原样发出，让 ssh 自己决定最后一个赢
 * @returns `['-o', 'SetEnv=K=V', ...]` 形态的选项片段，可直接拼进 ssh argv
 * @throws DpError 键名不符合 POSIX 命名，或值含换行 / `\r` / NUL
 */
export function setEnvOptions(env: Readonly<Record<string, string>>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      throw new DpError(ERR.CONFIG.INVALID, `非法环境变量名：${JSON.stringify(k)}`, {
        hint: '只能用 POSIX 环境变量名：字母或下划线开头，后接字母、数字、下划线',
      })
    }
    if (v.includes('\n') || v.includes('\r') || v.includes('\0')) {
      throw new DpError(ERR.CONFIG.INVALID, `环境变量 ${k} 的值含换行或 NUL，已拒绝`, {
        hint: '凭据与多行内容不走环境变量',
      })
    }
    out.push('-o', `SetEnv=${k}=${v}`)
  }
  return out
}

// ssh 客户端 argv

/**
 * 认证方式。**刻意不叫 `password` 一把梭**：四种的失败含义不同 ——key/agent 失败说明机器上没有可用钥匙，password 失败说明凭据或 askpass 通道有问题，报一个笼统的"认证失败"会让这两种问题无法区分。
 */
export type SshAuthKind = 'key' | 'agent' | 'password' | 'keyboard-interactive'

/**
 * 拼 ssh argv 的全部输入。
 */
export interface SshArgvOptions {
  /** 认证方式；决定是否加 BatchMode（见 authOptions 的注释，password 分支必须不加） */
  readonly authKind: SshAuthKind
  /** 1–65535 闭区间，缺省**不传**（让 ssh_config 的 Port 生效），而不是补 22 */
  readonly port?: number
  /** 私钥路径。走 argv 的 `-i`，不经环境变量 —— 进程列表里看得见，但比写进环境变量更容易定位是哪一次部署 */
  readonly identityFile?: string
  /** 无 agent 可用时禁用公钥，避免 ssh 挨个试过把失败计数打满 */
  readonly identitiesOnly?: boolean
  /** 主机密钥策略。默认必须是 strict，调用方没给就是配置缺失而不是"放宽" */
  readonly knownHostsMode: KnownHostsMode
  /** accept-new / tofu / off 时用于隔离的 known_hosts 路径；strict 时用系统默认 */
  readonly userKnownHostsFile?: string
  /** 与 hops 互斥：两者都给直接报错，不做二选一 */
  readonly proxyJump?: string
  /** 多跳链。喂给 -o ProxyJump=，逐跳约束见 hopsProxyJump */
  readonly hops?: readonly HopSpec[]
  /** 调用方追加的裸选项，如 `-o KexAlgorithms=...`（抗量子策略） */
  readonly extraOptions?: readonly string[]
  /** 远端环境变量。走 OpenSSH 的 SetEnv；服务端 AcceptEnv 没放行时 ssh 会静默忽略 */
  readonly setEnv?: Readonly<Record<string, string>>
}

/**
 * 认证相关的三个选项。
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

/**
 * 主机密钥策略 → OpenSSH 选项。四档的差别不只是松紧，**还决定要不要隔离 known_hosts**：只有 accept-new / tofu 会带 `UserKnownHostsFile`，strict 走系统默认（那里已经有用户自己积累的信任），off 则钉到 `/dev/null` 让 ssh 完全不落盘 —— 配了不落盘，否则"关掉校验"会顺带把指纹写回用户的 known_hosts。
 *
 * @param mode 策略。四档全覆盖，switch 里没有 default 分支 ——
 * 枚举新增一档而这里忘了写，TypeScript 会报错，这比运行时"安静地落到 strict"好
 * @param userKnownHostsFile 隔离用的 known_hosts 路径。
 * `strict` 忽略它（信任用户自己积累的记录），`tofu` 不给就用 {@link defaultPinPath}，
 * `accept-new` 不给就让 ssh 写系统默认位置
 * @returns ssh 选项片段，顺序固定（策略在前、路径在后），便于日志与断言
 */
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

/**
 * tofu 模式的默认 pin 文件位置。放 `.local/state` 而不是 tmpdir —— pin 必须活过重启：放 tmpdir 的话每次重启都变成一台"第一次见"的主机，tofu 的不一致检测就整段失效。
 *
 * @returns 绝对路径。它**不保证目录存在** —— 创建目录要由调用方做，
 * 因为这里被 argv.ts 调用时那条路径可能还没进过任何一次 IO 探测
 */
export function defaultPinPath(): string {
  const stateHome = process.env.XDG_STATE_HOME ?? `${process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'}/.local/state`
  return `${stateHome}/dp/known_hosts.pinned`
}

/**
 * 拼本地 `ssh` 的 argv。
 *
 * @param options 见 {@link SshArgvOptions}。**每个缺省都留白而不是补值** ——
 * 端口不补 22、用户不补 root，这些空缺是 ssh_config 该说话的地方
 * @returns argv 片段（**不含主机名**）：调用方负责把 host 放在命令之后、
 * `remoteArgv` 之前。放错位置的症状很隐蔽 —— ssh 会把主机名当成远端命令的一部分
 * @throws DpError `hops` 与 `proxyJump` 同时给（多跳链有两个互相矛盾的来源）
 */
export function buildSshArgv(options: SshArgvOptions): string[] {
  const argv: string[] = []

  if (options.port !== undefined) argv.push('-p', String(options.port))
  if (options.identityFile !== undefined) argv.push('-i', options.identityFile)
  // hops 优先于 proxyJump：两处都给了就报错而不是二选一，那会让用户以为
  if (options.hops !== undefined && options.hops.length > 0) {
    if (options.proxyJump !== undefined) {
      throw new DpError(ERR.CONFIG.INVALID, '同时给了 hops 与 proxyJump，多跳链有两条互相矛盾的来源', {
        path: 'hosts.*.ssh.hops',
        hint: '留一个。多跳用 hops；proxyJump 只留给"直接写一条跳板串"的场景（不经过配置校验）',
      })
    }
    const jump = hopsProxyJump(options.hops, { knownHosts: options.knownHostsMode })
    // 一条跳板都没有（hops 只有目标机）时不产出 -J：那是直连，写 `-J ''` 反而
    if (jump !== undefined) argv.push('-o', `ProxyJump=${jump}`)
  } else if (options.proxyJump !== undefined) {
    argv.push('-o', `ProxyJump=${options.proxyJump}`)
  }

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

  return argv
}

/**
 * 一条可直接交给 `ssh` 的 argv：**选项 → 主机 → 远端命令**。
 *
 * 顺序不是风格问题。ssh 的语序是 `ssh [选项] 主机 [命令]`：第一个非选项参数是主机，
 * 之后的全是命令。把命令塞在主机**前面**，ssh 会把那条命令当成主机名 —— 报错是
 * 「Could not resolve hostname sh -c ...」，而真因只是两个元素的前后位置。
 * 同理，远端命令必须合成**一个**已转义的元素（见 {@link buildRemoteCommand}），
 * 因为 OpenSSH 把命令参数用单个空格拼成一条字符串且不会重新加引号。
 *
 * @param sshPath ssh 可执行文件。**调用方给**：`buildSshArgv` 只产出选项，
 * 于是同一份选项既能给 `ssh` 用，也能给 `sftp` / rsync 的 `-e` 用
 * @param options 连接选项
 * @param host 主机目标串，见 {@link hostTarget}
 * @param remoteArgv 远端命令 argv；不给就是「不执行命令」（sftp 与 rsync 那条路）
 * @returns `[sshPath, ...选项, host, 命令?]`
 */
export function buildExecArgv(
  sshPath: string,
  options: SshArgvOptions,
  host: string,
  remoteArgv: readonly string[] | undefined,
): string[] {
  const argv = [sshPath, ...buildSshArgv(options), host]
  if (remoteArgv !== undefined && remoteArgv.length > 0) argv.push(buildRemoteCommand(remoteArgv))
  return argv
}

/**
 * host 目标串。`user` 为空则不带前缀 —— 实测 rsync 在无 user 前缀时会省略 `-l <user>`改用它自己的本地用户名，而那台机器上的本地用户名往往根本不是我们想用的那个。
 *
 * @param host 纯主机名或 IP，**不含端口**（端口是独立的 `-p` 选项，
 * 混进这里会连到一台同名但不同端口的机器上）
 * @param user 登录用户。`undefined` **与空串同义**，都产出不带前缀的主机名 ——
 * 空串同样表达「没给」，两种情况拼出同一个结果，免得调用方还得先判空
 * @returns `user@host`，或只有 `host`
 */
export function hostTarget(host: string, user?: string): string {
  return user === undefined || user === '' ? host : `${user}@${host}`
}

// 多跳 → ProxyJump

/**
 * 把跳板链变成 `-o ProxyJump=` 的值。
 */
export function hopsProxyJump(
  hops: readonly HopSpec[],
  ctx: { readonly knownHosts?: KnownHostsMode; readonly path?: string },
): string | undefined {
  if (hops.length === 0) {
    throw new DpError(ERR.CONFIG.INVALID, 'hopsProxyJump 收到空跳板链', {
      path: ctx.path ?? 'hosts.*.ssh.hops',
      hint: '空链按单跳处理，不要调用这个函数',
    })
  }
  const base = ctx.path ?? 'hosts.*.ssh.hops'
  // 最后一跳是**目标机**，它出现在 ssh 命令行的 host 位置，不是 -J 里。
  const jumps = hops.slice(0, -1)
  if (jumps.length === 0) return undefined
  return jumps
    .map((hop, i) => {
      const path = `${base}[${i}]`
      const authType = hop.auth?.type
      if (authType === 'password' || authType === 'keyboard-interactive') {
        throw new DpError(ERR.CONFIG.INVALID, `第 ${i} 跳要求 ${authType} 认证，多跳不支持`, {
          path: `${path}.auth`,
          hint:
            '`-J` 无法逐跳喂密码：跳板连接由系统 ssh 自己发起，我们既没有它的凭据通道，也保证不了不交互（它会去读 tty，在 CI 里就是一次挂起）。' +
            '出路：1) 这一跳改用密钥或 ssh-agent（auth.type: key / agent）；2) 把逐跳的端口与密钥写进 ~/.ssh/config 的 Host 块，OpenSSH 会自动应用',
        })
      }
      if (hop.knownHosts !== undefined && ctx.knownHosts !== undefined && hop.knownHosts !== ctx.knownHosts) {
        throw new DpError(
          ERR.CONFIG.INVALID,
          `第 ${i} 跳的主机密钥策略（${hop.knownHosts}）与整体设置（${ctx.knownHosts}）冲突`,
          {
            path: `${path}.knownHosts`,
            hint:
              '`-J` 只有一条命令行，跳板机与目标机共用同一组 StrictHostKeyChecking / UserKnownHostsFile，无法逐跳指定。' +
              '出路：1) 把这一跳的策略改成与整体一致；2) 去掉逐跳的 knownHosts，改在 ~/.ssh/config 里给该 Host 单独配',
          },
        )
      }
      const target = parseSshTarget(hop.ssh, `${path}.ssh`)
      if (hop.port !== undefined) assertPortInRange(hop.port, `${path}.port`)
      // 串里的端口优先于 port 字段：validateHops 已保证两者不会同时出现且不同
      const port = target.port ?? hop.port
      const user = target.user
      const base_ = user === undefined || user === '' ? target.host : `${user}@${target.host}`
      return port === undefined ? base_ : `${base_}:${port}`
    })
    .join(',')
}

// rsync --rsh 契约

/**
 * 给 rsync 的 `--rsh` 前缀。
 *
 * @param options 与 buildSshArgv 同一份选项，外加一个可执行文件名。
 * 这里**不**带远端命令：rsync 自己会在这个前缀后面追加 `[-l user] host rsync --server ...`，
 * 我们再塞一条命令就等于让 ssh 先跑我们的、再被 rsync 追加一条。
 * @returns 交给 rsync `--rsh` 的前缀 argv 数组。首元素是 ssh 可执行文件。
 */
export function buildRshArgv(options: SshArgvOptions & { readonly sshPath: string }): string[] {
  return [options.sshPath, ...buildSshArgv(options)]
}

/**
 * rsync 的 `-e` 只接受单个字符串；按空白拆分（事实 2：rsync 侧不过 shell）。
 *
 * @param rshArgv 来自 buildRshArgv 的前缀 argv
 * @returns 以单空格连接、直接作为 `-e` 下一个参数的字符串
 * @throws 任一元素含空白或 shell 特殊字符时抛 `Error`（不是 `DpError`：这是
 * 「调用方拼出了不该出现的东西」的内部违约，没有对应的配置错误码）
 */
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

// sftp 批量脚本

/**
 * sftp `-b` 批处理脚本。
 *
 * @param commands 一条条 sftp 批处理命令，**参数要自己过 sftpQuote**。
 * 这里不代劳：在这一层按 POSIX 规则转义，会把 sftp 自己能吃的写法改坏，
 * 而且两种规则不可嵌套（sftp 不认 `'\''`），错了也看不出来。
 * @returns 可整体喂给 `sftp -b -` 的脚本文本。末尾显式补 `quit` 而不是靠 stdin 到 EOF：
 * 结束点由脚本内容决定，换一个 sftp 实现（原生 sftp(1) 与 ssh2 内嵌的批处理）
 * 关闭时机的差异就不成其为一次静默挂起。
 */
export function buildSftpBatch(commands: readonly string[]): string {
  return `${commands.map((c) => (c.endsWith('\n') ? c : `${c}\n`)).join('')}quit\n`
}

/**
 * sftp 批量脚本里的参数引用：双引号包裹 + 反斜杠转义。
 *
 * @param value sftp 批处理里的一个参数（远端路径一类）
 * @returns 可直接写进 `-b` 脚本的引用形式
 * @throws 含换行时抛 `Error`。换行在批处理脚本里是命令分隔符，
 * 转义没有对应的表示，只能拒绝 —— 与 `quoteArg` 对空串的处理是相反的取舍：
 * 空串可以表达（引号内什么都没有），换行表达不了。
 */
export function sftpQuote(value: string): string {
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('sftp 参数不能含换行：换行在 -b 脚本里是命令分隔符')
  }
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
