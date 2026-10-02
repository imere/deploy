/**
 * 传输层的**形状**。本文件零 IO —— 只有类型。
 *
 * 一条贯穿全包的原则（docs/transport.md §7）：**协商必须显式可见**。
 * 所以 `TransferResult` 必带 `kind` 与 `reasons`，`TransferChoice` 必带被拒绝的
 * 每一项 —— 只给结论等于没法排障（"为什么这次比上次慢" 是真实存在的用户问题）。
 */
import type { BecomeConfig, Facts, Logger, Runner } from '@dp/ports'

export type TransportKind = 'local-copy' | 'rsync-ssh' | 'tar-ssh' | 'scp' | 'sftp'

/** 用户显式偏好链。顺序即优先级；空表示走默认偏好链 */
export type TransportPreference = readonly TransportKind[]

export interface TransferRequest {
  readonly kind: 'local' | 'remote'
  /** 本机源根（绝对路径） */
  readonly localRoot: string
  /** 相对路径清单（'/' 分隔，相对 localRoot） */
  readonly entries: readonly string[]
  /** 目标机上的目录（绝对路径） */
  readonly remoteRoot: string
  /** remote 时的目标主机标识，只用于日志与错误 */
  readonly host?: string
  /** 'user@host[:port]'。**只用于拼远端目标串与日志，绝不整串进 argv** */
  readonly sshTarget?: string
  /** 多跳：[jump1, jump2]，按到达目标的顺序 */
  readonly hops?: readonly string[]
  readonly identityFile?: string
  readonly port?: number
  /** 远端提权（@dp/ports）。rsync 走 --rsync-path，tar 走命令包装 */
  readonly become?: BecomeConfig
  /** 是否删目标上多出来的文件。默认关：往非我们管理的目录做删除不可接受（transport.md §6） */
  readonly deleteExtraneous?: boolean
  readonly dryRun?: boolean
  readonly timeoutMs?: number
}

export interface TransferResult {
  readonly kind: TransportKind
  readonly filesTransferred: number
  /** 能统计到才有；rsync 的机器可读输出给得出，tar 给不出 */
  readonly bytes?: number
  /** 实际执行的 argv（**脱敏后**，绝不含凭据） */
  readonly command: readonly string[]
  readonly exitCode: number
  readonly warnings: readonly string[]
  readonly dryRun?: boolean
}

/** 一次协商的完整结论。`rejected` 是排障入口，不是附赠品。 */
export interface TransportChoice {
  readonly kind: TransportKind
  /** 选中的理由，缺省链上**靠前**的可选项 */
  readonly reasons: readonly string[]
  /** 被拒的每一种及原因。选中的那项不出现在这里 */
  readonly rejected: readonly { readonly kind: TransportKind; readonly reason: string }[]
  /** 非致命提示（如 scp 是最后手段） */
  readonly warnings: readonly string[]
}

export interface ChooseTransportInput {
  readonly local: Facts
  /** 远端探测结果。`kind: 'local'` 时与 local 同一份 */
  readonly remote: Facts
  readonly kind: 'local' | 'remote'
  readonly preferred?: TransportPreference
  /**
   * sftp 子系统是否可用。`Capabilities` 里没有这一项（ports 没定义），
   * 缺省 true —— 因为 Runner 抽象本身已能写文件，sftp 只是它的传输层实现。
   */
  readonly sftpAvailable?: boolean
}

/**
 * spawn 注入点。
 *
 * 存在的唯一理由：**测试不许起真子进程**（不许连网络）。生产默认
 * `child_process.spawn`，测试传 fake。
 */
export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly stdio?: unknown[]
  readonly detached?: boolean
  readonly windowsHide?: boolean
  readonly shell?: false
}

export interface SpawnedProcess {
  readonly stdin: {
    end(data?: string): void
    write(chunk: Uint8Array): boolean
    on(event: string, cb: (err: Error) => void): void
  }
  readonly stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void }
  readonly stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void }
  on(event: 'close', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal?: NodeJS.Signals): boolean
  readonly pid?: number
}

export type SpawnImpl = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess

export interface TransportDeps {
  /** 本机事实。协商的输入之一 */
  readonly localFacts?: Facts
  /** 远端事实。`kind: 'remote'` 时必填；`local` 时留空即复用 localFacts */
  readonly remoteFacts?: Facts
  readonly spawn?: SpawnImpl
  readonly logger?: Logger
  readonly now?: () => Date
  /**
   * `kind: 'local'` 时的落盘通道。
   *
   * **必须由调用方注入**：本包零依赖 @dp/local（依赖只有 ports/log/ssh/core），
   * 而且 CLI 手里已经有 `createLocalRunner()` 建好的 Runner —— 传进来比本包
   * 自己去 new 一个更对：只有一个本机真相来源。
   */
  readonly localRunner?: Runner
  /** 覆盖默认 timeout（测试用；不传走各自文件的默认值） */
  readonly timeoutMs?: number
  /** 显式偏好链。给了就按它选，不可用则抛 DP.PREF.UNSUPPORTED */
  readonly preferred?: TransportPreference
  /** 主机密钥策略。缺省 strict（AGENTS.md 铁律 3） */
  readonly knownHostsMode?: import('@dp/ssh').KnownHostsMode
  /** sftp 子系统是否可用，缺省 true */
  readonly sftpAvailable?: boolean
  /**
   * 认证方式。缺省由 `identityFile` 推断：给了就是 key，否则 agent。
   * **不猜密码** —— 密码属于 @dp/ssh 的 SSH_ASKPASS 通道，不在本包范围。
   */
  readonly identityFileKind?: import('@dp/ssh').SshAuthKind
}
