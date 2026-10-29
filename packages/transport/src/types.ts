import type { BecomeConfig, Facts, Logger, Runner } from '@dp/ports'

/**
 * 可选的传输方式，取值同时是协商的分支名与执行器的 dispatch 名。
 */
export type TransportKind = 'local-copy' | 'rsync-ssh' | 'tar-ssh' | 'scp' | 'sftp'

/** 用户显式偏好链。顺序即优先级；空表示走默认偏好链 */
export type TransportPreference = readonly TransportKind[]

/**
 * 一次传输的请求。
 */
export interface TransferRequest {
  /** 目标是不是另一台机器。决定要不要跑协商、能不能走 ssh 那几条路 */
  readonly kind: 'local' | 'remote'
  /** 本地源根（绝对路径） */
  readonly localRoot: string
  /** 相对路径清单（'/' 分隔，相对 localRoot） */
  readonly entries: readonly string[]
  /**
   * 目标机上的目录。**必须绝对**：相对路径会按目标机的 cwd 解析，而那不是我们能预知的地方，写错了要等到目标机报错才看得见。
   */
  readonly remoteRoot: string
  /** remote 时的目标主机标识，只用于日志与错误 */
  readonly host?: string
  /** 'user@host[:port]'。**只用于拼远端目标串与日志，绝不整串进 argv** */
  readonly sshTarget?: string
  /** 多跳：[jump1, jump2]，按到达目标的顺序 */
  readonly hops?: readonly string[]
  /** 私钥路径。给了即认定是 key 认证，不给走 agent —— 不猜密码 */
  readonly identityFile?: string
  /**
   * 目标端口。不传则由 ssh 按 ssh_config 决定：补一个 22 会绕开 Host 别名里配的 Port，于是配置看着生效、连的却是另一台机器。
   */
  readonly port?: number
  /** 远端提权（@dp/ports）。rsync 走 --rsync-path，tar 走命令包装 */
  readonly become?: BecomeConfig
  /** 是否删目标上多出来的文件。默认关：往非我们管理的目录做删除不可接受 */
  readonly deleteExtraneous?: boolean
  /**
   * 只演练不改机器。**干跑全绿不等于真跑能成** —— 权限、磁盘、链路都只有真跑才暴露，所以结果里带 dryRun 标记，让报告能说清「这次什么都没验证」。
   */
  readonly dryRun?: boolean
  /** 毫秒。覆盖各执行器自己的缺省；不传不是「不限时」 */
  readonly timeoutMs?: number
}

/**
 * 一次传输的结果。
 */
export interface TransferResult {
  /** 实际走的那条路。不出现「协商说 A、实际跑了 B」 */
  readonly kind: TransportKind
  /** 传输条目数。dryRun 下恒为 0：没搬东西却报一个从清单推出来的数字就是谎报 */
  readonly filesTransferred: number
  /** 能统计到才有；rsync 的机器可读输出给得出，tar 给不出 */
  readonly bytes?: number
  /** 实际执行的 argv（**脱敏后**，绝不含凭据） */
  readonly command: readonly string[]
  /** 传输工具自己的退出码，保留原值。归一化成 0/1 会抹掉「部分失败」这类结论 */
  readonly exitCode: number
  /** 非致命但用户需要知道的事（降级、无增量、部分传输）。空数组表示没有 */
  readonly warnings: readonly string[]
  /** 只在 dryRun 成立时出现。让「干跑过」与「没这个字段」不是同一件事 */
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

/**
 * 协商的输入。
 */
export interface ChooseTransportInput {
  /** 本地事实 */
  readonly local: Facts
  /** 远端探测结果。`kind: 'local'` 时与 local 同一份 */
  readonly remote: Facts
  /** 本地目标时忽略 preferred 并直接定 local-copy */
  readonly kind: 'local' | 'remote'
  /** 显式偏好链，顺序即优先级。给了就只按它选，一个都不成立就抛错 */
  readonly preferred?: TransportPreference
  /**
   * sftp 子系统是否可用。`Capabilities` 里没有这一项（ports 没定义），缺省 true —— 因为 Runner 抽象本身已能写文件，sftp 只是它的传输层实现。
   */
  readonly sftpAvailable?: boolean
}

/**
 * 子进程执行的注入点，测试靠它替换掉真实 spawn
 */
export interface SpawnOptions {
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly stdio?: unknown[]
  readonly detached?: boolean
  readonly windowsHide?: boolean
  readonly shell?: false
}

/**
 * 起起来之后的子进程，**只声明用得到的成员**。
 */
export interface SpawnedProcess {
  /**
   * 喂完立刻 end，所以只需要「写 + 关闭 + EPIPE 通知」三件事；流本身（pipe / destroy / on('drain')）本包一个都不用。
   */
  readonly stdin: {
    end(data?: string): void
    write(chunk: Uint8Array): boolean
    on(event: string, cb: (err: Error) => void): void
  }
  /** 只订阅 `data`：不读文件描述符，也拿不到流本身 */
  readonly stdout: { on(event: 'data', cb: (chunk: Buffer) => void): void }
  /** 同 stdout：输出走内存 Buffer，所以只认 Buffer 回调 */
  readonly stderr: { on(event: 'data', cb: (chunk: Buffer) => void): void }
  on(event: 'close', cb: (code: number | null) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  kill(signal?: NodeJS.Signals): boolean
  /**
   * 子进程号，杀进程树要用它 —— 超时后能收干净整棵子进程树就靠这一条。
   */
  readonly pid?: number
}

/**
 * spawn 的函数签名，逐个参数与 `child_process.spawn` 对齐。
 */
export type SpawnImpl = (
  file: string,
  args: readonly string[],
  options: SpawnOptions,
) => SpawnedProcess

/**
 * 传输需要的外部依赖。
 */
export interface TransportDeps {
  /** 本地事实。协商的输入之一 */
  readonly localFacts?: Facts
  /** 远端事实。`kind: 'remote'` 时必填；`local` 时留空即复用 localFacts */
  readonly remoteFacts?: Facts
  /** 覆盖 spawn。测试传 fake 就不会真的去连目标机 */
  readonly spawn?: SpawnImpl
  /** 不传则建一个默认 logger */
  readonly logger?: Logger
  /** 时钟注入。耗时字段用它而不是 `Date.now()`，否则时长没法断言 */
  readonly now?: () => Date
  /**
   * `kind: 'local'` 时的落盘通道。
   */
  readonly localRunner?: Runner
  /** 覆盖默认 timeout（测试用；不传走各自文件的默认值） */
  readonly timeoutMs?: number
  /** 显式偏好链。给了就按它选，不可用则抛 DP.PREF.UNSUPPORTED */
  readonly preferred?: TransportPreference
  /** 主机密钥策略。缺省 strict（铁律 3） */
  readonly knownHostsMode?: import('@dp/runner-ssh').KnownHostsMode
  /** sftp 子系统是否可用，缺省 true */
  readonly sftpAvailable?: boolean
  /**
   * 认证方式。缺省由 `identityFile` 推断：给了就是 key，否则 agent。
   */
  readonly identityFileKind?: import('@dp/runner-ssh').SshAuthKind
}
