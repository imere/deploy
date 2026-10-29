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
 * `current` 的切换方式。schema 校验它与 static 目标执行它读的是同一组字面量。
 *
 * `auto` 先试软链、建不了退到复制；`symlink` 只要软链，建不了就失败；
 * `copy` 从不建软链 —— 有些挂载点上的软链不被服务进程认，而那要等到线上 404 才看得见。
 *
 * 没有 `rename`：`releases/<id>` 改名成 `current` 会把它移出 `releases/`，
 * prune 与 rollback 随即失去目标 —— 省一次 rename 换不来这个代价。
 */
export const SWITCH_STRATEGIES = ['auto', 'symlink', 'copy'] as const
/** 从 SWITCH_STRATEGIES 派生 */
export type SwitchStrategy = (typeof SWITCH_STRATEGIES)[number]

/**
 * unit 里 `Restart=` 的取值。直接抄 `systemd.service(5)` 的字面值，不起别名 ——
 * 别名会让「配置里写的」与「写进 unit 的」分叉，而排查的人手里只有后者。
 */
export const SYSTEMD_RESTART_POLICIES = [
  'no',
  'on-success',
  'on-failure',
  'on-abnormal',
  'on-watchdog',
  'on-abort',
  'always',
] as const
/** 从 SYSTEMD_RESTART_POLICIES 派生；schema 与 systemd 执行器读的是同一组字面量 */
export type SystemdRestartPolicy = (typeof SYSTEMD_RESTART_POLICIES)[number]

/**
 * 停止进程用的信号。只收「给进程收尾机会」的那几个 —— `SIGKILL` 不给，
 * 把它写成可配项等于给「优雅停止」开一个名不副实的口子。
 */
export const PROCESS_STOP_SIGNALS = [
  'SIGTERM',
  'SIGINT',
  'SIGQUIT',
  'SIGUSR1',
  'SIGUSR2',
] as const
/** 从 PROCESS_STOP_SIGNALS 派生；schema 与 process 执行器读的是同一组字面量 */
export type ProcessStopSignal = (typeof PROCESS_STOP_SIGNALS)[number]

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
    throw new DpError(ERR.CONFIG.INVALID, `ssh 目标为空：${JSON.stringify(value)}`, {
      path,
      hint: '写成 user@host 或 user@host:port，例如 deploy@10.0.0.5:2222',
    })
  }
  const colon = hostPart.lastIndexOf(':')
  if (colon > 0) {
    const portText = hostPart.slice(colon + 1)
    const port = Number(portText)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new DpError(ERR.CONFIG.INVALID, `端口不合法：${portText}`, {
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
    throw new DpError(ERR.CONFIG.INVALID, `端口不合法：${port}`, {
      path,
      hint: '端口必须是 1–65535 的整数',
    })
  }
}

// 错误

/**
 * 全仓唯一的错误码登记表 —— 键是 `DP.` 之后的分组，值是那个码本身。
 *
 * 抛错与断言一律引用它（`ERR.PROC.START_FAILED`），**不写字面量**：字面量散在各包里，
 * 改一个码要同步几十处，漏一处就是「报的是 A、断言的是 B」这种查不动的现场。
 * 各码「为什么单列而不复用邻居」的理由写在它自己上面 —— 两个码合成一个之后，
 * 报错里就只剩一句模棱两可的话，用户得自己分辨是哪一种。
 */
export const ERR = {
  CONFIG: {
    INVALID: 'DP.CONFIG.INVALID',
  },
  PATH: {
    CASE_COLLISION: 'DP.PATH.CASE_COLLISION',
    RESERVED_NAME: 'DP.PATH.RESERVED_NAME',
    TOO_LONG: 'DP.PATH.TOO_LONG',
    ILLEGAL_CHAR: 'DP.PATH.ILLEGAL_CHAR',
    NOT_WRITABLE: 'DP.PATH.NOT_WRITABLE',
  },
  LAYOUT: {
    MISMATCH: 'DP.LAYOUT.MISMATCH',
  },
  PERM: {
    // confd 与 unitDir 分列：前者不可写是「nginx 的入口目录不可写」，后者是
    // 「systemd 的单元目录不可写」，排查路径完全不同
    CONFD_NOT_WRITABLE: 'DP.PERM.CONFD_NOT_WRITABLE',
    UNIT_DIR_NOT_WRITABLE: 'DP.PERM.UNIT_DIR_NOT_WRITABLE',
  },
  PREF: {
    UNSUPPORTED: 'DP.PREF.UNSUPPORTED',
  },
  VERIFY: {
    FAILED: 'DP.VERIFY.FAILED',
  },
  LINK: {
    UNAVAILABLE: 'DP.LINK.UNAVAILABLE',
  },
  SOURCE: {
    EMPTY: 'DP.SOURCE.EMPTY',
  },
  INTERACTIVE_PROMPT_DETECTED: 'DP.INTERACTIVE_PROMPT_DETECTED',
  TIMEOUT: {
    EXEC: 'DP.TIMEOUT.EXEC',
  },
  // ↓ SSH 远端 Runner（@dp/runner-ssh）追加的这一组
  SSH: {
    CONNECT_FAILED: 'DP.SSH.CONNECT_FAILED',
    AUTH_FAILED: 'DP.SSH.AUTH_FAILED',
    HOST_KEY_UNKNOWN: 'DP.SSH.HOST_KEY_UNKNOWN',
    HOST_KEY_MISMATCH: 'DP.SSH.HOST_KEY_MISMATCH',
    TOOL_MISSING: 'DP.SSH.TOOL_MISSING',
    DRIVER_UNAVAILABLE: 'DP.SSH.DRIVER_UNAVAILABLE',
    TUNNEL_FAILED: 'DP.SSH.TUNNEL_FAILED',
    // 单列而不是复用 CONNECT_FAILED：链式转发失败时中间跳是通的、最后一跳没通，
    // 「连不上」这句话指向的机器是错的
    HOP_FAILED: 'DP.SSH.HOP_FAILED',
  },
  // ↓ 模板层（@dp/template）追加。渲染期的问题一律用这一组
  TPL: {
    UNKNOWN_VAR: 'DP.TPL.UNKNOWN_VAR',
    MISSING_ENV: 'DP.TPL.MISSING_ENV',
    MISSING_VALUE: 'DP.TPL.MISSING_VALUE',
    SYNTAX: 'DP.TPL.SYNTAX',
    UNSAFE_VALUE: 'DP.TPL.UNSAFE_VALUE',
  },
  NGX: {
    CONF_INVALID: 'DP.NGX.CONF_INVALID',
    NOT_MANAGED: 'DP.NGX.NOT_MANAGED',
    UNSAFE_VALUE: 'DP.NGX.UNSAFE_VALUE',
    RELOAD_CMD_INVALID: 'DP.NGX.RELOAD_CMD_INVALID',
    NO_PREVIOUS: 'DP.NGX.NO_PREVIOUS',
    // ↓ 这两个与上面那组处置方式相反：上面全是配置期可判定的（改配置重来即可），
    // 这两个是执行期的 —— 盘上 conf 已过 `-t`，reload 失败也不回滚
    TEST_FAILED: 'DP.NGX.TEST_FAILED',
    RELOAD_FAILED: 'DP.NGX.RELOAD_FAILED',
  },
  DOCKER: {
    MODE_UNSUPPORTED: 'DP.DOCKER.MODE_UNSUPPORTED',
    PROJECT_NAME_INVALID: 'DP.DOCKER.PROJECT_NAME_INVALID',
    COMPOSE_FILES_EMPTY: 'DP.DOCKER.COMPOSE_FILES_EMPTY',
    COMPOSE_FILE_DUPLICATED: 'DP.DOCKER.COMPOSE_FILE_DUPLICATED',
    COMPOSE_FILE_INVALID: 'DP.DOCKER.COMPOSE_FILE_INVALID',
    PS_PARSE_FAILED: 'DP.DOCKER.PS_PARSE_FAILED',
    NO_PREVIOUS: 'DP.DOCKER.NO_PREVIOUS',
    // ↓ 这三个与上面那组处置方式相反：上面配置期可判定（零副作用），这三个是执行期
    FILE_MISSING: 'DP.DOCKER.FILE_MISSING',
    PULL_FAILED: 'DP.DOCKER.PULL_FAILED',
    PLAN_MISMATCH: 'DP.DOCKER.PLAN_MISMATCH',
  },
  ACTIVATE: {
    START_FAILED: 'DP.ACTIVATE.START_FAILED',
  },
  SYSD: {
    UNIT_INVALID: 'DP.SYSD.UNIT_INVALID',
    UNIT_NOT_MANAGED: 'DP.SYSD.UNIT_NOT_MANAGED',
    TEST_FAILED: 'DP.SYSD.TEST_FAILED',
    DAEMON_RELOAD_FAILED: 'DP.SYSD.DAEMON_RELOAD_FAILED',
    RESTART_FAILED: 'DP.SYSD.RESTART_FAILED',
    NO_PREVIOUS: 'DP.SYSD.NO_PREVIOUS',
    NOT_ACTIVE: 'DP.SYSD.NOT_ACTIVE',
    // unit 已在盘上且服务已起，缺的只是开机自启那条 wants 软链：它与上面几条处置
    // 方式都不同（服务现在是对的，坏的是重启之后），混进去会报成「unit 没生效」
    ENABLE_FAILED: 'DP.SYSD.ENABLE_FAILED',
  },
  // ↓ process 目标自带进程管理（不依赖 systemd），所以停止/启动/存活三类失败都得
  // 自己报 —— 借 systemd 那一组之后，「systemctl 不在 PATH」与「进程自己退了」
  // 会混成同一句话。NO_PREVIOUS 是「上一版的启动脚本已经不在了」
  PROC: {
    COMMAND_INVALID: 'DP.PROC.COMMAND_INVALID',
    START_FAILED: 'DP.PROC.START_FAILED',
    STOP_FAILED: 'DP.PROC.STOP_FAILED',
    NOT_RUNNING: 'DP.PROC.NOT_RUNNING',
    NO_PREVIOUS: 'DP.PROC.NO_PREVIOUS',
  },
  // ↓ dp 自己这一层：不是目标机的问题，是「机器上现在的状态」与「命令预期」对不上，
  // 或者压根不是 DpError 的抛出物。两者都不能假装没发生，但也都不属于任何目标
  STATE: {
    INCONSISTENT: 'DP.STATE.INCONSISTENT',
  },
  CLI: {
    INTERNAL: 'DP.CLI.INTERNAL',
  },
} as const

// 告警标记 —— 与 ERR 同形但**不是错误码**：它们只出现在 plan 的 warnings 与告警文案里，
// 不进 `DpError.code`，所以 failures.md 里查不到处置办法（那里收的是「抛出来之后怎么
// 办」，告警不中止流程）。同样只许引用、不许写字面量。

/**
 * 告警标记。与 `ERR` 的差别见上面那三条：形似错误码、但不是错误码。
 */
export const WARN = {
  SYSTEMD: {
    NO_LINGER: 'DP.SYSTEMD.NO_LINGER',
  },
  VERIFY: {
    NO_HEALTHCHECK: 'DP.VERIFY.NO_HEALTHCHECK',
  },
  HEALING: {
    REQUIRED: 'DP.HEALING.REQUIRED',
  },
} as const

/** 分组的对象展开成该组下全部码的联合；两段的码（没有分组）就是它自己 */
type CodeOf<T> = T extends Record<string, string> ? T[keyof T] : T

/** 从 ERR 派生：加码只改上面那一个地方，类型自动跟上 */
export type DpErrorCode = CodeOf<(typeof ERR)[keyof typeof ERR]>

/** 扁平列表，给「文档与登记表是同一份知识」的一致性与唯一性检查用 */
export const DP_ERROR_CODES: readonly DpErrorCode[] = Object.values(ERR).flatMap((group) =>
  typeof group === 'string' ? [group] : Object.values(group),
)


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

  /** 经 sink 统一做的结构化输出，给日志与 JSON 报告共用 */
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

// 提权 —— 由 @dp/runner-ssh 的 become.ts 落地包装

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

// 目标机文件与输出的公共件 —— 各目标执行器逐字同文的那几份，收口到这里

/**
 * 「这个文件是不是 dp 写的」的标记本体。nginx conf / systemd unit / process 启停脚本
 * 共用同一份：归属判定只有一种回答才算数，多一种就多一处会漂移的字面量。
 * 渲染时写进文件头部，覆盖判定在文件头部前几行找它。
 */
export const MANAGED_MARKER = '# managed by dp'

/** 去掉 `#` 的正文，与标记本体同源，避免各处再写一份字面量后漂移 */
const MANAGED_MARKER_TEXT = MANAGED_MARKER.slice(1).trim()

/**
 * 内容是否带 managed 标记。**只看前几行**：标记是头部注释，正文里出现同形文本
 * 不构成归属凭证 —— 否则文件里恰好引用了这串字面量就能骗过覆盖判定。
 * 空内容返回 false —— 它不可能是 dp 写的。
 *
 * 标记必须落在**注释行**里（行首是 `#`）：它首先是给人看的声明，不是该文件格式的
 * 有效语法；一个会被解释器当语法吃掉的标记，不能当归属凭证。
 *
 * @param content 目标机上那份文件的全文。读不到就让它抛错，**不要**拿空串顶替 ——
 * 「读不了」被当成「不存在」时，下一次判定就直接是一次覆盖
 * @returns true 只说明「头部注释自称由 dp 管理」，不说明内容真是 dp 写的；覆盖前仍要备份
 */
export function isManaged(content: string): boolean {
  return content
    .split(/\r?\n/)
    .slice(0, 5)
    .some((line) => line.trimStart().startsWith('#') && line.includes(MANAGED_MARKER_TEXT))
}

/**
 * 错误信息里保留多少子进程输出。整段塞进去会刷屏，并把真正有用的首行挤走
 */
export const EXEC_OUTPUT_LIMIT = 2000

/**
 * 截断长输出。数 MB 的 stderr 塞进异常既刷屏又会把真正有用的首行挤走；截断必须
 * 连同「原文多长」一起告诉读者，否则看不出丢掉了多少现场。
 *
 * @param text 原始输出
 * @param limit 保留上限，缺省 {@link EXEC_OUTPUT_LIMIT}
 * @returns 去掉首尾空白后的文本；超限时截断到 limit 并附加「已截断」说明
 */
export function excerptOutput(text: string, limit: number = EXEC_OUTPUT_LIMIT): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  return trimmed.length <= limit
    ? trimmed
    : `${trimmed.slice(0, limit)}…（已截断，原文 ${trimmed.length} 字节）`
}

/**
 * 把 unknown 摊成一句可读文本。补偿失败这类「错误里的错误」都经它进文本 ——
 * 它自己绝不抛错，非 Error 对象、任意值都能落成一句话。
 *
 * @param err 任意出错对象（DpError 带码，普通 Error 取 message，其余 String 化）
 * @returns 一句可读文本，格式：`码: 文案` / `message` / `String(err)`
 */
export function describeExecFailure(err: unknown): string {
  if (err instanceof DpError) return `${err.code}: ${err.message}`
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * 目标机路径拼接。**一律用 `/`**：这些路径会进远端的 conf 与命令行，反斜杠在 Linux 上
 * 是转义而不是分隔符，Windows 上的 Node fs 又认正斜杠 —— 为分隔符写两套分支只会让
 * 同一份配置在两端算出两个落点。空段直接丢弃：可选前缀缺省时不必先自己过滤一遍。
 * @param parts 路径段；空段与缺省段直接丢弃
 * @returns 以 `/` 连接的路径；全空入参得到空串
 */
export function joinRemotePath(...parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join('/')
}

/**
 * ssh 与 local 两份工具探测表**都含**的工具，顺序 = ssh 侧现顺序。
 *
 * 两端各有一批只在一端探的工具，不进这份清单：
 * - 仅 ssh 侧：`sudo` / `su` / `doas`（提权包装只发生在连接之上）、`scp` / `sftp` /
 *   `base64`（ssh 传输通道的备选与二进制通道）、`openssl`（探到即记，仓内暂无消费者）；
 * - 仅 local 侧：`sc`（Windows 服务控制器，本机 winsvc 探测用）。
 */
export const PROBE_TOOLS_SHARED: readonly string[] = [
  'ssh',
  'rsync',
  'tar',
  'gzip',
  'systemctl',
  'loginctl',
  'nginx',
  'docker',
  'git',
  'python3',
  'node',
  'java',
]
