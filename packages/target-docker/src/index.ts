export type { DockerCompose, DockerHealthcheck, DockerMode, DockerTargetConfig } from './types.js'

export {
  assertMode,
  assertProjectName,
  parseComposePs,
  psArgv,
  pullArgv,
  releaseDir,
  resolveCompose,
  upArgv,
} from './compose.js'
export type { ComposePsEntry, ComposePsResult, ResolvedCompose } from './compose.js'

export { dockerTarget } from './target.js'

/**
 * 执行器在本文件之外单独成模块，但一起导出：它同样是本包的对外表面，分开导出等于让调用方有机会只拿到 plan 就以为接上了。
 */
export {
  activateDocker,
  installDocker,
  isDockerExecFailure,
  rollbackDocker,
  verifyDocker,
} from './executor.js'
export type {
  DockerExecFailure,
  DockerExecInput,
  DockerExecResult,
  DockerPhase,
  DockerStepTrace,
} from './executor.js'
