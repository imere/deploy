/**
 * ssh2 驱动 —— **纯 JS 降级实现，运行时可选加载**。
 *
 * 为什么排在 native-ssh 之后、以及模块怎么加载（动态 require），理由都在
 * `ssh2-module.ts`：那是 ssh2 这个库自己的形状与加载方式，本文件只负责
 * 「用它做一次 exec」。多跳建链在 ssh2-hops.ts，它与本文件共用那一层，
 * 两边都不再互相 import —— 否则是一条真实的值↔值环。
 */
import { DpError } from '@dp/ports'
import type {
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
import { openHopChain, type HopChainDeps } from './ssh2-hops.js'
import { classifyConnectError, loadSsh2, type Ssh2ClientLike } from './ssh2-module.js'
import { detectPrompt, promptHint } from './prompt.js'
import { truncateOutput } from './parse.js'

// ------------------------------------------------------------
// 驱动
// ------------------------------------------------------------

/**
 * 纯 JS 的 ssh2 驱动，偏好链里的降级项。
 *
 * 它比 native 多两样东西（keyboard-interactive、进程内的 rsync 隧道），
 * 少一样致命的东西：**不支持任何抗量子 KEX**。
 * 所以它是降级不是替代 —— `crypto.kexPolicy=pq-required` 时只能走 native。
 *
 * 构造函数**不做任何 IO**：模块在 `available()` 里才加载。
 * 跟 native 同一个理由 —— 偏好链要能逐条试，构造期抛错会让链走不下去。
 */
export class Ssh2Driver implements SshDriver {
  readonly kind: SshDriverKind = 'ssh2'
  private client: Ssh2ClientLike | undefined

  /** 测试注入点（假 ssh2 模块、逐跳超时、逐跳凭据）。生产不传 */
  constructor(
    private readonly options: SshConnectionOptions,
    private readonly chainDeps: HopChainDeps = {},
  ) {}

  async available(): Promise<DriverAvailability> {
    const load = loadSsh2()
    return load.ok ? { ok: true } : { ok: false, reason: load.reason, hint: load.hint }
  }

  async exec(req: ExecRequest): Promise<DriverExecResult> {
    const timeoutMs = resolveTimeoutMs(req.timeoutMs ?? this.options.timeoutMs)
    // ssh2 的 exec() **只接受一个字符串** —— 所以这里没有任何 ssh 帮我们转义，
    // buildRemoteCommand 的逐参数转义是这条路径上唯一的防线。
    // （native 路径不需要它：argv 独立传给 ssh，由 ssh 自己转义。）
    const command = buildRemoteCommand(req.argv)

    const hops = this.options.hops
    if (hops !== undefined && hops.length > 0) {
      // 一次性连接模型：每次 exec 重建整条链。留着它不关等于在跳板机上攒会话 ——
      // 用户结束 dp 之后那些会话还能继续跑命令
      const chain = await openHopChain(hops, this.options, {
        ...this.chainDeps,
        allowNc: this.options.allowNcHopFallback === true,
      })
      try {
        return await this.runExec(chain.leaf, command, req, timeoutMs)
      } finally {
        await chain.close()
      }
    }

    const load = loadSsh2()
    if (!load.ok) {
      throw new DpError('DP.SSH.DRIVER_UNAVAILABLE', `ssh2 驱动不可用：${load.reason}`, { hint: load.hint })
    }
    return this.runExec(await this.connect(), command, req, timeoutMs)
  }

  private runExec(
    client: Ssh2ClientLike,
    command: string,
    req: ExecRequest,
    timeoutMs: number,
  ): Promise<DriverExecResult> {
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
   * ssh2 隧道。多跳与单跳**都未实现**，两者的差别只在用户要做什么，所以分开说：
   * 多跳报错指向"换 native-ssh"（它的 ProxyJump 已逐跳建好通道），单跳报错
   * 指向"换传输形态"。
   */
  async openTunnel(): Promise<Tunnel> {
    const hops = this.options.hops
    if (hops !== undefined && hops.length > 0) {
      throw new DpError('DP.SSH.TUNNEL_FAILED', `多跳隧道未实现（收到 ${hops.length} 跳）`, {
        path: 'hosts.*.ssh.hops',
        hint:
          '多跳 + rsync 请用 native-ssh 驱动：它的 -o ProxyJump= 已经逐跳建好通道，--rsh 直接可用。' +
          'ssh2 侧的 exec 多跳已支持，但 rsync 隧道要一条常驻的父子 IPC 端点，与"每次 exec 一次性连接"不合 —— 所以这里明确失败而不是给一条走不通的通道',
      })
    }
    throw new DpError('DP.SSH.TUNNEL_FAILED', 'ssh2 隧道未实现', {
      hint: '请用 native-ssh 驱动 —— 它的 --rsh 前缀可以直接给 rsync（契约）。ssh2 侧的 rsync 隧道方案已实测可行，只差 IPC 助手',
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

/**
 * 偏好链的工厂。**函数而不是 class 导出**：模块在 `available()` 里才按需加载，
 * 让没装 ssh2 的机器在 import 阶段就炸掉是本末倒置。
 *
 * @param options 连接配置
 * @returns 一条**尚未校验可用性**的驱动；能不能用要问它的 `available()`
 */
export function createSsh2Driver(options: SshConnectionOptions): SshDriver {
  return new Ssh2Driver(options)
}
