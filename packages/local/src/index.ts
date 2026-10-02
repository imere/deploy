/**
 * @dp/local —— 本机目标：能力实证、命令执行、文件系统操作、源枚举。
 *
 * 这里的 Runner 与将来的 SSH Runner 实现同一个 `@dp/ports` 接口，
 * 所以 core / target 不需要知道自己在跟哪台机器说话。
 */
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
} from './probe.js'

export {
  normalizeSourceSpec,
  listSourceEntries,
  type SourceSpec,
} from './scan.js'
