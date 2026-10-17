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
  probeCreatableRemote,
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
