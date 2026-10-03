/**
 * @dp/ports —— 所有包共享的纯类型与错误定义。
 *
 * 铁律：本包零依赖、零 IO。它只描述"形状"，不做任何事情。
 */

// ============================================================
// 平台与身份
// ============================================================

export type Platform = 'linux' | 'darwin' | 'win32' | 'freebsd' | 'unknown'
export type Arch = 'x64' | 'arm64' | 'x86' | 'arm' | 'other'
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

// ============================================================
// 发布目录的命名
// ============================================================

/**
 * 发布目录的三个名字。**全仓只有这一份**。
 *
 * 它们同时被四处使用：`@dp/core` 的步骤标题、`@dp/target-static` 的真实目录操作、
 * `@dp/template` 的 `${release.current}`、以及 `@dp/target-docker` 算 compose 的 cwd。
 * 这四处写的其实是同一套约定 —— 各写一份的结果是「改了目录名只改了三处」，
 * 而漏掉的那处表现为**路径指到了一个真实存在但内容不对的目录**：不报错，只是部署了个寂寞。
 */
export const RELEASES_DIR_NAME = 'releases'
export const CURRENT_LINK_NAME = 'current'
/** 传输中的半成品后缀。正在服务的目录永远不直接被写 */
export const INCOMING_SUFFIX = '.incoming'

/**
 * 实测可写性的 POSIX 候选目录。
 *
 * `@dp/local`（本机探测）与 `@dp/ssh`（远端探测）**必须用同一张表**：两份 facts
 * 只是来源不同，语义必须可比。各写一份的后果是同一份配置在远端能推出 confd、
 * 在本机推不出来（表现为「ssh 目标成功、local 目标报权限错」），而这种错指不回真正的原因。
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

// ============================================================
// 错误
// ============================================================

export const DP_ERROR_CODES = [
  'CONFIG_INVALID',
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
  // ↓ SSH 远端 Runner（@dp/ssh）追加。注意 `CONFIG_INVALID` 是命名空间化之前
  // 留下的历史名，它没有点分前缀；新代码一律用 `DP.CONFIG.INVALID`。
  'DP.CONFIG.INVALID',
  'DP.SSH.CONNECT_FAILED',
  'DP.SSH.AUTH_FAILED',
  'DP.SSH.HOST_KEY_UNKNOWN',
  'DP.SSH.HOST_KEY_MISMATCH',
  'DP.SSH.TOOL_MISSING',
  'DP.SSH.DRIVER_UNAVAILABLE',
  'DP.SSH.TUNNEL_FAILED',
  // ↓ 模板层（@dp/template）追加。渲染期的问题一律用 DP.TPL.*：
  // 出现它们说明「配置里写了不能成立的变量」或「渲染出的值不该进那个位置」，
  // 而不是部署执行失败 —— 两者的处置方式完全不同（改配置 vs 停下来）。
  'DP.TPL.UNKNOWN_VAR',
  'DP.TPL.MISSING_ENV',
  'DP.TPL.MISSING_VALUE',
  'DP.TPL.SYNTAX',
  'DP.TPL.UNSAFE_VALUE',
  // ↓ nginx 目标（@dp/target-nginx）追加。conf 相关的问题单列一组：它们全部
  // 可在 plan 期判定、且处置方式是「改配置」，与 DP.TPL.*（变量本身不成立）
  // 分开是为了让调用方能区分「变量错了」与「把变量放进这个位置是错的」。
  'DP.NGX.CONF_INVALID',
  'DP.NGX.NOT_MANAGED',
  'DP.NGX.UNSAFE_VALUE',
  'DP.NGX.RELOAD_CMD_INVALID',
  'DP.NGX.NO_PREVIOUS',
  // ↓ nginx 执行器（@dp/target-nginx）追加。这两个单列的理由是**处置方式相反**：
  // 上面的 DP.NGX.* 都能在动手之前判定，处置是「改配置然后重来」；
  // 而这两个是「配置通过了本包能做的全部校验、nginx 仍然不接受」：
  // TEST_FAILED 的原话在 stderr 里，多半是同一棵树上的别的文件或环境问题；
  // RELOAD_FAILED 时盘上的 conf 已经被 `-t` 接受，nginx 只是没收到信号，
  // 重跑一次 reload 就收敛 —— 此时回滚反而制造第二次不一致。合成一个码，
  // 调用方就只能对两种相反的处置一律回滚。
  'DP.NGX.TEST_FAILED',
  'DP.NGX.RELOAD_FAILED',
  // ↓ docker 目标（@dp/target-docker）追加。全部是**配置期可判定**的问题：
  // 它们要么在拼 argv 之前就被顶回（项目名字符集、compose 文件路径、mode），
  // 要么是「命令跑了但输出读不出结论」（ps 解析）。后者单独一组的理由是
  // 处置方式相反：前者改配置重来，后者要先确认远端 compose 可用，重跑没用。
  'DP.DOCKER.MODE_UNSUPPORTED',
  'DP.DOCKER.PROJECT_NAME_INVALID',
  'DP.DOCKER.COMPOSE_FILES_EMPTY',
  'DP.DOCKER.COMPOSE_FILE_DUPLICATED',
  'DP.DOCKER.COMPOSE_FILE_INVALID',
  'DP.DOCKER.PS_PARSE_FAILED',
  'DP.DOCKER.NO_PREVIOUS',
  // ↓ docker 执行器（@dp/target-docker）追加。这三个与上面那组**处置方式相反**：
  // 上面全部是配置期可判定的「改配置重来」，而这三个是「配置过了、命令真的跑了」。
  // FILE_MISSING 靠 stat 实证（compose 文件本该由传输层搬上来，缺了是上游漏了，
  // 不是配置写错）；PULL_FAILED 靠真跑一次 pull 才成立（改配置对它是无效动作）；
  // PLAN_MISMATCH 单列的理由是它根本不是部署失败 —— 计划与执行器不同步是代码错误，
  // 按部署失败去回滚只会回滚一个其实没有任何副作用的部署。
  'DP.DOCKER.FILE_MISSING',
  'DP.DOCKER.PULL_FAILED',
  'DP.DOCKER.PLAN_MISMATCH',
  // ↓ 激活失败（在册，但类型里一直缺这一条）。它单列而不是复用
  // DP.VERIFY.FAILED：处置方向相反 —— 验收没过是「已经起来了但状态不对」，
  // 激活失败是「根本没起来」，上层 `dp apply` 据此决定回滚与否。
  'DP.ACTIVATE.START_FAILED',
] as const

/** 从数组派生：加码只改上面那一个地方，类型自动跟上 */
export type DpErrorCode = (typeof DP_ERROR_CODES)[number]

export interface DpErrorOptions {
  /** 出错的配置路径，如 `projects.web.source` */
  readonly path?: string
  /** 给用户的修复建议 */
  readonly hint?: string
  readonly cause?: unknown
}

/**
 * 所有错误都带 code + 可读 message + 可选 hint。
 *
 * 设计约束：错误信息必须能**指导下一步动作**，而不是只描述失败。
 * 没有 hint 的错误等于没报错 —— CLI 会因此无法告诉用户该配什么。
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

// ============================================================
// 管线步骤
// ============================================================

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

// ============================================================
// Runner —— 对"一台机器"的抽象
// ============================================================

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export interface ExecOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 绝不喂 stdin —— 避免远端 prompt 挂起（铁律 0：永不交互） */
  readonly stdin?: string
}

export interface FileStat {
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
  readonly size: number
  readonly mtimeMs: number
}

// ============================================================
// 源 —— 传输与目标之间的一致形状
// ============================================================

/**
 * 一条待投递的源条目。
 *
 * 关键是 `read()` 是**惰性**的：传入拒可以先枚举清单（做跨平台校验、
 * 算 releaseId、打印 plan）而完全不读内容。这让 streaming 和校验都成为可能。
 */
export interface SourceFile {
  readonly kind: 'file'
  /** 相对 source 根的路径，始终用 `/` 分隔 */
  readonly relativePath: string
  readonly mode?: number
  read(): Promise<Uint8Array>
}

export interface SourceDir {
  readonly kind: 'dir'
  readonly relativePath: string
  readonly mode?: number
}

export type SourceEntry = SourceFile | SourceDir

// ============================================================
// Target —— 投递目标（static / nginx / docker / 未来更多）
// ============================================================

export interface TargetContext {
  readonly host: string
  readonly root: string
  readonly releaseId: string
  /** 当前生效版本；首次部署为 undefined */
  readonly previousReleaseId?: string
  readonly keep: number
}

export interface Target<C = unknown> {
  readonly type: string
  planInstall(ctx: TargetContext, config: C): readonly Step[]
  planActivate(ctx: TargetContext, config: C): readonly Step[]
  planVerify(ctx: TargetContext, config: C): readonly Step[]
  planRollback(ctx: TargetContext, config: C): readonly Step[]
}

/**
 * 一台机器上能做的事。local 与 ssh 各实现一份，core 只认这个接口。
 *
 * 关键：这里**没有** `execShell(string)` —— 只有 `exec(argv[])`。
 * 命令注入的面从接口层就被掐掉了。
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
   * 同文件系统内的 rename。**原子发布的唯一依赖**：切换 current 不能
   * 用「删旧 + 建新」，那中间有窗口会导致服务悬空。
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

// ============================================================
// Logger —— 结构化日志（实现见 @dp/log）
// ============================================================

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

// ============================================================
// 提权 —— 由 @dp/ssh 的 become.ts 落地包装
// ============================================================

/**
 * 提权方式的**运行期**形状。
 *
 * 这是配置里 `hosts.*.become` 经 schema 层归一化之后的产物：
 * `method: auto|nopasswd|stdin|pty` 与 `passwordRef` 属于配置与凭据解析层，
 * 不该混进这条运行时契约（解析 ref 是 schema 的职责）。
 *
 * 硬约束：任何一种取值都**不允许产生会等待 stdin 的命令**（铁律 0）。
 * `nonInteractive: false` 只是"不要 `-n`"，密码通道必须由调用方显式提供。
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
 *
 * 存在它是因为「能力一律实证」这条铁律：配置里写了
 * `become: { type: 'sudo' }` 不代表这台机器上 `sudo -n` 真能成
 * —— 所以每次部署都要用 `canElevate()` 跑一次并把结论记在这里。
 */
export interface Elevation {
  readonly become: BecomeConfig
  /** 目标身份。不由 uid 推断，由 `sudo -n id -un` 的真实输出得到 */
  readonly targetUser?: string
  readonly available: boolean
  /** 不可用时的原因（远端原话脱敏后），或可用的实测依据 */
  readonly reason?: string
}
