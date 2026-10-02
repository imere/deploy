/**
 * @dp/target-docker —— docker 目标（remote-cli 模式）。
 *
 * 铁律：零直接 IO。本包不 import `node:fs` / `node:child_process`，不读 `process.env`，
 * 不起子进程 —— release 路径、渲染上下文全部由上层注入。这样 plan 出来的 `Step[]`
 * 可以在没有任何机器的机器上断言；执行器的 IO 走注入的 `Runner`。
 */
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
