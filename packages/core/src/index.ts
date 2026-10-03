/**
 * @dp/core —— 编排的核心：plan()。
 *
 * 铁律：`plan(config + facts) → steps` 是**纯函数**，没有任何 IO。
 * 这是整套设计可测试性的来源：不需要机器就能断言"将会执行什么"。
 */
import { INCOMING_SUFFIX, RELEASES_DIR_NAME, type Facts, type Layout, type Step } from '@dp/ports'
import { DEFAULT_KEEP, type ProjectConfig } from '@dp/schema'
import {
  checkSourcePaths,
  deriveLayout,
  pickReleaseRoot,
  type CandidateResult,
} from './paths.js'

export * from './paths.js'
export * from './detect.js'

export interface PlanInput {
  readonly name: string
  readonly project: ProjectConfig
  readonly facts: Facts
  readonly releaseId: string
  /** 源里的相对路径清单，用于跨平台校验 */
  readonly sourceEntries: readonly string[]
  /** 覆盖推导结果；auto 表示由能力推导 */
  readonly layout?: 'auto' | 'system' | 'user'
}

export interface Plan {
  readonly layout: Layout
  readonly releaseRoot: string
  readonly candidates: readonly CandidateResult[]
  readonly steps: readonly Step[]
  readonly warnings: readonly string[]
}

export function makePlan(input: PlanInput): Plan {
  const { facts, project, name, releaseId } = input
  const warnings: string[] = []

  // ① 源路径校验 —— 在传第一个字节之前发现问题，此时零副作用
  checkSourcePaths(input.sourceEntries, facts.platform)

  // ② 布局推导
  const layout: Layout =
    input.layout !== undefined && input.layout !== 'auto' ? input.layout : deriveLayout(facts)

  // ③ 发布目录推导
  const choice = pickReleaseRoot({
    facts,
    layout,
    name,
    explicitRoot: project.release?.root,
  })

  // ④ 已知的能力缺口，提前告知而不是等到运行时
  if (facts.capabilities.systemdScope === 'user' && !facts.capabilities.lingerEnabled) {
    warnings.push('DP.SYSTEMD.NO_LINGER: 用户级服务未开启 linger，注销后不会存活')
  }
  if (project.activation?.mode === 'trial-promote' && project.healthcheck === undefined) {
    warnings.push('DP.VERIFY.NO_HEALTHCHECK: 没有 healthcheck，autoPromote 退化为 never')
  }

  const root = choice.root
  const keep = project.release?.keep ?? DEFAULT_KEEP
  const incoming = `${root}/${RELEASES_DIR_NAME}/${releaseId}${INCOMING_SUFFIX}`
  const steps: Step[] = [
    { id: 'prepare', kind: 'prepare', title: '预检：连接 · 权限实证 · 磁盘 · 端口', host: facts.host },
    { id: 'stage', kind: 'stage', title: `计算 releaseId ${releaseId}`, host: facts.host },
    {
      id: 'transfer',
      kind: 'transfer',
      title: `传输到 ${incoming}`,
      host: facts.host,
      undo: `删除 ${incoming}`,
    },
    { id: 'install', kind: 'install', title: '安装：shared 链接 · 权限 · 渲染 conf', host: facts.host },
    {
      id: 'activate',
      kind: 'activate',
      title: '切换 current 指向新版本（trial）',
      host: facts.host,
      undo: 'current 指回上一版',
    },
    { id: 'verify', kind: 'verify', title: '健康检查', host: facts.host },
    { id: 'promote', kind: 'promote', title: 'promote：写入开机自启', host: facts.host },
    { id: 'prune', kind: 'prune', title: `保留 ${keep} 个历史版本`, host: facts.host },
  ]

  return { layout, releaseRoot: root, candidates: choice.candidates, steps, warnings }
}
