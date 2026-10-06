/**
 * SSH 驱动抽象与**偏好链**。
 *
 * 为什么要两条驱动：
 *  - `native-ssh` 走系统 ssh 二进制：抗量子 KEX ✅（S2 实测默认就协商出
 *    mlkem768x25519-sha256）、ssh_config ✅、ProxyJump ✅、密码靠 SSH_ASKPASS（S3）
 *  - `ssh2` 是纯 JS：零外部依赖、keyboard-interactive ✅、rsync 隧道 ✅，
 *    但**不支持任何 PQC KEX**（S1 实测传 mlkem768x25519-sha256 直接抛
 *    Unsupported algorithm）
 *
 * 所以 native 排第一，ssh2 是降级。链上全失败时必须把**每一项的失败原因**都
 * 报出来（没有 hint 的错误等于没报错）。
 */
import { DpError, assertPortInRange, parseSshTarget, type KnownHostsMode as PortsKnownHostsMode } from '@dp/ports'
import type { SshArgvOptions } from './argv.js'

/**
 * 驱动的两种身份。**native-ssh 排第一**是硬排序而不是偏好（`DEFAULT_PREFERENCE`）：
 * 只有它能协商抗量子 KEX，而 ssh2 遇到 PQ 算法直接抛错 —— 顺序反过来的后果是
 * "配了 pq-required 却连不上"，且错误指向认证而不是 KEX 策略。
 */
export type SshDriverKind = 'native-ssh' | 'ssh2'

/**
 * 一条驱动能不能用。**reason / hint 是必填语义而不是可选补充**：
 * 偏好链全失败时要把每一项的理由逐条打给用户；留空的理由是没办法救的建议。
 */
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
  /** 远端额外环境变量。凭据绝不许走这里 */
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

export type KnownHostsMode = PortsKnownHostsMode

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
  readonly hops?: readonly HopSpec[]
  /**
   * 跳板的 direct-tcpip 被拒时，是否允许在跳板上 exec `nc` 兜底。
   *
   * 默认 false。nc 是在**跳板机上起进程**，而链式转发只需要一条字节流 ——
   * 开这个开关等于把「目标能不能到」的决定权交给跳板上装了什么。
   */
  readonly allowNcHopFallback?: boolean
}

export const DEFAULT_SSH_TIMEOUT_MS = 30_000
/** 远端输出上限，防止一条 `cat /dev/zero` 打爆本机内存 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * 逐跳校验。**不合法就报错，绝不悄悄降级成单跳** —— 静默忽略 hops 会让人以为
 * 流量走了跳板机，实际却直连了目标机（这正是跳板机被放在那里的原因）。
 *
 * 校验内容与配置层一致（连接串、端口区间、knownHosts 枚举），因为 `SshConnectionOptions`
 * 可以绕过 `@dp/schema` 直接构造：探针、测试、多目标扇出都走这条路。
 */
export function validateHops(hops: readonly HopSpec[] | undefined): void {
  if (hops === undefined || hops.length === 0) return
  hops.forEach((hop, i) => {
    const path = `hosts.*.ssh.hops[${i}]`
    const target = parseSshTarget(hop.ssh, `${path}.ssh`)
    if (hop.port !== undefined) {
      assertPortInRange(hop.port, `${path}.port`)
      if (target.port !== undefined && target.port !== hop.port) {
        throw new DpError(
          'DP.CONFIG.INVALID',
          `第 ${i} 跳给了两个互相矛盾的端口：ssh 串里是 ${target.port}，port 字段是 ${hop.port}`,
          {
            path: `${path}.port`,
            hint: '留一个就行。写 ssh: user@host:2222 就不要再写 port —— 静默取其中一个会让你连错机器',
          },
        )
      }
    }
  })
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
    '注意：ssh2 **不支持抗量子 KEX**（实测），若 crypto.kexPolicy=pq-required 只能走 native-ssh',
  ].join('；')

  throw new DpError('DP.SSH.DRIVER_UNAVAILABLE', `没有可用的 SSH 驱动，已尝试：\n${detail}`, { hint })
}

/** 默认顺序：native 优先（唯一能抗量子），ssh2 兜底 */
export const DEFAULT_PREFERENCE: readonly SshDriverKind[] = ['native-ssh', 'ssh2']

export type { SshArgvOptions }
