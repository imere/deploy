export type { RenderContext, RenderOptions, Usage } from './context.js'

export { assertSafe } from './unsafe.js'
export { collectVars, KNOWN_VARS, scan, validateVars, type ScanResult, type Segment, type VarRef } from './vars.js'
export { releaseVars, renderDeep, renderString } from './render.js'
