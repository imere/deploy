import { deriveLayout, pickReleaseRoot } from '@dp/core'
import { createLocalRunner } from '@dp/local'
import { DpError, type Facts, type Runner } from '@dp/ports'
import { DEFAULT_KEEP, type HostConfig, type ProjectConfig } from '@dp/schema'
import type { ApplyDeps } from './deps.js'
import type { Logger } from '@dp/log'
import type { FactsResult } from './facts-source.js'
import type { RunContext } from './run.js'

export interface ResolvedTarget {
  readonly hostId: string
  readonly projectName: string
  readonly hostConfig: HostConfig
  readonly projectConfig: ProjectConfig
  readonly facts: Facts
  readonly runner: Runner
  readonly releaseRoot: string
  readonly keep: number
  /** 探测说明。与 apply 的结果字段对齐 */
  readonly probeNotes: readonly string[]
  /** 有连接时非空，调用方在 finally 里调 */
  readonly close?: () => Promise<void>
}

export interface ResolvedTargetInput {
  readonly context: RunContext
  readonly target: { readonly project: string; readonly host: string; readonly projectConfig: ProjectConfig; readonly hostConfig: HostConfig }
  readonly deps: Pick<ApplyDeps, 'acquireFacts'>
  readonly logger: Logger
  /**
   * `--facts` 夹具。给了就完全离线（跳过 acquireFacts），只剩类型推导可跑：
   * 离线时没有连接、也就没有 runner，所以 `--facts` 加远端主机的组合在这里被拒。
   */
  readonly factsOverride?: Facts
}

/**
 * 装配 facts + runner + 发布根。
 */
export async function resolveTarget(input: ResolvedTargetInput): Promise<ResolvedTarget> {
  const { context, deps, logger, target } = input
  const hostId = target.host
  const projectName = target.project

  const acquired: FactsResult =
    input.factsOverride !== undefined
      ? { facts: input.factsOverride, probeNotes: [], close: undefined }
      : await deps.acquireFacts({
          hostId,
          host: target.hostConfig,
          projectName,
          // env 必须显式往下传：acquireFacts 的兜底是 process.env，不传就等于
          env: context.env,
          ...(target.projectConfig.release?.root !== undefined
            ? { releaseRoot: target.projectConfig.release.root }
            : {}),
          logger,
        })

  const facts = acquired.facts

  let runner: Runner
  if (acquired.runner !== undefined) {
    runner = acquired.runner
  } else if (target.hostConfig.local === true) {
    runner = createLocalRunner(facts)
  } else {
    throw new DpError('DP.CONFIG.INVALID', `--facts 只能用于 local 主机，${hostId} 是远端主机`, {
      path: '--facts',
      hint: `远端部署需要真连接才能写入文件，删掉 --facts 重跑（远端事实会现场探测）`,
    })
  }

  // 显式 layout 优先；'auto' 与不写都走实证推导（deriveLayout），不靠 uid / 平台猜。
  const layout =
    target.hostConfig.layout === undefined || target.hostConfig.layout === 'auto'
      ? deriveLayout(facts)
      : target.hostConfig.layout
  const releaseRoot = pickReleaseRoot({
    facts,
    layout,
    name: projectName,
    ...(target.projectConfig.release?.root !== undefined
      ? { explicitRoot: target.projectConfig.release.root }
      : {}),
  }).root

  const keep = target.projectConfig.release?.keep ?? DEFAULT_KEEP

  return {
    hostId,
    projectName,
    hostConfig: target.hostConfig,
    projectConfig: target.projectConfig,
    facts,
    runner,
    releaseRoot,
    keep,
    probeNotes: acquired.probeNotes,
    ...(acquired.close !== undefined ? { close: acquired.close } : {}),
  }
}

/** 装配期失败也要走调用方的结果文档，而不是抛到 main 的通用错误处理 —— 统一在这里转结构化错误 */
export function targetErrorFields(err: unknown): {
  code: string
  message: string
  path?: string
  hint?: string
} {
  if (err instanceof DpError) {
    return {
      code: err.code,
      message: err.message,
      ...(err.path !== undefined ? { path: err.path } : {}),
      ...(err.hint !== undefined ? { hint: err.hint } : {}),
    }
  }
  return { code: 'DP.CLI.INTERNAL', message: err instanceof Error ? err.message : String(err) }
}
