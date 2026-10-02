/**
 * 连接工厂 —— 偏好链 + 事实探测 + Runner 组装。
 *
 * 这是 `@dp/ssh` 唯一的"从配置到可用 Runner"的入口。@dp/core **不 import
 * 本文件**：core 只认 `Runner` 接口，具体是本机还是远端由实现包决定
 * （transport.md §1 纪律 3）。
 */
import type { Facts, Runner } from '@dp/ports'
import { DpError } from '@dp/ports'
import { createLogger, type Logger } from '@dp/log'
import type { SshConnectionOptions, SshDriver, SshDriverKind, Tunnel } from './driver.js'
import { assertNoHops, resolveDriver } from './driver.js'
import { NativeSshDriver } from './native.js'
import { Ssh2Driver } from './ssh2.js'
import { createSshRunner } from './runner.js'
import { probeFacts, type ProbeResult } from './probe.js'

function factoryFor(options: SshConnectionOptions): (kind: SshDriverKind) => SshDriver {
  return (kind) => (kind === 'native-ssh' ? new NativeSshDriver(options) : new Ssh2Driver(options))
}

export interface ConnectOptions {
  readonly logger?: Logger
  /** 允许写入的远端根；不给则只做绝对路径 + 平台校验 */
  readonly allowedRoots?: readonly string[]
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /** 复用已有的 Facts（比如 `--facts facts.json` 提供的夹具），跳过探测 */
  readonly facts?: Facts
  /** 复用已有驱动（测试与多目标扇出） */
  readonly driver?: SshDriver
}

export interface ConnectedSsh {
  readonly runner: Runner
  readonly driver: SshDriver
  readonly facts: Facts
  /** 探测说明：哪些没探到、为什么。plan 必须能打印它 */
  readonly probeNotes: readonly string[]
  readonly tunnel: () => Promise<Tunnel>
  close(): Promise<void>
}

/**
 * 连上一台远端机器。
 *
 * 顺序刻意如此：**先过非空 hops 的校验**（挡掉未实现配置的静默误用），再走
 * 偏好链选驱动，最后才探测 —— 探测是有往返成本的，不该为一条注定失败的
 * 连接买单。
 */
export async function connectSsh(
  options: SshConnectionOptions,
  connectOptions: ConnectOptions = {},
): Promise<ConnectedSsh> {
  assertNoHops(options.hops)

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
          hint: 'rsync 需要一条到远端的通道。换用 native-ssh 驱动，或用 transport.strategy: tar-ssh / sftp（transport.md §7）',
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
