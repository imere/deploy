/**
 * @dp/ports —— 所有包共享的纯类型与错误定义。
 *
 * 铁律：本包零依赖、零 IO。它只描述"形状"，不做任何事情。
 */

// ============================================================
// 平台与身份
// ============================================================

/**
 * 目标机 OS。取值与 Node 的 `process.platform` 对齐但**不共用**：
 * 'unknown' 是探测失败时必须能表达的第四态。混用会让人在探测失败时
 * 拿到一个看起来合法的假平台，于是所有路径判断都基于猜测跑完。
 */
export type Platform = 'linux' | 'darwin' | 'win32' | 'freebsd' | 'unknown'
/** CPU 架构。unknown 之外的 'other' 表示已知非 x86/arm，决策上按「不能假设行为一致」处理 */
export type Arch = 'x64' | 'arm64' | 'x86' | 'arm' | 'other'
/**
 * init 系统。'none' 是合法结论而非探测失败：容器里没有 init 是常态，
 * 而它决定了 unit 文件写给谁。把「没装 systemd」和「没测出来」分成两态，
 * 前者继续部署、后者报错 —— 合成一个值的结果是部署在容器里被 systemd 假设拖死。
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
   *
   * 为什么这个字段必须存在：写权限的判定**只看建文件有没有成功** —— 文件建出来了
   * 就是实证。清理失败（占用、ACL、杀毒软件锁）发生在判定之后，拿它推翻判定等于
   * 把一台明明可写的机器报成不可写，症状是所有候选目录同时被判死、部署跑不动。
   * 但清理失败同样不能静默：静默过一次的后果是残留攒了一堆而日志里没有任何线索。
   * 所以它必须从探测里出来，交给调用方打日志或写进报告。
   *
   * 可选而非必填：没有残留时不出现这个键，且产出 facts 的 ssh 侧不产生它 ——
   * 让它必填会把所有构造 Capabilities 的地方都拖成必改项。
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
/**
 * 指向当前生效版本的软链名。
 *
 * 必须是软链而不是「复制一份」：服务读的路径要能在两次部署之间**零成本换指向**，
 * 任何需要搬文件才能切版本的方案都会产生一个「服务已停止而新目录还没就绪」的窗口。
 */
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
// SSH 连接串
// ============================================================

/** 主机密钥策略。放这里是因为 schema（校验枚举）与 ssh（消费它）都要用，两处各写一份字面量必然漂移 */
export const KNOWN_HOSTS_MODES = ['strict', 'accept-new', 'tofu', 'off'] as const
/** 从 KNOWN_HOSTS_MODES 派生，schema 校验与驱动实现读的是同一组字面量 */
export type KnownHostsMode = (typeof KNOWN_HOSTS_MODES)[number]

/**
 * 解析结果。`user` / `port` 可缺省是**刻意的**：缺省意味着「交给 ssh 自己按
 * ssh_config 决定」，而补一个默认值会绕开 ssh_config —— 配了 `Port 2222` 的
 * Host 别名会静默连到 22 端口的另一台机器上。
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
 * 为什么住在契约层：`hosts.*.ssh` 与每一跳的 `ssh` 字段是**同一种写法**，
 * 解析它的三处（配置校验、连接装配、argv 拼装）必须共享一份实现 ——
 * 各写一份就会出现「配置层认为合法、连接时才炸」的错位错误。
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

// ============================================================
// 错误
// ============================================================

/**
 * 全仓唯一的错误码登记表，`DpErrorCode` 由它派生。
 *
 * 之所以用登记而不是各包自由发字符串：散着发时「同一个故障两处用了不同码」
 * 无法被发现，而调用方只能按码分派处置方式（改配置 / 回滚 / 重试）——
 * 码一漂，分派就静默走错分支。
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
  // ↓ 多跳链式转发（@dp/ssh）追加。单列而不是复用 DP.SSH.CONNECT_FAILED：
  // 那条说的是"目标机连不上"，处置是查目标机；这条说的是"链上第 N 跳没通"，
  // 处置是查那一跳的前一跳（转发被禁？路由不通？跳板上没有 nc？）——
  // 同一个网络故障，链式与非链式要看的机器根本不是同一台。
  'DP.SSH.HOP_FAILED',
] as const

/** 从数组派生：加码只改上面那一个地方，类型自动跟上 */
export type DpErrorCode = (typeof DP_ERROR_CODES)[number]

/**
 * 错误附带的定位信息。
 *
 * 三项全可选是刻意的：错误可以来自 CLI 自身的用法问题（与配置无关），
 * 强制填写只会让每一处 throw 都为凑字段而编造路径。
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

/**
 * 管线的固定八段。
 *
 * 定死枚举而不是让各目标自造阶段名：上层按 kind 分派「这步失败要不要回滚上一步」，
 * 名字一自由化这套分派就会漏掉新名字 —— 表现为失败后停在半路且无人察觉。
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

// ============================================================
// Runner —— 对"一台机器"的抽象
// ============================================================

/**
 * 一次命令执行的结果。
 *
 * 不设「成功」布尔量：退出码为 0 但 stderr 有内容是常态（编译器的 warning、
 * 服务的启动提示），把它当失败会让「先看看再说」变成硬错误。
 */
export interface ExecResult {
  /** 进程退出码。被信号杀掉时按惯例给 128+信号号，不归一化成 1 —— 归一化会抹掉「是谁杀的」 */
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * 执行选项。**没有 shell 选项**是接口层的硬约束：
 * 参数只能是 argv 数组，命令注入的面从类型上就不存在。
 */
export interface ExecOptions {
  /** 工作目录。不存在时由驱动报错，不自动创建 —— 自动创建会把拼错的路径变成真目录 */
  readonly cwd?: string
  /**
   * 超时（毫秒）。**每个子进程都必须给**：ssh 到一台不可达的主机上会挂住，
   * 没有兜底就是一次永不返回的部署。
   */
  readonly timeoutMs?: number
  /** 覆盖式环境变量，与父进程合并而非替换 */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 绝不喂 stdin —— 避免远端 prompt 挂起（铁律 0：永不交互） */
  readonly stdin?: string
}

/**
 * 一条路径的元信息。字段是 stat 的直接映射，不做「友好化」：
 * 预检需要的是和文件系统一致的原始事实。
 */
export interface FileStat {
  readonly isDirectory: boolean
  readonly isSymbolicLink: boolean
  /** 字节数，符号链接本身的大小而非目标的大小 */
  readonly size: number
  /** 毫秒时间戳。与 `Date.now()` 同一时基，不做本地化 */
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

/**
 * 一个待创建的目录。与 SourceFile 的区别是**没有 read()**：
 * 目录不产出字节，给它一个空的 read 会诱导实现编造空内容。
 */
export interface SourceDir {
  readonly kind: 'dir'
  /** 相对 source 根的路径，始终用 `/` 分隔 */
  readonly relativePath: string
  /** 权限位（八进制，如 0o755）。省略时由传输层按 umask 决定，不硬编码 0o644 */
  readonly mode?: number
}

/**
 * 源清目的一个条目。文件与目录的联合，让传输层能一次遍历而不必分两次枚举 ——
 * 分开枚举会让「先建目录再传文件」的顺序依赖两次独立快照，中间被改动的文件会漏掉。
 */
export type SourceEntry = SourceFile | SourceDir

// ============================================================
// Target —— 投递目标（static / nginx / docker / 未来更多）
// ============================================================

/**
 * 一次目标操作的输入。
 *
 * `previousReleaseId` 叫「前一个」而不是「上一个版本」，因为它在**回滚时是当前版本**：
 * 目标靠它判断该退到哪，两种方向共用这一个字段，少一个字段就少一类传错身份的可能。
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
 *
 * 四个方法都是**纯函数**（吃 ctx 与 config，吐 Step[]），没有 IO：
 * 这样 plan 的产物能在没有目标机的机器上逐条断言。
 * 拆成 install/activate/verify/rollback 四段而不是一个 deploy，
 * 是因为它们的**失败后果不同** —— activate 失败不回滚 release，
 * verify 失败要回滚，合成一个方法后调用方无法分别处置。
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
 *
 * 只给 `write(line, record)` 而不是只有格式化好的字符串：JSON 报告要读结构化字段，
 * 而人读的格式里字段已经被拼进文本、再解析回去等于二次编码。
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
