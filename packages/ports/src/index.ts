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
 * 见 docs/privilege.md §1。
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
// 错误
// ============================================================

export type DpErrorCode =
  | 'CONFIG_INVALID'
  | 'DP.PATH.CASE_COLLISION'
  | 'DP.PATH.RESERVED_NAME'
  | 'DP.PATH.TOO_LONG'
  | 'DP.PATH.ILLEGAL_CHAR'
  | 'DP.PATH.WSL_MOUNT'
  | 'DP.PATH.NOT_WRITABLE'
  | 'DP.LAYOUT.MISMATCH'
  | 'DP.LAYOUT.UNSUPPORTED'
  | 'DP.PERM.ELEVATION_REQUIRED'
  | 'DP.PERM.CONFD_NOT_WRITABLE'
  | 'DP.SYSTEMD.NO_LINGER'
  | 'DP.SEC.RESCUE_UNSAFE_PATH'
  | 'DP.PREF.UNSUPPORTED'
  | 'DP.VERIFY.FAILED'
  | 'DP.VERIFY.NO_HEALTHCHECK'
  | 'DP.LINK.UNAVAILABLE'
  | 'DP.SOURCE.EMPTY'
  | 'DP.INTERACTIVE_PROMPT_DETECTED'
  | 'DP.TIMEOUT.EXEC'

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
 * 算 releaseId、打印 plan）而完全不读内容。这让 streaming（见
 * docs/transfer-streaming.md）和校验都成为可能。
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
