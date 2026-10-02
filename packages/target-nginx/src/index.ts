/**
 * @dp/target-nginx —— nginx 目标。
 *
 * 铁律：零直接 IO。本包不 import `node:fs` / `node:child_process`，不读 `process.env`，
 * 不起子进程 —— confd、渲染上下文、候选路径都由上层注入。这样 plan 出来的
 * `Step[]` 可以在没有任何机器的机器上断言；执行器的全部 IO 走注入的 `Runner`，
 * 走的还是同一条边界。
 */
export type { Location, NginxTargetConfig, ProxyTimeouts, ReverseProxy, ServerBlock } from './types.js'

export { renderConf, renderShadowMainConf } from './render.js'
export { assertOverwritable, decideOverwrite, isManaged, MANAGED_MARKER } from './ownership.js'
export type { OverwriteDecision, OverwriteOptions } from './ownership.js'
export { nginxTarget } from './target.js'
export { activateNginx, installNginx, isNginxExecFailure, rollbackNginx, verifyNginx } from './executor.js'
export type {
  NginxExecFailure,
  NginxExecInput,
  NginxExecResult,
  NginxPhase,
  NginxStepTrace,
} from './executor.js'
