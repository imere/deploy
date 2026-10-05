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

/**
 * plan 的输入。**全字段注入**（含源清单与 releaseId）：
 * 零 IO 才能在没有目标机的机器上断言「这一步会执行什么」。
 */
export interface PlanInput {
  /** 项目名，进路径与模板 */
  readonly name: string
  readonly project: ProjectConfig
  readonly facts: Facts
  /** 版本号由调用方算好后注入，因为 releaseId 的口径属于版本策略而非本包 */
  readonly releaseId: string
  /** 源里的相对路径清单，用于跨平台校验 */
  readonly sourceEntries: readonly string[]
  /** 覆盖推导结果；auto 表示由能力推导 */
  readonly layout?: 'auto' | 'system' | 'user'
}

/**
 * plan 的产物。
 *
 * 纯数据是刻意的：它的全部价值就是「不需要任何机器就能断言」，
 * 混进一个函数或时间戳就再也断言不了步骤序列了。
 */
export interface Plan {
  readonly layout: Layout
  readonly releaseRoot: string
  readonly candidates: readonly CandidateResult[]
  readonly steps: readonly Step[]
  readonly warnings: readonly string[]
}

/**
 * 编排：配置 + 事实 → 步骤序列。
 *
 * 纯函数是这里唯一不可让步的约束：它让「将要执行什么」在没有目标机时可断言，
 * 而步骤顺序（nginx 的 install → deploy → activate、docker 的 deploy → install → activate）
 * 恰恰是最容易在两个目标之间抄错的地方 —— 一次断言就能抓住，一次线上事故才发现就太贵了。
 *
 * `warnings` 与错误是两种出口：能力缺口（如未开 linger）不阻断部署，
 * 只提前告知；判据不成立（0 命中、并列）才抛错。
 *
 * @param input 注入的配置、目标机事实、版本号与源清单
 * @returns 布局、发布根、候选判定、步骤序列与告警；全是纯数据，无 IO
 * @throws DpError 源路径跨平台非法（传第一个字节之前就会抛，此时零副作用）
 */
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
