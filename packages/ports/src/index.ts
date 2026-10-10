
// 平台与身份

/**
 * 目标机 OS。取值与 Node 的 `process.platform` 对齐但**不共用**：'unknown' 是探测失败时必须能表达的第四态。混用会让人在探测失败时拿到一个看起来合法的假平台，于是所有路径判断都基于猜测跑完。
 */
export type Platform = 'linux' | 'darwin' | 'win32' | 'freebsd' | 'unknown'
/** CPU 架构。unknown 之外的 'other' 表示已知非 x86/arm，决策上按「不能假设行为一致」处理 */
export type Arch = 'x64' | 'arm64' | 'x86' | 'arm' | 'other'
/**
 * init 系统。'none' 是合法结论而非探测失败：容器里没有 init 是常态，而它决定了 unit 文件写给谁。把「没装 systemd」和「没测出来」分成两态，前者继续部署、后者报错 —— 合成一个值的结果是部署在容器里被 systemd 假设拖死。
 */
export type InitSystem = 'systemd' | 'sysvinit' | 'openrc' | 'launchd' | 'winsvc' | 'none'

/**
 * 能力集 —— 一律**实证**得出，不从 uid / 平台推断。
 */
export interface Capabilities {
  /** path → 是否可写（建临时文件后删除的实测结果） */
  readonly canWrite: Readonly<Record<string, boolean>>
  /** 可 chown 到的 owner 列表 */
  readonly canChown: readonly string[]
  readonly canSymlink: boolean
  readonly systemdScope: 'system' | 'user' | 'none'
  /** systemd --user 的 linger；未开启则用户注销后服务即停 */
  readonly lingerEnabled: boolean
  readonly canBindPrivilegedPort: boolean
  /** 能 sudo 的具体命令，不是"能不能 sudo" */
  readonly sudoAllowlist: readonly string[]
  /**
   * 「能不能写」的探测建出来、却没能删掉的临时文件。
   */
  readonly probeLeftovers?: readonly string[]
}

/** 目标机的全部事实。plan() 的唯一外部输入。 */
export interface Facts {
  readonly host: string
  readonly platform: Platform
  readonly arch: Arch
  readonly init: InitSystem
  readonly homedir: string
  readonly tmpdir: string
  /** XDG_*、ProgramFiles、LOCALAPPDATA、USERPROFILE 等 */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly capabilities: Capabilities
  /** 工具名 → 绝对路径，不存在为 null */
  readonly tools: Readonly<Record<string, string | null>>
}

/** 由能力推导出的布局。路径是**输出**，不是配置项。 */
export type Layout = 'system' | 'hybrid' | 'user'

// 发布目录的命名

/**
 * 发布目录的三个名字。**全仓只有这一份**。
 */
export const RELEASES_DIR_NAME = 'releases'
/**
 * 指向当前生效版本的软链名。
 */
export const CURRENT_LINK_NAME = 'current'
/** 传输中的半成品后缀。正在服务的目录永远不直接被写 */
export const INCOMING_SUFFIX = '.incoming'

/**
 * 布局推导要试写的目录；顺序即优先级，改动等于改落点
 */
export const POSIX_WRITE_CANDIDATES: readonly string[] = [
  '/srv',
  '/opt',
  '/usr/local',
  '/var/lib',
  '/var/www',
  '/etc/systemd/system',
  '/etc/nginx/conf.d',
]

// SSH 连接串

/** 主机密钥策略。放这里是因为 schema（校验枚举）与 ssh（消费它）都要用，两处各写一份字面量必然漂移 */
export const KNOWN_HOSTS_MODES = ['strict', 'accept-new', 'tofu', 'off'] as const
/** 从 KNOWN_HOSTS_MODES 派生，schema 校验与驱动实现读的是同一组字面量 */
export type KnownHostsMode = (typeof KNOWN_HOSTS_MODES)[number]

/**
 * 解析结果。`user` / `port` 可缺省是**刻意的**：缺省意味着「交给 ssh 自己按ssh_config 决定」，而补一个默认值会绕开 ssh_config —— 配了 `Port 2222` 的Host 别名会静默连到 22 端口的另一台机器上。
 */
export interface SshTarget {
  /** 已剥掉端口的纯主机名或 IP，不含 user@ */
  readonly host: string
  /** 未写 user@ 时为 undefined，交给 ssh 兜底（不猜 root） */
  readonly user?: string
  /** 未写 :port 时为 undefined，理由同 user */
  readonly port?: number
}

/**
 * `user@host[:port]` —— 纯解析，不猜端口（未写端口时由 ssh 自己按 ssh_config 决定）。
 *
 * @param value 配置里写的原始串，形如 `deploy@10.0.0.5:2222`
 * @param path 该字段的配置路径，仅用于错误消息定位
 * @returns 拆开的 user/host/port；未写的部分保持 undefined 而非补默认值
 * @throws DpError 主机名为空或端口不在 1–65535
 */
export function parseSshTarget(value: string, path: string): SshTarget {
  const at = value.lastIndexOf('@')
  const userPart = at >= 0 ? value.slice(0, at) : undefined
  const hostPart = at >= 0 ? value.slice(at + 1) : value
  if (hostPart === '') {
    throw new DpError('DP.CONFIG.INVALID', `ssh 目标为空：${JSON.stringify(value)}`, {
      path,
      hint: '写成 user@host 或 user@host:port，例如 deploy@10.0.0.5:2222',
    })
  }
  const colon = hostPart.lastIndexOf(':')
  if (colon > 0) {
    const portText = hostPart.slice(colon + 1)
    const port = Number(portText)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new DpError('DP.CONFIG.INVALID', `端口不合法：${portText}`, {
        path,
        hint: '端口必须是 1–65535 的整数。不写端口就用 SSH 的默认值（22）',
      })
    }
    return { user: userPart, host: hostPart.slice(0, colon), port }
  }
  return { user: userPart, host: hostPart }
}

/**
 * 端口是否在 TCP 有效区间内。单独给是因为逐跳的 `port` 字段不走连接串解析
 *
 * @param port 端口号，必须是 1–65535 的整数（0 与 65536 都不含在区间内）
 * @param path 配置路径，仅用于错误消息定位
 * @throws DpError 越界或非整数
 */
export function assertPortInRange(port: number, path: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DpError('DP.CONFIG.INVALID', `端口不合法：${port}`, {
      path,
      hint: '端口必须是 1–65535 的整数',
    })
  }
}

// 错误

/**
 * 全仓唯一的错误码登记表，`DpErrorCode` 由它派生。
 */
export const DP_ERROR_CODES = [
  'DP.CONFIG.INVALID',
  'DP.PATH.CASE_COLLISION',
  'DP.PATH.RESERVED_NAME',
  'DP.PATH.TOO_LONG',
  'DP.PATH.ILLEGAL_CHAR',
  'DP.PATH.WSL_MOUNT',
  'DP.PATH.NOT_WRITABLE',
  'DP.LAYOUT.MISMATCH',
  'DP.LAYOUT.UNSUPPORTED',
  'DP.PERM.CONFD_NOT_WRITABLE',
  'DP.PREF.UNSUPPORTED',
  'DP.VERIFY.FAILED',
  'DP.LINK.UNAVAILABLE',
  'DP.SOURCE.EMPTY',
  'DP.INTERACTIVE_PROMPT_DETECTED',
  'DP.TIMEOUT.EXEC',
  // ↓ SSH 远端 Runner（@dp/ssh）追加。
  'DP.SSH.CONNECT_FAILED',
  'DP.SSH.AUTH_FAILED',
  'DP.SSH.HOST_KEY_UNKNOWN',
  'DP.SSH.HOST_KEY_MISMATCH',
  'DP.SSH.TOOL_MISSING',
  'DP.SSH.DRIVER_UNAVAILABLE',
  'DP.SSH.TUNNEL_FAILED',
  // ↓ 模板层（@dp/template）追加。渲染期的问题一律用 DP.TPL.*：
  'DP.TPL.UNKNOWN_VAR',
  'DP.TPL.MISSING_ENV',
  'DP.TPL.MISSING_VALUE',
  'DP.TPL.SYNTAX',
  'DP.TPL.UNSAFE_VALUE',
  // ↓ nginx 目标（@dp/target-nginx）追加。conf 相关的问题单列一组：它们全部
  'DP.NGX.CONF_INVALID',
  'DP.NGX.NOT_MANAGED',
  'DP.NGX.UNSAFE_VALUE',
  'DP.NGX.RELOAD_CMD_INVALID',
  'DP.NGX.NO_PREVIOUS',
  // ↓ nginx 执行器（@dp/target-nginx）追加。这两个单列的理由是**处置方式相反**：
  'DP.NGX.TEST_FAILED',
  'DP.NGX.RELOAD_FAILED',
  // ↓ docker 目标（@dp/target-docker）追加。全部是**配置期可判定**的问题：
  'DP.DOCKER.MODE_UNSUPPORTED',
  'DP.DOCKER.PROJECT_NAME_INVALID',
  'DP.DOCKER.COMPOSE_FILES_EMPTY',
  'DP.DOCKER.COMPOSE_FILE_DUPLICATED',
  'DP.DOCKER.COMPOSE_FILE_INVALID',
  'DP.DOCKER.PS_PARSE_FAILED',
  'DP.DOCKER.NO_PREVIOUS',
  // ↓ docker 执行器（@dp/target-docker）追加。这三个与上面那组**处置方式相反**：
  'DP.DOCKER.FILE_MISSING',
  'DP.DOCKER.PULL_FAILED',
  'DP.DOCKER.PLAN_MISMATCH',
  // ↓ 激活失败（在册，但类型里一直缺这一条）。它单列而不是复用
  'DP.ACTIVATE.START_FAILED',
  // ↓ 多跳链式转发（@dp/ssh）追加。单列而不是复用 DP.SSH.CONNECT_FAILED：
  'DP.SSH.HOP_FAILED',
] as const

/** 从数组派生：加码只改上面那一个地方，类型自动跟上 */
export type DpErrorCode = (typeof DP_ERROR_CODES)[number]

/**
 * 错误附带的定位信息。
 */
export interface DpErrorOptions {
  /** 出错的配置路径，如 `projects.web.source` */
  readonly path?: string
  /** 给用户的修复建议 */
  readonly hint?: string
  /** 底层异常。挂上去是为了不丢原始堆栈，但**不参与**本错误的判定 */
  readonly cause?: unknown
}

/**
 * 所有错误都带 code + 可读 message + 可选 hint。
 */
export class DpError extends Error {
  readonly code: DpErrorCode
  readonly path?: string
  readonly hint?: string

  constructor(code: DpErrorCode, message: string, options: DpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DpError'
    this.code = code
    if (options.path !== undefined) this.path = options.path
    if (options.hint !== undefined) this.hint = options.hint
  }

  /** 结构化输出，供日志与 JSON 报告使用（见第 7 条：日志必须结构化） */
  toJSON(): { code: DpErrorCode; message: string; path?: string; hint?: string } {
    return { code: this.code, message: this.message, path: this.path, hint: this.hint }
  }
}

// 管线步骤

/**
 * 管线的固定八段。
 */
export type StepKind =
  | 'prepare'
  | 'stage'
  | 'transfer'
  | 'install'
  | 'activate'
  | 'verify'
  | 'promote'
  | 'prune'

/** plan() 的产物。纯数据 —— 它的价值就在于"不需要任何机器就能断言"。 */
export interface Step {
  readonly id: string
  readonly kind: StepKind
  readonly title: string
  readonly host: string
  /** 该步骤的补偿动作描述；为空表示无需补偿（纯读或无副作用） */
  readonly undo?: string
  readonly detail?: Readonly<Record<string, unknown>>
}

// Runner —— 对"一台机器"的抽象

/**
 * 一次命令执行的结果。
 */
export interface ExecResult {
  /** 进程退出码。被信号杀掉时按惯例给 128+信号号，不归一化成 1 —— 归一化会抹掉「是谁杀的」 */
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * 执行选项。**没有 shell 选项**是接口层的硬约束：参数只能是 argv 数组，命令注入的面从类型上就不存在。
 */
export interface ExecOptions {
  /** 工作目录。不存在时由驱动报错，不自动创建 —— 自动创建会把拼错的路径变成真目录 */
  readonly cwd?: string
  /**
   * 超时（毫秒）。**每个子进程都必须给**：ssh 到一台不可达的主机上会挂住，没有兜底就是一次永不返回的部署。
   */
  readonly timeoutMs?: number
  /** 覆盖式环境变量，与父进程合并而非替换 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 绝不喂 stdin —— 避免远端 prompt 挂起（铁律 0：永不交互） */
  readonly stdin?: string
}

/**
 * 一条路径的元信息。字段是 stat 的直接映射，不做「友好化」：预检需要的是和文件系统一致的原始事实。
 */
export interface FileStat {
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
  /** 字节数，符号链接本身的大小而非目标的大小 */
  readonly size: number
  /** 毫秒时间戳。与 `Date.now()` 同一时基，不做本地化 */
  readonly mtimeMs: number
}

// 源 —— 传输与目标之间的一致形状

/**
 * 一条待投递的源条目。
 */
export interface SourceFile {
  readonly kind: 'file'
  /** 相对 source 根的路径，始终用 `/` 分隔 */
  readonly relativePath: string
  readonly mode?: number
  read(): Promise<Uint8Array>
}

/**
 * 一个待创建的目录。与 SourceFile 的区别是**没有 read()**：目录不产出字节，给它一个空的 read 会诱导实现编造空内容。
 */
export interface SourceDir {
  readonly kind: 'dir'
  /** 相对 source 根的路径，始终用 `/` 分隔 */
  readonly relativePath: string
  /** 权限位（八进制，如 0o755）。省略时由传输层按 umask 决定，不硬编码 0o644 */
  readonly mode?: number
}

/**
 * 源清目的一个条目。文件与目录的联合，让传输层能一次遍历而不必分两次枚举 ——分开枚举会让「先建目录再传文件」的顺序依赖两次独立快照，中间被改动的文件会漏掉。
 */
export type SourceEntry = SourceFile | SourceDir

// Target —— 投递目标（static / nginx / docker / 未来更多）

/**
 * 一次目标操作的输入。
 */
export interface TargetContext {
  readonly host: string
  /** 发布根目录，已按实测能力选定，不是用户配置原样 */
  readonly root: string
  /** 本次部署的版本号 */
  readonly releaseId: string
  /** 当前生效版本；首次部署为 undefined */
  readonly previousReleaseId?: string
  /** 保留的历史版本数（含当前版本）。超出即 prune */
  readonly keep: number
}

/**
 * 一个投递目标。
 */
export interface Target<C = unknown> {
  /** 目标类型标识，进日志与报告；不参与行为分派 */
  readonly type: string
  planInstall(ctx: TargetContext, config: C): readonly Step[]
  planActivate(ctx: TargetContext, config: C): readonly Step[]
  planVerify(ctx: TargetContext, config: C): readonly Step[]
  planRollback(ctx: TargetContext, config: C): readonly Step[]
}

/**
 * 一台机器上能做的事。local 与 ssh 各实现一份，core 只认这个接口。
 */
export interface Runner {
  readonly id: string
  readonly facts: Facts

  exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult>
  stat(path: string): Promise<FileStat | null>
  listDir(path: string): Promise<readonly string[]>
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>
  writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void>
  readFile(path: string): Promise<string>
  /** 按字节读。二进制文件一旦走 utf8 字符串就会被损坏，传输与备份必须走它 */
  readBinary(path: string): Promise<Uint8Array>
  remove(path: string): Promise<void>
  /**
   * 同文件系统内的 rename。**原子发布的唯一依赖**：切换 current 不能用「删旧 + 建新」，那中间有窗口会导致服务悬空。
   */
  rename(from: string, to: string): Promise<void>
  /**
   * 创建软链。可能不被支持（Windows 无特权时）→ 抛错由调用方退化到 copy。
   */
  symlink(target: string, linkPath: string): Promise<void>
  /** 读软链指向；非软链或不存在返回 null */
  readlink(path: string): Promise<string | null>
  /** 真实路径解析；预检路径逃逸校验依赖它 */
  realpath(path: string): Promise<string>
}

// Logger —— 结构化日志（实现见 @dp/log）

/** 严重度。定义在 log 包之前，因为 sinks 与调用方都要按它过滤 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

/** 一条日志。固定字段对齐 OTel 语义约定，其余字段自由扩展。 */
export interface LogRecord {
  /** ISO 8601，由注入的 clock 产出，保证测试可确定 */
  readonly ts: string
  readonly level: LogLevel
  /** 事件名，点分小写，如 `transfer.begin` */
  readonly msg: string
  readonly deployId?: string
  readonly host?: string
  readonly phase?: string
  readonly span?: string
  readonly attempt?: number
  readonly [key: string]: unknown
}

/** 出口。实现必须在这里做脱敏，调用方不许自己 scrub。 */
export interface LogSink {
  /** line 是格式化后的单行文本（不含换行符） */
  write(line: string, record: LogRecord): void
  /** 可选：异步刷盘。`flush()` 会等它 */
  flush?(): Promise<void>
}

/**
 * 结构化日志的写入端。
 */
export interface Logger {
  /** 派生一个绑定了固定字段的子 logger；子字段覆盖父字段，只影响自己 */
  child(bind: Readonly<Record<string, unknown>>): Logger
  /** 绑定 span 字段的快捷方式 */
  span(spanId: string): Logger
  trace(msg: string, fields?: Readonly<Record<string, unknown>>): void
  debug(msg: string, fields?: Readonly<Record<string, unknown>>): void
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void
  /** 开始计时，返回的 end() 会自动写 durationMs */
  begin(msg: string, fields?: Readonly<Record<string, unknown>>): () => void
  flush(): Promise<void>
}

// 提权 —— 由 @dp/ssh 的 become.ts 落地包装

/**
 * 提权方式的**运行期**形状。
 */
export type BecomeConfig =
  | { readonly type: 'none' }
  /** `nonInteractive` 默认 true，即 `sudo -n`（完全免密） */
  | { readonly type: 'sudo'; readonly user?: string; readonly group?: string; readonly nonInteractive?: boolean }
  | { readonly type: 'doas'; readonly user?: string }
  /** 已知 busybox su 可能缺 suid 位（实测失败），所以只做包装不保证可用 */
  | { readonly type: 'su'; readonly user: string; readonly shell?: string }
  | { readonly type: 'custom'; readonly template: string }

/**
 * 提权的**实证结论**，不是配置声明。
 */
export interface Elevation {
  readonly become: BecomeConfig
  /** 目标身份。不由 uid 推断，由 `sudo -n id -un` 的真实输出得到 */
  readonly targetUser?: string
  readonly available: boolean
  /** 不可用时的原因（远端原话脱敏后），或可用的实测依据 */
  readonly reason?: string
}
