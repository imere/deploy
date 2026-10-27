import { ERR, DpError, type Facts } from '@dp/ports'
import { createLogger, type Logger } from '@dp/log'
import { hostTarget, type KnownHostsMode, type SshAuthKind } from '@dp/ssh'
import { chooseTransport } from './availability.js'
import { copyLocal } from './local-copy.js'
import { buildRsyncPlan, runRsyncPlan } from './rsync.js'
import { buildScpPlan, runScpPlan } from './scp.js'
import { buildSftpPlan, runSftp } from './sftp.js'
import { buildTarArgv, runTarSsh } from './tar-ssh.js'
import type { RshOptions } from './rsh.js'
import type * as T from './types.js'

type TransferDeps = T.TransportDeps
type TransportDeps = T.TransportDeps
type TransferRequest = T.TransferRequest
type TransferResult = T.TransferResult
type TransportChoice = T.TransportChoice

export * from './types.js'
export { chooseTransport, DEFAULT_PREFERENCE } from './availability.js'
export {
  buildRshArgv,
  rshValueForRsync,
  DEFAULT_CONNECT_TIMEOUT_SEC,
  type HopMode,
  type RshOptions,
} from './rsh.js'
export {
  buildRsyncPlan,
  buildRsyncPath,
  classifyRsyncExit,
  parseRsyncOutput,
  runRsyncPlan,
  type RsyncArgvOptions,
  type RsyncPlan,
  type RsyncStats,
} from './rsync.js'
export { buildScpPlan, runScpPlan, type ScpArgvOptions, type ScpPlan } from './scp.js'
export { buildSftpPlan, runSftp, type SftpArgvOptions, type SftpPlan, type RunSftpOptions } from './sftp.js'
export { buildTarArgv, remoteExtractCommand, runTarSsh, type TarArgvOptions, type TarArgvPair } from './tar-ssh.js'
export { copyLocal } from './local-copy.js'
export { runProcess, realSpawn, DEFAULT_TIMEOUT_MS, summarizeFailure, type RunProcessOptions } from './proc.js'

/** 主机密钥策略的缺省：strict（铁律 3：主机密钥默认 strict） */
const DEFAULT_KNOWN_HOSTS: KnownHostsMode = 'strict'

/**
 * 传一次。
 *
 * @param req 一次传输的声明，不含「用哪种方式」——那由两端 Facts 决定
 * @param deps 依赖与偏好。本地目标需注入 localRunner；远端需给 remoteFacts
 * @returns 传输结果，`command` 为实际执行的 argv，供日志与报告使用
 * @throws DpError DP.CONFIG.INVALID（缺 Facts / 缺 localRunner / 本地没有 ssh）、
 * DP.SSH.TOOL_MISSING、DP.PREF.UNSUPPORTED（偏好不可用，或该方式不支持请求里
 * 的 --delete / 远端提权）、DP.SOURCE.EMPTY（清单为空）
 */
export async function transfer(
  req: TransferRequest,
  deps: TransferDeps,
): Promise<TransferResult> {
  if (deps.localFacts === undefined) {
    throw new DpError(ERR.CONFIG.INVALID, 'transfer 需要 localFacts', {
      hint: '协商的唯一输入是两端 Facts（一次探完，别一问一答）',
    })
  }
  const logger: Logger = deps.logger ?? createLogger()
  const log = logger.child({ host: req.host ?? (req.kind === 'local' ? 'local' : 'unknown') })
  const started = (deps.now ?? (() => new Date()))()

  // 本地两端口是同一份事实 —— 传两份不同的会凭空造出"两端工具不一致"的假象
  const remoteFacts = deps.remoteFacts ?? deps.localFacts
  if (req.kind === 'remote' && deps.remoteFacts === undefined) {
    throw new DpError(ERR.CONFIG.INVALID, '远程传输需要 remoteFacts', {
      hint: '用 @dp/ssh 的 probeFacts 探测目标机；--facts 夹具只能用于 local 主机',
    })
  }

  const choice: TransportChoice = chooseTransport({
    local: deps.localFacts,
    remote: remoteFacts,
    kind: req.kind,
    ...(deps.preferred !== undefined ? { preferred: deps.preferred } : {}),
    ...(deps.sftpAvailable !== undefined ? { sftpAvailable: deps.sftpAvailable } : {}),
  })

  log.info('transfer.chosen', {
    transport: choice.kind,
    reasons: choice.reasons,
    rejected: choice.rejected.map((r) => `${r.kind}: ${r.reason}`),
  })
  for (const w of choice.warnings) log.warn('transfer.warning', { warning: w, transport: choice.kind })

  const result =
    choice.kind === 'local-copy'
      ? await runLocal(req, deps, log)
      : await runRemote(req, { ...deps, localFacts: deps.localFacts, remoteFacts }, choice, log)

  log.info('transfer.done', {
    transport: result.kind,
    filesTransferred: result.filesTransferred,
    exitCode: result.exitCode,
    dryRun: result.dryRun === true,
    durationMs: (deps.now ?? (() => new Date()))().getTime() - started.getTime(),
  })
  return result
}

async function runLocal(
  req: TransferRequest,
  deps: TransportDeps,
  log: Logger,
): Promise<TransferResult> {
  if (deps.localRunner === undefined) {
    throw new DpError(ERR.CONFIG.INVALID, 'local 传输需要注入 localRunner', {
      hint: '本包不依赖 @dp/local：调用方用 createLocalRunner(facts) 建好 Runner 传进来，本地只有一个真相来源',
    })
  }
  log.info('transfer.local', { entries: req.entries.length, remoteRoot: req.remoteRoot })
  // 铁律：local 不起任何子进程做网络传输，这里一个 spawn 都不调
  return copyLocal(req, deps.localRunner)
}

async function runRemote(
  req: TransferRequest,
  deps: TransportDeps & { readonly localFacts: Facts; readonly remoteFacts?: Facts },
  choice: TransportChoice,
  log: Logger,
): Promise<TransferResult> {
  const localFacts = deps.localFacts
  const remoteFacts = deps.remoteFacts
  if (remoteFacts === undefined) {
    throw new DpError(ERR.CONFIG.INVALID, '远程传输需要 remoteFacts', { hint: '见 transfer() 的说明' })
  }
  const sshPath = localFacts.tools.ssh ?? null
  if (sshPath === null) {
    throw new DpError(ERR.SSH.TOOL_MISSING, '本地没有 ssh，远程传输无法进行', {
      hint: '本包走系统 ssh 作为 rsync 的 remote-shell。装 OpenSSH，或在 ssh2 驱动上走 dp-rsh 助手',
    })
  }

  const target = req.sshTarget ?? req.host
  if (target === undefined || target === '') {
    throw new DpError(ERR.CONFIG.INVALID, '远程传输需要 sshTarget 或 host', {
      hint: 'host 只用于日志，真正连接靠 sshTarget（user@host[:port]）',
    })
  }
  const remoteTarget = target.includes('@') ? target : target

  // 认证方式：给了 identityFile 才是明确的 key；否则用 agent 认证。
  const rsh: RshOptions = {
    sshPath,
    authKind: (deps.identityFileKind ?? (req.identityFile !== undefined ? 'key' : 'agent')) as SshAuthKind,
    knownHostsMode: deps.knownHostsMode ?? DEFAULT_KNOWN_HOSTS,
    ...(req.identityFile !== undefined ? { identityFile: req.identityFile } : {}),
    ...(req.port !== undefined ? { port: req.port } : {}),
    ...(req.hops !== undefined ? { hops: req.hops } : {}),
  }
  const timeoutMs = req.timeoutMs ?? deps.timeoutMs
  const spawnImpl = deps.spawn

  switch (choice.kind) {
    case 'rsync-ssh': {
      const rsyncPath = localFacts.tools.rsync ?? null
      if (rsyncPath === null) {
        throw new DpError(ERR.SSH.TOOL_MISSING, '本地没有 rsync（协商结论已过期）', {
          hint: '重新探测 Facts 后再协商；不要在这里偷偷换成 tar —— 那会让 plan 与实际执行不一致',
        })
      }
      const argv = buildRsyncPlan(req, { rsyncPath, rsh, remoteTarget })
      return runRsyncPlan(argv, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(spawnImpl !== undefined ? { spawnImpl } : {}),
      })
    }
    case 'tar-ssh': {
      const tarPath = localFacts.tools.tar ?? null
      if (tarPath === null) {
        throw new DpError(ERR.SSH.TOOL_MISSING, '本地没有 tar（协商结论已过期）', {
          hint: '重新探测 Facts 后再协商',
        })
      }
      const pair = buildTarArgv(req, {
        localTarPath: tarPath,
        rsh,
        remoteTarget,
        ...(req.become !== undefined ? { become: req.become } : {}),
      })
      log.info('transfer.tar', { entries: req.entries.length })
      return runTarSsh(pair, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(spawnImpl !== undefined ? { spawnImpl } : {}),
        ...(req.dryRun !== undefined ? { dryRun: req.dryRun } : {}),
      })
    }
    case 'scp': {
      const scpPath = localFacts.tools.scp ?? null
      if (scpPath === null) {
        throw new DpError(ERR.SSH.TOOL_MISSING, '本地没有 scp（协商结论已过期）', {
          hint: '重新探测 Facts 后再协商',
        })
      }
      const argv = buildScpPlan(req, { scpPath, rsh, remoteTarget })
      return runScpPlan(argv, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(spawnImpl !== undefined ? { spawnImpl } : {}),
        ...(req.dryRun !== undefined ? { dryRun: req.dryRun } : {}),
        expectedEntries: req.entries.length,
      })
    }
    case 'sftp': {
      const sftpPath = localFacts.tools.sftp ?? null
      if (sftpPath === null) {
        throw new DpError(ERR.SSH.TOOL_MISSING, '本地没有 sftp（协商结论已过期）', {
          hint: '重新探测 Facts 后再协商；不要在这里偷偷换成 scp —— 那会让 plan 与实际执行不一致',
        })
      }
      const plan = buildSftpPlan(req, { sftpPath, rsh, remoteTarget })
      log.info('transfer.sftp', { entries: req.entries.length })
      return runSftp(plan, {
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(spawnImpl !== undefined ? { spawnImpl } : {}),
        ...(req.dryRun !== undefined ? { dryRun: req.dryRun } : {}),
      })
    }
    case 'local-copy':
      throw new DpError(ERR.CONFIG.INVALID, 'local-copy 只适用于 kind=local', { hint: '检查调用方传错了 kind' })
  }
}

export { hostTarget }
