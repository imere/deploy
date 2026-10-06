/**
 * ssh2 侧的链式转发 —— 多跳真正落地的地方。
 *
 * 形状：第 0 跳直连，之后每一跳的 TCP 流都由**前一跳开出的 direct-tcpip
 * 通道**承载，并把那个通道当 `sock` 交给新的 Client。ssh2 的 Channel 是
 * Duplex，能直接当 socket 用 —— 不经过本机任何 TCP 端口，于是端口冲突、
 * 监听地址暴露、别的进程抢端口这三类问题一个都不存在。
 *
 * 为什么 nc 只在**运行期**兜底：跳板禁 TCP 转发是常见加固手段，而"能不能开
 * direct-tcpip"只有真发一次才知道（AllowTcpForwarding no 的机器上 forwardOut
 * 直接失败）。计划阶段就选 nc 等于猜，所以 planHopChain 只产出
 * direct/forwardOut。nc 自己也不是万能（很多镜像连 nc 都没有），所以两次都
 * 失败时报错必须把**两次各自的原因**都列出来 —— 只报一个"连不上"会让人
 * 去查错方向。
 */
import { DpError } from '@dp/ports'
import type { HopSpec, ResolvedSecrets, SshConnectionOptions } from './driver.js'
import { resolveTimeoutMs } from './driver.js'
import { planHopChain, type HopChainStep } from './hop-chain.js'
import { buildRemoteCommand } from './argv.js'
import { classifyConnectError, loadSsh2, type Ssh2ChannelLike, type Ssh2ClientLike, type Ssh2Load } from './ssh2-module.js'

export interface HopChainHandle {
  /** 建好的 client，按跳序。close 必须逆序 */
  readonly clients: readonly Ssh2ClientLike[]
  /** 最后一跳 —— 远端命令在它上面 exec */
  readonly leaf: Ssh2ClientLike
  close(): Promise<void>
}

export interface HopChainDeps {
  /** ssh2 模块的加载方式。测试从这里注入假模块，生产走 loadSsh2 的缓存 */
  readonly load?: () => Ssh2Load
  /** 每一跳的连接超时；不给则取 opts.timeoutMs（再不给才读环境变量） */
  readonly timeoutMs?: number
  /** 允许 direct-tcpip 失败后用 exec('nc ...') 兜底 */
  readonly allowNc?: boolean
  /** 逐跳明文凭据，索引与 hops 对齐。跳板的密码与目标机通常不是同一个 */
  readonly hopSecrets?: readonly (ResolvedSecrets | undefined)[]
}

interface ForwardAttempt {
  readonly via: 'forwardOut' | 'nc'
  readonly ok: boolean
  readonly reason?: string
}

export async function openHopChain(
  hops: readonly HopSpec[],
  opts: SshConnectionOptions,
  deps: HopChainDeps = {},
): Promise<HopChainHandle> {
  // 计划先跑：连接串、端口矛盾、缺 auth 都在碰网络之前判定完
  const plan = planHopChain(hops)
  const load = (deps.load ?? (() => loadSsh2()))()
  if (!load.ok) {
    throw new DpError('DP.SSH.DRIVER_UNAVAILABLE', `ssh2 驱动不可用：${load.reason}`, { hint: load.hint })
  }

  const connectMs = deps.timeoutMs ?? resolveTimeoutMs(opts.timeoutMs)
  const clients: Ssh2ClientLike[] = []

  try {
    for (const step of plan) {
      let sock: Ssh2ChannelLike | undefined
      if (step.via !== 'direct') {
        // 前一跳必然已建好（plan 按跳序展开），这一支只是把「不可能」写成可读的错误
        const prev = clients[step.index - 1]
        if (prev === undefined) {
          throw new DpError('DP.SSH.HOP_FAILED', `第 ${step.index - 1} 跳没有建好，无法继续建第 ${step.index} 跳`, {
            path: `hosts.*.ssh.hops[${step.index}]`,
            hint: '这是内部顺序错误：链必须按跳序建立，且前一跳失败时整条链都要关掉',
          })
        }
        sock = await openChannel(prev, step, {
          allowNc: deps.allowNc === true,
          timeoutMs: connectMs,
        })
      }
      // hops 的最后一条就是目标机，它认 opts 上的凭据；中间那些跳各用各的
      const secrets = step.index === plan.length - 1 ? opts.secrets : deps.hopSecrets?.[step.index]
      clients.push(await connectOne(load.mod.Client, step, sock, { timeoutMs: connectMs, secrets }))
    }
  } catch (err) {
    // 半条链是最糟的状态：跳板上留着还开着的会话，而用户完全看不见。
    // 逆序关（先内层后外层），关不掉也继续关完再抛原来的错 ——
    // 补偿失败不许吞掉原错误，否则「第 3 跳超时」会被「关连接时报错」顶掉。
    await closeAll(clients)
    throw err
  }

  return makeHandle(clients)
}

// ------------------------------------------------------------

function makeHandle(clients: readonly Ssh2ClientLike[]): HopChainHandle {
  // planHopChain 拒了 0 跳，所以这里一定有末跳
  const leaf = clients[clients.length - 1]!
  let closed = false
  return {
    clients,
    leaf,
    close: async () => {
      // 幂等：exec 的超时分支与 finally 都会调它，重复调不该报错
      if (closed) return
      closed = true
      await closeAll(clients)
    },
  }
}

async function closeAll(clients: readonly Ssh2ClientLike[]): Promise<void> {
  for (let i = clients.length - 1; i >= 0; i--) {
    try {
      clients[i]!.end()
    } catch {
      // 断不开的那一跳在链上已经废了，继续关剩下的比停下来更有用
    }
  }
}

const describe = (step: HopChainStep): string =>
  step.user === undefined ? step.host : `${step.user}@${step.host}${step.port === undefined ? '' : `:${step.port}`}`

/** 每一跳的 connect 配置。凭据逐跳独立，绝不向下继承 */
function hopConnectConfig(
  step: HopChainStep,
  sock: Ssh2ChannelLike | undefined,
  timeoutMs: number,
): Record<string, unknown> {
  return {
    // sock 优先：给了它 host/port 就是摆设（那两键只服务于本机直连那一跳）
    ...(sock === undefined ? { host: step.host, port: step.port ?? 22 } : { sock }),
    ...(step.user === undefined ? {} : { username: step.user }),
    // 永远不要 agent forwarding：那是把钥匙交给中间机器
    agentForward: false,
    readyTimeout: timeoutMs,
  }
}

/** 明文只出现在这个内存对象里，不进 argv / 环境变量 / 临时文件 / 错误消息 */
function applySecrets(
  cfg: Record<string, unknown>,
  auth: HopChainStep['auth'],
  secrets: ResolvedSecrets | undefined,
): void {
  if (auth.type === 'key' && auth.identityFile !== undefined) cfg.privateKey = auth.identityFile
  if (secrets === undefined) return
  if (secrets.keyBuffer !== undefined) cfg.privateKey = Buffer.from(secrets.keyBuffer)
  if (secrets.passphrase !== undefined) cfg.passphrase = secrets.passphrase
  if (secrets.password !== undefined) {
    cfg.password = secrets.password
    if (auth.type === 'keyboard-interactive') cfg.tryKeyboard = true
  }
}

function connectOne(
  Client: new () => Ssh2ClientLike,
  step: HopChainStep,
  sock: Ssh2ChannelLike | undefined,
  ctx: { readonly timeoutMs: number; readonly secrets: ResolvedSecrets | undefined },
): Promise<Ssh2ClientLike> {
  return new Promise<Ssh2ClientLike>((resolve, reject) => {
    const client = new Client()
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      client.end()
      finish(() =>
        reject(
          new DpError('DP.SSH.HOP_FAILED', `第 ${step.index} 跳连接超时 ${ctx.timeoutMs}ms（${describe(step)}）`, {
            path: `hosts.*.ssh.hops[${step.index}]`,
            hint: hopHint(step),
          }),
        ),
      )
    }, ctx.timeoutMs)

    client.on('ready', () => finish(() => resolve(client)))
    client.on('error', (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      const classified = classifyConnectError(message, step.auth)
      // 认证失败保留原码：用户据此改凭据；其余归到 HOP_FAILED 并带跳序
      if (classified.code === 'DP.SSH.AUTH_FAILED') {
        finish(() => reject(classified))
        return
      }
      finish(() =>
        reject(
          new DpError('DP.SSH.HOP_FAILED', `第 ${step.index} 跳连接失败（${describe(step)}）：${classified.message}`, {
            path: `hosts.*.ssh.hops[${step.index}]`,
            hint: hopHint(step),
            cause: classified,
          }),
        ),
      )
    })

    const cfg = hopConnectConfig(step, sock, ctx.timeoutMs)
    applySecrets(cfg, step.auth, ctx.secrets)
    client.connect(cfg)
  })
}

function hopHint(step: HopChainStep): string {
  if (step.index === 0) {
    return '这是本机直连的那一跳：检查 host/port 可达性与这一跳自己的凭据（auth 由 hops 逐跳给出，不继承任何东西）'
  }
  return (
    `第 ${step.index} 跳是通过第 ${step.index - 1} 跳的通道进来的。` +
    '先确认前一跳能到这台机器（ssh -W <host:port> <上一跳> 手工试一次最直接），再确认这一跳自己的凭据；' +
    '链的强度等于最弱的一段，中间跳板老就会让整条链不抗量子'
  )
}

/**
 * 从前一跳拿一条通向 `step` 的字节流。
 *
 * srcPort 必须是 0：direct-tcpip 的源地址只给服务端记账，填一个本机没监听的
 * 端口会让一部分 sshd 直接拒掉这条请求。
 */
function openChannel(
  prev: Ssh2ClientLike,
  step: HopChainStep,
  ctx: { readonly allowNc: boolean; readonly timeoutMs: number },
): Promise<Ssh2ChannelLike> {
  const path = `hosts.*.ssh.hops[${step.index}]`
  const dstHost = step.host
  const dstPort = step.port ?? 22

  return new Promise<Ssh2ChannelLike>((resolve, reject) => {
    const attempts: ForwardAttempt[] = []
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      finish(() =>
        reject(
          hopForwardError(step, path, attempts, `第 ${step.index} 跳建通道超时 ${ctx.timeoutMs}ms`),
        ),
      )
    }, ctx.timeoutMs)

    const failAll = (summary: string): void => {
      finish(() => reject(hopForwardError(step, path, attempts, summary)))
    }

    prev.forwardOut('127.0.0.1', 0, dstHost, dstPort, (err, channel) => {
      if (err === undefined) {
        attempts.push({ via: 'forwardOut', ok: true })
        finish(() => resolve(channel))
        return
      }
      attempts.push({ via: 'forwardOut', ok: false, reason: err.message })
      if (!ctx.allowNc) {
        failAll(`第 ${step.index} 跳没能连到 ${describe(step)}`)
        return
      }
      // -q0：stdin 一关就退出。不给这个参数，nc 会在目标侧先挂起，
      // 于是这条通道永远不 EOF，下一跳的握手被推迟到超时才暴露
      const command = buildRemoteCommand(['nc', '-q0', dstHost, String(dstPort)])
      prev.exec(command, { pty: false }, (ncErr, ncChannel) => {
        if (ncErr !== undefined) {
          attempts.push({ via: 'nc', ok: false, reason: ncErr.message })
          failAll(`第 ${step.index} 跳没能连到 ${describe(step)}`)
          return
        }
        attempts.push({ via: 'nc', ok: true })
        finish(() => resolve(ncChannel))
      })
    })
  })
}

function hopForwardError(
  step: HopChainStep,
  path: string,
  attempts: readonly ForwardAttempt[],
  summary: string,
): DpError {
  const tried =
    attempts.length === 0
      ? '  · （一次都没发出去）'
      : attempts.map((a) => `  · ${a.via}：${a.ok ? '已建立' : a.reason ?? '失败'}`).join('\n')
  return new DpError('DP.SSH.HOP_FAILED', `${summary}。已尝试：\n${tried}`, {
    path,
    hint:
      '几种常见原因：跳板禁了 TCP 转发（sshd_config 的 AllowTcpForwarding no，需要管理员开）、' +
      '前一跳到这台机器的路由不通、或跳板上没有 nc。ssh -W <host:port> <上一跳> 手工试一次最快',
  })
}
