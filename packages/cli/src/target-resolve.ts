/**
 * 目标解析 —— 把「配置里的一个 (host, project)」变成「可执行操作的四件套」。
 *
 * 为什么单独抽出来：apply / status / verify / rollback 都要同一组东西 ——
 * facts、runner、发布根、保留份数。复制四份的风险不是「重复劳动」，而是**分叉**：
 * 某一处悄悄改了 runner 的选择规则（比如多加一个 local 兜底），部署到远端的
 * 请求就会变成写进自己机器，而这种 bug 在只跑过单机测试时完全看不出来。
 *
 * 只读命令尤其需要它：`makePlan` 要求一个 releaseId，而 status / verify 根本
 * 没有「这次要发布的版本」这回事 —— 编一个假的 releaseId 只会让发布根的计算
 * 依赖上一个与查询无关的输入。所以这里直接调 pickReleaseRoot，不经过 plan。
 */
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
   * `--facts` 夹具。给了就完全离线（跳过 acquireFacts），此时没有连接、
   * 也就没有 runner —— 于是下面的第 3 条规则会拒掉远端主机。
   * 单独提供这个口子而不是让 apply 自己装配，是为了保证「runner 怎么选」
   * 永远只有这一处实现。
   */
  readonly factsOverride?: Facts
}

/**
 * 装配 facts + runner + 发布根。
 *
 * 三条不可让步的规则（照搬 apply 的既有行为，apply 已改为复用本函数）：
 *
 *  1. runner 优先用 `facts.runner`。ssh 路径下 acquireFacts 已经连好了一条连接，
 *     复用它保证「探测看到的机器」与「写入的机器」物理上就是同一台 —— 重新连
 *     既慢，又可能因主机密钥或瞬时抖动在第二次失败。
 *  2. 没有 `facts.runner` 时**只有** `local: true` 才造本机 Runner。
 *  3. 其余情况抛 `DP.CONFIG.INVALID`，绝不悄悄退回本机 —— 那会把「部署到远端」
 *     变成「部署到自己机器上」，是本仓最不能犯的那类错误。
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
          // 「注入的 env 被忽略、凭据解析去读真实进程环境」—— 测试隔离不了，
          // 生产也会在 env 与 process.env 不一致时静默用错的那份
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
  // 'auto' 必须显式挑出来：pickReleaseRoot 只认三个具体布局，把 'auto' 传进去
  // 会在候选表里查不到任何一条
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

/** 装配期失败也要走调用方的结果文档（见 apply.ts 同名注释）——统一在这里转结构化错误 */
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
