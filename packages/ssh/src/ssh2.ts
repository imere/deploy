/**
 * ssh2 驱动 —— **纯 JS 降级实现，运行时可选加载**。
 *
 * 为什么排在 native-ssh 之后（实测，最硬的约束）：
 *   传入 `mlkem768x25519-sha256` → ssh2 直接抛 `Unsupported algorithm`，
 *   且它的 SUPPORTED_KEX 列表里**没有任何** PQ 算法。所以「抗量子」这条路
 *   ssh2 走不通，只能靠系统 ssh（实测本机 OpenSSH 10.3 默认
 *   就协商出 mlkem768x25519-sha256）。若 `crypto.kexPolicy: pq-required`，
 *   这条驱动**根本不该被选中**。
 *
 * 为什么**动态 require** 而不是静态 `import 'ssh2'`：
 *  1. ssh2 是可选运行时依赖，硬依赖会让"只用 native"的用户也装它
 *  2. 我们没有 @types/ssh2，静态 import 会直接 TS2307 编译失败
 *  3. 动态加载失败是一个**可汇报的状态**（`DP.SSH.DRIVER_UNAVAILABLE` 里
 *     逐项列出原因），静态 import 失败是**崩溃**
 *
 * 所以这里只声明**我们真正用到的那几个方法**的最小接口，用 `unknown` +
 * 收窄，不让 `any` 蔓延（ssh2 的类型是手写的 ours，不是我们能信的）。
 */
import { createRequire } from 'node:module'
import { DpError } from '@dp/ports'
import type {
  AuthConfig,
  DriverAvailability,
  DriverExecResult,
  ExecRequest,
  ResolvedSecrets,
  SshConnectionOptions,
  SshDriver,
  SshDriverKind,
  Tunnel,
} from './driver.js'
import { resolveTimeoutMs } from './driver.js'
import { buildRemoteCommand } from './argv.js'
import { detectPrompt, promptHint } from './prompt.js'
import { truncateOutput } from './parse.js'

// ------------------------------------------------------------
// 最小接口声明（不是 ssh2 的完整类型，是我们用到的部分）
// ------------------------------------------------------------

export interface Ssh2ChannelLike {
  on(event: string, handler: (...args: readonly unknown[]) => void): unknown
  stderr?: { on(event: string, handler: (...args: readonly unknown[]) => void): unknown }
  close?(): void
}

export interface Ssh2SftpLike {
  on(event: string, handler: (...args: readonly unknown[]) => void): unknown
}

export interface Ssh2ClientLike {
  on(event: string, handler: (...args: readonly unknown[]) => void): unknown
  connect(config: Readonly<Record<string, unknown>>): void
  exec(
    command: string,
    options: Readonly<Record<string, unknown>>,
    callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void,
  ): void
  sftp(callback: (err: Error | undefined, sftp: Ssh2SftpLike) => void): void
  forwardOut(
    srcHost: string,
    srcPort: number,
    dstHost: string,
    dstPort: number,
    callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void,
  ): void
  end(): void
}

export interface Ssh2ModuleLike {
  Client: new () => Ssh2ClientLike
}

export type Ssh2Load =
  | { readonly ok: true; readonly mod: Ssh2ModuleLike }
  | { readonly ok: false; readonly reason: string; readonly hint: string }

let cached: Ssh2Load | undefined

/**
 * 可选加载 ssh2。
 *
 * 失败**不是**异常 —— 它是一个正常的"这条驱动不可用"状态，要进偏好链的
 * 失败原因列表里（错误要能指导下一步）。
 */
export function loadSsh2(force = false): Ssh2Load {
  if (cached !== undefined && !force) return cached
  try {
    const require = createRequire(import.meta.url)
    const mod: unknown = require('ssh2')
    cached = narrowModule(mod)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    const reason =
      code === 'MODULE_NOT_FOUND' ? 'ssh2 未安装' : `加载 ssh2 失败：${(err as Error).message}`
    cached = {
      ok: false,
      reason,
      hint: '它是可选运行时依赖：`pnpm add -D ssh2`。但注意 ssh2 **不支持任何抗量子 KEX**（实测），若 crypto.kexPolicy=pq-required 只能走 native-ssh',
    }
  }
  return cached
}

/** 把 `unknown` 收窄成我们需要的最小形状；形状不对也算"不可用"而不是崩 */
function narrowModule(mod: unknown): Ssh2Load {
  if (typeof mod !== 'object' || mod === null) {
    return { ok: false, reason: 'ssh2 模块形状异常（不是对象）', hint: '检查 ssh2 是否被别的同名包顶替了' }
  }
  const client = (mod as { Client?: unknown }).Client
  if (typeof client !== 'function') {
    return {
      ok: false,
      reason: 'ssh2 模块缺少 Client 构造器（不是预期的 ssh2 包）',
      hint: '检查 ssh2 是否被别的同名包顶替了',
    }
  }
  const proto = client.prototype as Partial<Ssh2ClientLike> | undefined
  for (const method of ['connect', 'exec', 'end'] as const) {
    if (typeof proto?.[method] !== 'function') {
      return { ok: false, reason: `ssh2.Client 缺少 ${method}()`, hint: '版本与预期不符，换一个 ssh2 版本' }
    }
  }
  return { ok: true, mod: { Client: client as new () => Ssh2ClientLike } }
}

// ------------------------------------------------------------
// 驱动
// ------------------------------------------------------------

export class Ssh2Driver implements SshDriver {
  readonly kind: SshDriverKind = 'ssh2'
  private client: Ssh2ClientLike | undefined

  constructor(private readonly options: SshConnectionOptions) {}

  async available(): Promise<DriverAvailability> {
    const load = loadSsh2()
    return load.ok ? { ok: true } : { ok: false, reason: load.reason, hint: load.hint }
  }

  async exec(req: ExecRequest): Promise<DriverExecResult> {
    const load = loadSsh2()
    if (!load.ok) {
      throw new DpError('DP.SSH.DRIVER_UNAVAILABLE', `ssh2 驱动不可用：${load.reason}`, { hint: load.hint })
    }
    const timeoutMs = resolveTimeoutMs(req.timeoutMs ?? this.options.timeoutMs)
    const client = await this.connect()
    // ssh2 的 exec() **只接受一个字符串** —— 所以这里没有任何 ssh 帮我们转义，
    // buildRemoteCommand 的逐参数转义是这条路径上唯一的防线。
    // （native 路径不需要它：argv 独立传给 ssh，由 ssh 自己转义。）
    const command = buildRemoteCommand(req.argv)

    return new Promise<DriverExecResult>((resolve, reject) => {
      let settled = false
      const out: Buffer[] = []
      const err: Buffer[] = []
      let promptHit: ReturnType<typeof detectPrompt> = undefined

      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      const timer = setTimeout(() => {
        client.end()
        done(() =>
          reject(
            new DpError('DP.TIMEOUT.EXEC', `ssh2 执行超时 ${timeoutMs}ms`, {
              hint: '增大 timeout，或检查远端是否在等待输入',
            }),
          ),
        )
      }, timeoutMs)

      client.exec(command, { pty: false, ...(req.env === undefined ? {} : { env: { ...req.env } }) }, (_err, channel) => {
        channel.on('data', (chunk: unknown) => {
          const buf = toBuffer(chunk)
          out.push(buf)
          const hit = detectPrompt(buf.toString('utf8'))
          if (hit !== undefined && promptHit === undefined) {
            promptHit = hit
            // 立刻断链，而不是等它回完 —— 挂着等输入是最糟的结局
            client.end()
            done(() =>
              reject(
                new DpError('DP.INTERACTIVE_PROMPT_DETECTED', `检测到交互式提示（${hit.kind}）：${hit.line}`, {
                  hint: promptHint(hit.kind),
                }),
              ),
            )
          }
        })
        channel.stderr?.on('data', (chunk: unknown) => {
          const buf = toBuffer(chunk)
          err.push(buf)
          const hit = detectPrompt(buf.toString('utf8'))
          if (hit !== undefined && promptHit === undefined) {
            promptHit = hit
            client.end()
            done(() =>
              reject(
                new DpError('DP.INTERACTIVE_PROMPT_DETECTED', `检测到交互式提示（${hit.kind}）：${hit.line}`, {
                  hint: promptHint(hit.kind),
                }),
              ),
            )
          }
        })
        channel.on('close', (code: unknown) => {
          const max = this.options.maxOutputBytes
          done(() =>
            resolve({
              code: typeof code === 'number' ? code : -1,
              stdout: max === undefined ? joinBufs(out) : truncateOutput(joinBufs(out), max),
              stderr: max === undefined ? joinBufs(err) : truncateOutput(joinBufs(err), max),
            }),
          )
        })
      })
    })
  }

  /**
   * ssh2 隧道。**本批未实现**，显式说明而不是留空 ——
   *已实测「rsync over 自建 ssh2 隧道完全可用」，方案是存在的
   * （起一个 loopback TCP + 一个 stdin/stdout 直通的 `dp-rsh.mjs` 助手），
   * 但它需要一个常驻的父子 IPC 端点，与本批的"每次 exec 一次性连接"模型
   * 不合。留到下一批。
   */
  async openTunnel(): Promise<Tunnel> {
    throw new DpError('DP.SSH.TUNNEL_FAILED', 'ssh2 隧道将在下一批实现', {
      hint: '本批请用 native-ssh 驱动 —— 它的 --rsh 前缀可以直接给 rsync（契约）。ssh2 侧的 rsync 隧道方案已实测可行，只差 IPC 助手',
    })
  }

  async close(): Promise<void> {
    this.client?.end()
    this.client = undefined
  }

  // ------------------------------------------------------------

  private connect(): Promise<Ssh2ClientLike> {
    if (this.client !== undefined) return Promise.resolve(this.client)
    const load = loadSsh2()
    if (!load.ok) {
      return Promise.reject(new DpError('DP.SSH.DRIVER_UNAVAILABLE', load.reason, { hint: load.hint }))
    }

    return new Promise<Ssh2ClientLike>((resolve, reject) => {
      const client = new load.mod.Client()
      let settled = false
      const timeoutMs = resolveTimeoutMs(this.options.timeoutMs)

      const timer = setTimeout(() => {
        client.end()
        reject(
          new DpError('DP.SSH.CONNECT_FAILED', `ssh2 连接超时 ${timeoutMs}ms`, {
            hint: '检查主机/端口可达性，或调大 timeouts.connectMs',
          }),
        )
      }, timeoutMs)

      client.on('ready', () => {
        clearTimeout(timer)
        settled = true
        this.client = client
        resolve(client)
      })
      client.on('error', (err: unknown) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        const message = err instanceof Error ? err.message : String(err)
        reject(classifyConnectError(message, this.options.auth))
      })

      client.connect(this.connectConfig())
    })
  }

  /**
   * 认证配置。**只声明我们用到的键**。
   *
   * 注意：ssh2 支持 password 与 keyboard-interactive 直接在协议里发密码，
   * 这是它比"无 sshpass 的系统 ssh"方便的地方。
   * 但密码仍然**不**进 argv / 环境变量 / 临时文件 —— 它只出现在这条内存对象里。
   */
  private connectConfig(): Record<string, unknown> {
    const opts = this.options
    const secrets: ResolvedSecrets = opts.secrets ?? {}
    const base: Record<string, unknown> = {
      host: opts.host,
      port: opts.port ?? 22,
      username: opts.user,
      // 默认永远不要 agent forwarding
      agentForward: false,
      readyTimeout: resolveTimeoutMs(opts.timeoutMs),
    }

    const identity = opts.identityFile ?? (opts.auth.type === 'key' ? opts.auth.identityFile : undefined)
    if (identity !== undefined) base.privateKey = identity
    if (secrets.keyBuffer !== undefined) base.privateKey = Buffer.from(secrets.keyBuffer)
    if (secrets.passphrase !== undefined) base.passphrase = secrets.passphrase
    if (secrets.password !== undefined) base.password = secrets.password
    if (opts.auth.type === 'keyboard-interactive' && secrets.password !== undefined) {
      base.tryKeyboard = true
    }
    return base
  }
}

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk)
  if (typeof chunk === 'string') return Buffer.from(chunk, 'utf8')
  return Buffer.alloc(0)
}

const joinBufs = (list: readonly Buffer[]): string => Buffer.concat(list).toString('utf8')

/** ssh2 的错误文案 → 结构化。**绝不带上 password 字段的值** */
export function classifyConnectError(message: string, auth: AuthConfig): DpError {
  const kind = auth.type
  if (/All configured authentication methods failed/i.test(message)) {
    return new DpError('DP.SSH.AUTH_FAILED', `认证失败（配置了 ${kind}）`, {
      hint: authHint(kind),
    })
  }
  if (/Handshake failed|no matching (key exchange|cipher|mac|host key)/i.test(message)) {
    return new DpError('DP.SSH.CONNECT_FAILED', `握手失败：${message.slice(0, 200)}`, {
      hint: '确认目标 sshd 支持的算法；若目标是老设备，crypto 侧可能要放宽（ssh2 不支持任何 PQ KEX）',
    })
  }
  return new DpError('DP.SSH.CONNECT_FAILED', message.slice(0, 300), {
    hint: '检查主机/端口可达性、sshd 是否在跑、网络策略',
  })
}

function authHint(kind: AuthConfig['type']): string {
  switch (kind) {
    case 'key':
      return '私钥权限太开会被 ssh 拒绝：chmod 600 ~/.ssh/id_ed25519；或确认公钥已进目标机的 authorized_keys'
    case 'agent':
      return 'agent 里没有可用身份：先 ssh-add <key>，用 ssh-add -l 确认'
    case 'password':
      return '确认密码正确；确认目标 sshd 允许密码认证（PasswordAuthentication）。注意：连续失败可能触发账户锁定，不要反复重试'
    case 'keyboard-interactive':
      return '很多设备表面是密码、实际只接受键盘交互。确认目标端的 PAM 栈与密码一致'
  }
}

export function createSsh2Driver(options: SshConnectionOptions): SshDriver {
  return new Ssh2Driver(options)
}
