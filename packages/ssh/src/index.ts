/**
 * @dp/ssh —— 远端 Runner。
 *
 * 分层：只依赖 @dp/ports（接口与错误）、@dp/log（结构化日志）、
 * @dp/core（纯函数的跨平台路径校验）。**@dp/core 不依赖本包** ——
 * 依赖方向永远是 core ← ssh，不是反过来。
 *
 * 零硬依赖：ssh2 是运行时可选的（它不支持任何抗量子 KEX，
 * 所以排在系统 ssh 之后，且 `crypto.kexPolicy=pq-required` 时只能用 native）。
 *
 * 纯函数在 `argv.ts` / `become.ts` / `parse.ts` / `posix.ts` / `prompt.ts` ——
 * 这五个文件零 IO，因此可以 100% 单测，不需要任何机器。
 */
export type {
  AuthConfig,
  DriverAvailability,
  DriverExecResult,
  ExecRequest,
  HopSpec,
  KnownHostsMode,
  ResolvedSecrets,
  SshConnectionOptions,
  SshDriver,
  SshDriverKind,
  Tunnel,
} from './driver.js'
export {
  validateHops,
  DEFAULT_PREFERENCE,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_SSH_TIMEOUT_MS,
  resolveDriver,
  resolveTimeoutMs,
  type DriverAttempt,
  type DriverFactory,
} from './driver.js'

export {
  buildRemoteCommand,
  buildRshArgv,
  buildSftpBatch,
  buildSshArgv,
  defaultPinPath,
  hostTarget,
  knownHostsOptions,
  quoteArg,
  quoteArgv,
  rshOptionValue,
  setEnvOptions,
  sftpQuote,
  type SshArgvOptions,
  type SshAuthKind,
} from './argv.js'

export {
  classifySshError,
  hostKeyHint,
  ioError,
  parseArch,
  parseFingerprint,
  parseInit,
  parseLinger,
  parsePlatform,
  parseSshG,
  parseStatLine,
  parseSudoList,
  parseToolPaths,
  sshGValue,
  truncateOutput,
  TRUNCATE_MARK,
  type HostKeyFingerprint,
  type RemoteStat,
  type SshFailure,
} from './parse.js'

export {
  detectPrompt,
  promptHint,
  PROMPT_PATTERNS,
  type PromptKind,
  type PromptMatch,
  type PromptPattern,
} from './prompt.js'

export {
  ELEVATE_FAILED_HINT,
  summarizeElevateFailure,
  wrapCommand,
  type BecomeConfig,
  type WrapOptions,
} from './become.js'

export {
  listDirScript,
  mkdirScript,
  readFileScript,
  readIntent,
  readlinkScript,
  realpathScript,
  removeScript,
  renameScript,
  script,
  statScript,
  symlinkScript,
  writeFileScript,
  type RemoteOp,
} from './posix.js'

export { createAskpassHelper, askpassToken, type AskpassHelper, type AskpassOptions } from './askpass.js'

export {
  assertNativeExecutable,
  createNativeDriver,
  killProcessTree,
  NativeSshDriver,
  resolveTool,
} from './native.js'

export { createSsh2Driver, Ssh2Driver } from './ssh2.js'

export {
  classifyConnectError,
  loadSsh2,
  type Ssh2ChannelLike,
  type Ssh2ClientLike,
  type Ssh2Load,
  type Ssh2ModuleLike,
  type Ssh2SftpLike,
} from './ssh2-module.js'

export {
  createSshRunner,
  isUnder,
  normalizeRemotePath,
  RemoteCommandError,
  SSH_DEFAULT_MAX_OUTPUT,
  type PathGuardOptions,
  type SshRunnerOptions,
} from './runner.js'

export {
  canElevate,
  ELEVATION_HINT,
  probeFacts,
  type CanElevateResult,
  type ProbeOptions,
  type ProbeResult,
} from './probe.js'

export { connectSsh, type ConnectedSsh, type ConnectOptions } from './connect.js'

/** 便捷重导出：调用方不必知道 BecomeConfig / Elevation 定义在 ports 里 */
export type { BecomeConfig as Become, Elevation } from '@dp/ports'
export { DpError } from '@dp/ports'
export type { Facts, Runner } from '@dp/ports'
export { createLogger, type Logger } from '@dp/log'
