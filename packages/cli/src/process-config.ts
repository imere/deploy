import type { TargetContext } from '@dp/ports'
import type { ProcessConfig } from '@dp/schema'
import type { ProcessTargetConfig } from '@dp/target-process'
import { renderContextFor } from './render-context.js'

export interface ProcessTranslateInput {
  readonly project: string
  /** profile 名（`--env`）。没给就是空串：`${env}` 这时按缺值报错，而不是编一个出来 */
  readonly env: string
  readonly envVars: Readonly<Record<string, string | undefined>>
  readonly targetCtx: TargetContext
  readonly now: Date
  readonly process: ProcessConfig
}

/**
 * schema 的 `target.process` → `@dp/target-process` 的 `ProcessTargetConfig`。
 *
 * **这里没有路径推导**，与 systemd 相反：pidfile / 日志落在发布根下的固定位置，
 * 脚本落在版本目录里，而这两处都由 `@dp/target-process` 从 `ctx.root` 与 `ctx.releaseId`
 * 推出来。再在 CLI 这层推导一遍只会造出第二个答案。
 *
 * @param input 渲染上下文与已归一化的 process 段
 * @returns 执行器可直接消费的配置
 */
export function processConfigFor(input: ProcessTranslateInput): ProcessTargetConfig {
  const { process } = input
  return {
    command: process.command,
    render: renderContextFor(input),
    ...(process.args !== undefined ? { args: process.args } : {}),
    ...(process.workingDirectory !== undefined ? { workingDirectory: process.workingDirectory } : {}),
    ...(process.env !== undefined ? { env: process.env } : {}),
    ...(process.stopSignal !== undefined ? { stopSignal: process.stopSignal } : {}),
    ...(process.stopTimeoutMs !== undefined ? { stopTimeoutMs: process.stopTimeoutMs } : {}),
    ...(process.pidFile !== undefined ? { pidFile: process.pidFile } : {}),
    ...(process.stdoutLog !== undefined ? { stdoutLog: process.stdoutLog } : {}),
  }
}
