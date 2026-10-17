import type { TargetContext } from '@dp/ports'
import type { RenderContext } from '@dp/template'
import { releaseVars } from '@dp/template'

/**
 * 四个 target（nginx / docker / systemd / process）的 render 段的公共来源：
 * release.id / release.current 只能取自同一份 `releaseVars` 推导 ——
 * 各自写一份迟早分叉出「同一个版本被渲染成两个 current」。
 */
export interface RenderContextInput {
  readonly project: string
  /** profile 名（`--env`）。没给就是空串：`${env}` 这时按缺值报错，而不是编一个出来 */
  readonly env: string
  readonly envVars: Readonly<Record<string, string | undefined>>
  readonly targetCtx: TargetContext
  readonly now: Date
}

export function renderContextFor(input: RenderContextInput): RenderContext {
  const vars = releaseVars(input.targetCtx)
  return {
    project: input.project,
    env: input.env,
    envVars: input.envVars,
    release: { id: vars['release.id'], current: vars['release.current'] },
    now: input.now,
  }
}
