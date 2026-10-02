/**
 * @dp/template —— 纯模板渲染：变量展开 + 危险字符校验。
 *
 * 铁律：零 IO、零依赖注入。环境变量、git 状态、时钟全部由调用方放进
 * RenderContext（见 context.ts 顶部为什么必须是调用方负责）。
 * 依赖只有 @dp/ports（错误类型）与 @dp/core（路径字符判定）。
 */
export type { RenderContext, RenderOptions, Usage } from './context.js'

export { assertSafe } from './unsafe.js'
export { collectVars, KNOWN_VARS, scan, validateVars, type ScanResult, type Segment, type VarRef } from './vars.js'
export { releaseVars, renderDeep, renderString } from './render.js'
