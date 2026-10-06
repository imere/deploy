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

/**
 * 一次远端执行请求 —— 驱动层的唯一输入形状。
 *
 * 为什么不用 ports 的 `ExecOptions`：那一份是**本机语义**（cwd 是本机目录、
 * env 与父进程合并）。远端的 cwd 与 env 都要穿过 sshd 与登录 shell，
 * 同一个字段名会让人以为两端行为一致，而实际一致的那个部分只有 argv。
 */
export interface ExecRequest {
  /** 远端命令的 argv。**不是字符串** —— 注入的面从接口层就掐掉了 */
  readonly argv: readonly string[]
  /** 毫秒。不给由 resolveTimeoutMs 兜底，但**每个子进程都必须有上限** */
  readonly timeoutMs?: number
  /** 远端工作目录。驱动拼进命令，本包不做存在性校验 —— 凭空创建一个「看起来该在」的目录比报错更糟 */
  readonly cwd?: string
  /** 远端额外环境变量。凭据绝不许走这里 */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * 一条到远端的字节流通道，给 rsync / scp / sftp 用。
 *
 * 只暴露 rshArgv 而不暴露「怎么连的」：传输层需要的全部信息就是这个前缀。
 * 把端口转发、跳板这些实现细节漏出去，调用方就会开始依赖它们 ——
 * 而它们在 native 与 ssh2 两条驱动上的形状并不一致（后者还要多一跳 openHopChain）。
 */
export interface Tunnel {
  /** 给 rsync `--rsh` 用的 argv 前缀；见 argv.ts 的 buildRshArgv */
  readonly rshArgv: readonly string[]
  /** 关掉通道。必须幂等：失败路径上 close 往往会被重复调用 */
  close(): Promise<void>
}

/**
 * 一条 SSH 驱动。
 *
 * 能力用 `available()` 表达而不是「构造时抛错」：偏好链要**逐条试**，
 * 构造期抛异常的话，「这一条不可用、下一条可能可用」这件事
 * 就没法在不吞异常的前提下表达出来。
 */
export interface SshDriver {
  /** 身份。只用于日志与偏好链排序，不参与行为分派 */
  readonly kind: SshDriverKind
  /** 这条驱动能不能用（native：ssh 二进制在不在；ssh2：模块能否 require） */
  available(): Promise<DriverAvailability>
  exec(req: ExecRequest): Promise<DriverExecResult>
  /** 为 rsync/scp/sftp 提供一条到远端的通道 */
  openTunnel?(): Promise<Tunnel>
  /** 关掉底层连接。幂等由实现保证 */
  close(): Promise<void>
}

/**
 * 驱动的原始执行结果。**刻意与本机的 `ExecResult` 同形**：
 * 上层（Runner 与它上面的 core）不该因为对面隔着三跳就改判定逻辑。
 */
export interface DriverExecResult {
  /** 退出码。被信号杀掉时沿用 128+信号号，不归一化 */
  readonly code: number
  /** 原始字节流。**截断在驱动层做**，别让调用方各自实现一份上限 */
  readonly stdout: string
  /** 原始 stderr；错误归类（parse.ts）读的是它，不是 message */
  readonly stderr: string
}

// ------------------------------------------------------------
// 连接配置
// ------------------------------------------------------------

/**
 * 主机密钥策略。本包**别名** @dp/ports 的那一份而不是重定义字面量 ——
 * 同一件事有两个枚举集合时，schema 校验与驱动实现迟早各认一半。
 */
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

/**
 * 一跳。**最后一跳是目标机** —— 这条语义必须由本类型背书，
 * 它同时决定「哪些跳进 ProxyJump」与「哪些跳带自己的凭据」，
 * 搞反的两种后果都不报错：连到目标机自己，或在跳板上留下没人管的转发进程。
 */
export interface HopSpec {
  /** `user@host` 或 `user@host:port` */
  readonly ssh: string
  /**
   * 该跳自己的认证。**绝不继承整体认证**：替中间跳补一个，
   * 等于把目标机的钥匙递到跳板机上，那正是跳板机被放在那里的原因。
   */
  readonly auth?: AuthConfig
  /** 该跳的主机密钥策略。与整体不一致时**报错**而不是二选一（见 hopsProxyJump） */
  readonly knownHosts?: KnownHostsMode
  /** 端口。与 `ssh` 串里的端口同时出现且不同 → 报错；都不给则不补 22 */
  readonly port?: number
}

/** 调用方解析完 ref 之后传进来的明文。字段名即脱敏键（@dp/log 按 key 脱敏） */
export interface ResolvedSecrets {
  readonly password?: string
  readonly passphrase?: string
  readonly keyBuffer?: Uint8Array
}

/**
 * 一条连接的**全部**输入。字段与配置里的 `hosts.*.ssh` 一一对应，
 * 但它**不是**那份配置本身：配置文件是给用户写的，这里是给代码用的。
 *
 * 为什么校验在这里再做一遍（`validateHops`、端口区间、knownHosts 枚举）：
 * 本接口可以被绕过 `@dp/schema` 直接构造 —— 探针、测试、多目标扇出都这么干。
 * 只在 schema 层校验的话，那几条路径就完全没有保护，而它们连的同样是生产机器。
 *
 * 凡是「不给」都有明确含义，且**默认都是更保守的那个**：不给端口就不传 `-p`
 * （让 ssh_config 说话），不给 knownHosts 就是 strict，不给 allowedRoots 就
 * 少一层检查而不是放行一切。
 */
export interface SshConnectionOptions {
  /** 纯主机名或 IP，**不含端口、不含 user@**。写全了会在拼 argv 时变成连不上而不是报错 */
  readonly host: string
  /** 1–65535 闭区间。不给就**不传 -p**，让 ssh_config 里的 `Port` 生效 —— 补 22 会盖掉用户配的跳板端口 */
  readonly port?: number
  /** 登录用户。不给则交给 ssh_config 解析（不猜 root：猜错的连接会安静地成功在别的账户下） */
  readonly user?: string
  /** 认证方式。四种的失败含义不同，见 AuthConfig */
  readonly auth: AuthConfig
  /** 引用解析后的明文。只在本包内流转，绝不进 argv / message / 日志字段 */
  readonly secrets?: ResolvedSecrets
  /** 默认 strict —— 需要安全感的人会显式放宽，而不是反过来 */
  readonly knownHosts?: KnownHostsMode
  /** 指定 known_hosts 位置。**只在非 strict 下有意义**：strict 走系统默认，那里有用户自己积累的信任 */
  readonly userKnownHostsFile?: string
  /** tofu 模式的 pin 文件；不填则 argv.defaultPinPath() */
  readonly pinnedHostKeysPath?: string
  /** 钉死一条驱动。给了就跳过偏好链，且它不可用时直接失败而不是降级 */
  readonly driver?: SshDriverKind
  /** 逐个尝试的驱动顺序；不给则 [native-ssh, ssh2] */
  readonly preferred?: readonly SshDriverKind[]
  /** 私钥路径。走 argv 的 `-i`；不存在时报错，不退化成无密钥连接 */
  readonly identityFile?: string
  /** 与 `hops` 互斥：两者都给直接报错（见 buildSshArgv） */
  readonly proxyJump?: string
  /** 原样追加的 ssh 选项。**是注入面**，只接受调用方自己拼好的，不接受用户输入的片段 */
  readonly extraOptions?: readonly string[]
  /** 毫秒。不给则回落 `DP_SSH_TIMEOUT_MS` 环境变量，再不给才是默认值 */
  readonly timeoutMs?: number
  /** 单次执行保留的输出字节上限。不给则回落 `DP_SSH_OUTPUT_MAX_BYTES`，再不给是 1 MiB */
  readonly maxOutputBytes?: number
  /** 多跳链。**最后一跳是目标机**，见 HopSpec */
  readonly hops?: readonly HopSpec[]
  /**
   * 跳板的 direct-tcpip 被拒时，是否允许在跳板上 exec `nc` 兜底。
   *
   * 默认 false。nc 是在**跳板机上起进程**，而链式转发只需要一条字节流 ——
   * 开这个开关等于把「目标能不能到」的决定权交给跳板上装了什么。
   */
  readonly allowNcHopFallback?: boolean
}

/**
 * 30 秒：够跑完一次事实探测的往返（多跳时更久），又短到一台不可达的主机
 * 不会把一次部署挂成"看起来在跑"。**显式给值覆盖它**，但 0 与负数不算覆盖。
 */
export const DEFAULT_SSH_TIMEOUT_MS = 30_000
/** 远端输出上限，防止一条 `cat /dev/zero` 打爆本机内存 */
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

/**
 * 逐跳校验。**不合法就报错，绝不悄悄降级成单跳** —— 静默忽略 hops 会让人以为
 * 流量走了跳板机，实际却直连了目标机（这正是跳板机被放在那里的原因）。
 *
 * 校验内容与配置层一致（连接串、端口区间、knownHosts 枚举），因为 `SshConnectionOptions`
 * 可以绕过 `@dp/schema` 直接构造：探针、测试、多目标扇出都走这条路。
 *
 * @param hops 配置里的跳板链。`undefined` 与空数组等价于「单跳」，两种都直接放过 ——
 *   单跳是绝大多数部署的形态，为它报错等于逼用户写 `hops: []`
 * @throws DpError 逐跳报出具体下标：连接串为空、端口越界、
 *   或 `ssh` 串与 `port` 字段给出两个互相矛盾的端口（静默取其一 = 连错机器）
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

/**
 * 超时的三级回落：显式值 → `DP_SSH_TIMEOUT_MS` 环境变量 → 默认值。
 *
 * 为什么读环境变量而不是只在配置里给：CI 里给所有部署统一切一个更大的超时，
 * 是一行环境变量的事；为它加一个配置项就意味着多一份要校验、要写进 plan 的东西。
 *
 * 非法值（0、负数、非数字）**不算**有效值，直接落回默认：宁可超时短到能失败，
 * 也不要一个「永不超时」的部署 —— 那是挂起，不是部署。
 *
 * @param explicit 调用方给的毫秒数。`undefined` 才触发回落，0 是合法意图之外的值故同非法处理
 * @returns 一个正整数毫秒数，单位与 `ExecOptions.timeoutMs` 一致
 */
export function resolveTimeoutMs(explicit: number | undefined): number {
  if (explicit !== undefined) return explicit
  const env = process.env.DP_SSH_TIMEOUT_MS
  const parsed = env === undefined ? Number.NaN : Number(env)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SSH_TIMEOUT_MS
}

// ------------------------------------------------------------
// 偏好链
// ------------------------------------------------------------

/**
 * 按 kind 造一条驱动。返回工厂而不是实例：偏好链要按顺序造，
 * 而 ssh2 的模块加载可能失败 —— 那时它要**成为一条被记录的失败**，
 * 而不是让整条链在造驱动时就崩掉。
 */
export type DriverFactory = (kind: SshDriverKind) => SshDriver

/**
 * 一次可用性判定。**全部尝试都要留痕**，包括成功的那些之前失败的 ——
 * 用户问「为什么没用 ssh2」时，答案只能从这里来。
 */
export interface DriverAttempt {
  /** 被试的那一条 */
  readonly kind: SshDriverKind
  /** 它的判定。ok 为 false 时 reason/hint 必填（见 DriverAvailability） */
  readonly availability: DriverAvailability
}

/**
 * 按偏好链挑一条可用驱动。
 *
 * 全失败 / 显式指定却不可用 → `DP.SSH.DRIVER_UNAVAILABLE`，**message 里逐项列出
 * 失败原因**。这是本文件唯一允许抛错的地方，别把原因吞掉。
 *
 * @param factory 造驱动用。传进来而不是内部 import，是为了测试能注入假驱动，
 *   也是为了让 ssh2 的「模块没装」在**探测期**表现为不可用而不是构造期异常
 * @param options `explicit` 钉死一条（不可用即失败，不降级）；
 *   `preferred` 给顺序；两者都不给则用 {@link DEFAULT_PREFERENCE}。
 *   显式指定存在时 `preferred` 胜出 —— 调用方给了顺序就说明它知道自己在做什么
 * @returns 选中的驱动与**已试过的全部判定**（含成功的），attempts 供日志与错误消息复用
 * @throws DpError `DP.SSH.DRIVER_UNAVAILABLE`，message 逐项列出失败原因，hint 给出安装/降级出路
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
