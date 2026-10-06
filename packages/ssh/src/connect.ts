/**
 * 连接工厂 —— 偏好链 + 事实探测 + Runner 组装。
 *
 * 这是 `@dp/ssh` 唯一的"从配置到可用 Runner"的入口。@dp/core **不 import
 * 本文件**：core 只认 `Runner` 接口，具体是本机还是远端由实现包决定。
 */
import type { Facts, Runner } from '@dp/ports'
import { DpError } from '@dp/ports'
import { createLogger, type Logger } from '@dp/log'
import type { SshConnectionOptions, SshDriver, SshDriverKind, Tunnel } from './driver.js'
import { resolveDriver, validateHops } from './driver.js'
import { NativeSshDriver } from './native.js'
import { Ssh2Driver } from './ssh2.js'
import { createSshRunner } from './runner.js'
import { probeFacts, type ProbeResult } from './probe.js'

function factoryFor(options: SshConnectionOptions): (kind: SshDriverKind) => SshDriver {
  return (kind) => (kind === 'native-ssh' ? new NativeSshDriver(options) : new Ssh2Driver(options))
}

/**
 * 连接的**调用侧**选项。与 `SshConnectionOptions` 分开是因为两者来源不同：
 * 那是配置里写的「连哪台、用什么认证」，这是进程里定的「怎么用这次连接」。
 *
 * 全部可选是有意的：CLI 只传它真正关心的，测试则几乎全靠注入
 * （driver + facts）来避免每条用例都去连真机器。
 */
export interface ConnectOptions {
  readonly logger?: Logger
  /** 允许写入的远端根；不给则只做绝对路径 + 平台校验 */
  readonly allowedRoots?: readonly string[]
  /** 毫秒。给 `undefined` 时按 `options.timeoutMs` → 环境变量 → 默认值 逐级回落 */
  readonly timeoutMs?: number
  /** 单次执行保留的输出字节上限；给 `undefined` 时同上 */
  readonly maxOutputBytes?: number
  /**
   * 复用已有的 Facts（比如 `--facts facts.json` 提供的夹具），跳过探测。
   *
   * 给了就**一次远端往返都不发生** —— 这是它存在的意义，也是它危险的地方：
   * 复用一份与当前机器不符的 facts，路径校验会全部按错误的平台与能力跑。
   */
  readonly facts?: Facts
  /** 复用已有驱动（测试与多目标扇出）。给了则偏好链与 `options.driver` 都不参与选型 */
  readonly driver?: SshDriver
}

/**
 * 一次已建立的连接。**不是 Runner**：它同时交出驱动与隧道，
 * 而 Runner 只承诺文件系统与 exec —— rsync 那条路必须绕过 Runner，
 * 它的通道语义属于驱动而不属于文件操作。
 */
export interface ConnectedSsh {
  /** 已装配好的 Runner；路径校验、退出码映射、超时都在里面 */
  readonly runner: Runner
  /** 被选中的那条驱动。rsync 隧道与日志里的驱动名都取自它 */
  readonly driver: SshDriver
  /** 探测结果（或调用方注入的那份）。它是 plan() 的唯一外部输入 */
  readonly facts: Facts
  /** 探测说明：哪些没探到、为什么。plan 必须能打印它 */
  readonly probeNotes: readonly string[]
  /** 取到传输通道。驱动没实现时 reject 而不是返回空通道 */
  tunnel: () => Promise<Tunnel>
  /** 关掉连接。幂等由驱动保证 */
  close(): Promise<void>
}

/**
 * 连上一台远端机器。
 *
 * 顺序刻意如此：**先过非空 hops 的校验**（不合法的链在碰网络之前就报错，而不是
 * 连到一半才失败），再走偏好链选驱动，最后才探测 —— 探测是有往返成本的，不该
 * 为一条注定失败的连接买单。
 *
 * @param options 连哪台、用什么认证。凭据只以 ref 形式出现，明文要调用方先解析进 secrets
 * @param connectOptions 见 {@link ConnectOptions}。全空等价于「按默认值真连一次并探测」
 * @returns 已建立的连接；**不会**替你关闭它，用完必须 `close()`
 * @throws DpError hops 不合法（`DP.CONFIG.INVALID`）、无可用驱动
 *   （`DP.SSH.DRIVER_UNAVAILABLE`，message 里逐项列出失败原因）、
 *   以及探测阶段驱动抛出的连接/认证类错误
 */
export async function connectSsh(
  options: SshConnectionOptions,
  connectOptions: ConnectOptions = {},
): Promise<ConnectedSsh> {
  validateHops(options.hops)

  const logger = connectOptions.logger ?? createLogger({ bind: { component: '@dp/ssh' } })

  if (options.knownHosts === 'off') {
    logger.warn('ssh.known_hosts_off', {
      host: options.host,
      consequence: '本次会话不校验主机密钥，中间人可以完整读写这条连接',
      remedy: '改用 strict / accept-new / tofu',
    })
  }

  let driver: SshDriver
  if (connectOptions.driver !== undefined) {
    driver = connectOptions.driver
  } else {
    const resolved = await resolveDriver(factoryFor(options), {
      preferred: options.preferred,
      explicit: options.driver,
    })
    driver = resolved.driver
    logger.debug('ssh.driver_selected', {
      host: options.host,
      driver: driver.kind,
      attempts: resolved.attempts.map((a) => `${a.kind}:${a.availability.reason ?? 'ok'}`),
    })
  }

  const probed: ProbeResult | undefined =
    connectOptions.facts === undefined
      ? await probeFactsWithNotes(driver, options, connectOptions)
      : undefined
  const facts: Facts = connectOptions.facts ?? probed!.facts
  const probeNotes: readonly string[] = probed?.probeNotes ?? []

  const runner = createSshRunner({
    driver,
    facts,
    timeoutMs: connectOptions.timeoutMs ?? options.timeoutMs,
    maxOutputBytes: connectOptions.maxOutputBytes ?? options.maxOutputBytes,
    allowedRoots: connectOptions.allowedRoots,
  })

  return {
    runner,
    driver,
    facts,
    probeNotes,
    tunnel: async () => {
      if (driver.openTunnel === undefined) {
        throw new DpError('DP.SSH.TUNNEL_FAILED', `${driver.kind} 驱动没有实现 openTunnel`, {
          hint: 'rsync 需要一条到远端的通道。换用 native-ssh 驱动，或用 transport.strategy: tar-ssh / sftp',
        })
      }
      return driver.openTunnel()
    },
    close: async () => {
      await driver.close()
    },
  }
}

/** 探测一次并把 notes 一起带出来 */
async function probeFactsWithNotes(
  driver: SshDriver,
  options: SshConnectionOptions,
  connectOptions: ConnectOptions,
): Promise<ProbeResult> {
  return probeFacts(driver, {
    host: options.host,
    timeoutMs: connectOptions.timeoutMs ?? options.timeoutMs,
  })
}
