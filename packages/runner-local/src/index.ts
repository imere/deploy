export {
  detectPrompt,
  PROMPT_PATTERNS,
  resolveTool,
  run,
  DEFAULT_TIMEOUT_MS,
  type RunOptions,
} from './exec.js'

export { createLocalRunner } from './runner.js'

export {
  probeLocalFacts,
  probeWritable,
  snapshotEnv,
  type ProbeOptions,
  type ProbeRemove,
  type WritableProbe,
} from './probe.js'

export {
  normalizeSourceSpec,
  listSourceEntries,
  type SourceSpec,
} from './scan.js'
