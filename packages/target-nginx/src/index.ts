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
