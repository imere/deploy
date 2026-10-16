export type { SystemdScope, SystemdTargetConfig } from './types.js'

export { MANAGED_MARKER, isManaged, renderUnit, type UnitRenderInput } from './unit.js'
export {
  analyzeVerifyArgv,
  renderUnitFor,
  systemctlArgv,
  systemdTarget,
  unitPaths,
  type UnitPaths,
} from './target.js'
export {
  activateSystemd,
  decideUnitOverwrite,
  installSystemd,
  isSystemdExecFailure,
  rollbackSystemd,
  verifySystemd,
  type SystemdExecFailure,
  type SystemdExecInput,
  type SystemdExecResult,
  type SystemdOwnership,
  type SystemdPhase,
  type SystemdStepTrace,
} from './executor.js'
