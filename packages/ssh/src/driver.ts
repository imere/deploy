/**
 * SSH 驱动抽象与**偏好链**。
 *
 * 为什么要两条驱动（spikes.md 对设计的冲击 #1）：
 *  - `native-ssh` 走系统 ssh 二进制：抗量子 KEX ✅（S2 实测默认就协商出
 *    mlkem768x25519-sha256）、ssh_config ✅、ProxyJump ✅、密码靠 SSH_ASKPASS（S3）
 *  - `ssh2` 是纯 JS：零外部依赖、keyboard-interactive ✅、rsync 隧道 ✅，
 *    但**不支持任何 PQC KEX**（S1 实测传 mlkem768x25519-sha256 直接抛
 *    Unsupported algorithm）
 *
 * 所以 native 排第一，ssh2 是降级。链上全失败时必须把**每一项的失败原因**都
 * 报出来（AGENTS.md：没有 hint 的错误等于没报错）。
 */
import { DpError } from '@dp/ports'
import type { SshArgvOptions } from './argv.js'

export type SshDriverKind = 'native-ssh' | 'ssh2'

export interface DriverAvailability {
  readonly ok: boolean
  readonly reason?: string
  readonly hint?: string
}

export interface ExecRequest {
  /** 远端命令的 argv。**不是字符串** —— 注入的面从接口层就掐掉了 */
  readonly argv: readonly string[]
  readonly timeoutMs?: number
  readonly cwd?: string
  /** 远端额外环境变量。凭据绝不许走这里（security.md §3） */
  readonly env?: Readonly<Record<string, string>>
}

export interface Tunnel {
  /** 给 rsync `--rsh` 用的 argv 前缀；见 argv.ts 的 buildRshArgv */
  readonly rshArgv: readonly string[]
  close(): Promise<void>
}

export interface SshDriver {
  readonly kind: SshDriverKind
  /** 这条驱动能不能用（native：ssh 二进制在不在；ssh2：模块能否 require） */
  available(): Promise<DriverAvailability>
  exec(req: ExecRequest): Promise<DriverExecResult>
  /** 为 rsync/scp/sftp 提供一条到远端的通道 */
  openTunnel?(): Promise<Tunnel>
  close(): Promise<void>
}

export interface DriverExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

// ------------------------------------------------------------
// 连接配置
// ------------------------------------------------------------

export type KnownHostsMode = 'strict' | 'accept-new' | 'tofu' | 'off'

/**
 * 凭据只以 **ref** 的形式出现在配置里（`env:X` / `file:/p` / `cmd:...`）。
 *
 * `@dp/ssh` **自己不解析 ref** —— 那属于 schema/config 层。调用方解析后把明文
 * 通过 `resolvedSecrets` 传进来。本包保证的是：明文绝不出现在任何 message /
 * hint / 日志字段 / argv / 远端命令里。
 */
export type AuthConfig =
  | { readonly type: 'key'; readonly identityFile?: string; readonly passphraseRef?: string }
  | { readonly type: 'agent' }
  | { readonly type: 'password'; readonly passwordRef: string }
  | { readonly type: 'keyboard-interactive'; readonly passwordRef: string }

export interface HopSpec {
  /** `user@host` 或 `user@host:port` */
  readonly ssh: string
  readonly auth?: AuthConfig
  readonly knownHosts?: KnownHostsMode
  readonly port?: number
}

/** 调用方解析完 ref 之后传进来的明文。字段名即脱敏键（@dp/log 按 key 脱敏） */
export interface ResolvedSecrets {
  readonly password?: string
  readonly passphrase?: string
  readonly keyBuffer?: Uint8Array
}

export interface SshConnectionOptions {
  readonly host: string
  readonly port?: number
  readonly user?: string
  readonly auth: AuthConfig
  readonly secrets?: ResolvedSecrets
  /** 默认 strict —— 需要安全感的人会显式放宽，而不是反过来 */
  readonly knownHosts?: KnownHostsMode
  readonly userKnownHostsFile?: string
  /** tofu 模式的 pin 文件；不填则 argv.defaultPinPath() */
  readonly pinnedHostKeysPath?: string
  readonly driver?: SshDriverKind
  /** 逐个尝试的驱动顺序；不给则 [native-ssh, ssh2] */
  readonly preferred?: readonly SshDriverKind[]
  readonly identityFile?: string
  readonly proxyJump?: string
  readonly extraOptions?: readonly string[]
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /**
   * 多跳。本批**未实现**（spikes.md S4：加固跳板机普遍禁 TCP 转发，
   * 降级链 direct-tcpip → nc → ssh-relay 留到下一批）。
   * 给了非空值就报错，而不是悄悄按单跳处理。
   */
  readonly hops?: readonly HopSpec[]
}

export const DEFAULT_SSH_TIMEOUT_MS = 30_000
/** 远端输出上限，防止一条 `cat /dev/zero` 打爆本机内存 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/** 显式指定了未实现的非空 hops → 立刻拒，别让它悄悄按单跳跑 */
export function assertNoHops(hops: readonly HopSpec[] | undefined): void {
  if (hops !== undefined && hops.length > 0) {
    throw new DpError('DP.CONFIG.INVALID', `多跳尚未支持：收到 ${hops.length} 跳配置`, {
      path: 'hosts.*.ssh.hops',
      hint: '本批只做单跳。带跳板机请改用 native-ssh + ssh.proxyJump（单跳由系统 ssh 的 ProxyJump 处理）；多跳降级链（direct-tcpip → nc → ssh-relay）见 docs/spikes.md S4，下一批实现',
    })
  }
}

export function resolveTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit
  const env = process.env.DP_SSH_TIMEOUT_MS
  const parsed = env === undefined ? Number.NaN : Number(env)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SSH_TIMEOUT_MS
}

// ------------------------------------------------------------
// 偏好链
// ------------------------------------------------------------

export type DriverFactory = (kind: SshDriverKind) => SshDriver

export interface DriverAttempt {
  readonly kind: SshDriverKind
  readonly availability: DriverAvailability
}

/**
 * 按偏好链挑一条可用驱动。
 *
 * 全失败 / 显式指定却不可用 → `DP.SSH.DRIVER_UNAVAILABLE`，**message 里逐项列出
 * 失败原因**。这是本文件唯一允许抛错的地方，别把原因吞掉。
 */
export async function resolveDriver(
  factory: DriverFactory,
  options: { readonly preferred?: readonly SshDriverKind[]; readonly explicit?: SshDriverKind },
): Promise<{ readonly driver: SshDriver; readonly attempts: readonly DriverAttempt[] }> {
  const order = options.preferred ?? (options.explicit === undefined ? DEFAULT_PREFERENCE : [options.explicit])
  const attempts: DriverAttempt[] = []

  for (const kind of order) {
    const driver = factory(kind)
    // 工厂造不出来的驱动（例如按需 import 失败）也记一笔，别让它消失
    let availability: DriverAvailability
    try {
      availability = await driver.available()
    } catch (err) {
      availability = { ok: false, reason: `探测可用性时抛错：${(err as Error).message}` }
    }
    attempts.push({ kind, availability })
    if (availability.ok) return { driver, attempts }
  }

  const detail = attempts
    .map((a) => `  · ${a.kind}：${a.availability.reason ?? '不可用'}`)
    .join('\n')
  const hint = [
    options.explicit === undefined
      ? '安装 OpenSSH 客户端（Windows 10+ 自带 ssh.exe，Linux 用 openssh-client），或装 ssh2'
      : `你显式指定了 ${options.explicit} 但它不可用`,
    'ssh2 是可选依赖：`pnpm add -D ssh2` 后本包会自动降级使用它',
    '注意：ssh2 **不支持抗量子 KEX**（spikes.md S1 实测），若 crypto.kexPolicy=pq-required 只能走 native-ssh',
  ].join('；')

  throw new DpError('DP.SSH.DRIVER_UNAVAILABLE', `没有可用的 SSH 驱动，已尝试：\n${detail}`, { hint })
}

/** 默认顺序：native 优先（唯一能抗量子），ssh2 兜底 */
export const DEFAULT_PREFERENCE: readonly SshDriverKind[] = ['native-ssh', 'ssh2']

export type { SshArgvOptions }
