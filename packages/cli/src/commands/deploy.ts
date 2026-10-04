/**
 * `dp deploy` —— 「什么都不写也能用」的一键入口。
 *
 * 方向与 `dp apply` **相反**：apply 默认真执行，deploy 默认干跑。差别不在安全观，
 * 而在用户掌握的信息量 —— apply 前面有一份他写过的配置，他知道自己要做什么；
 * deploy 前面什么配置都没有，dp 是靠探测猜出来的。让人在**没看过结论**的情况下
 * 就改生产目录，比「默认执行但先给 `dp plan`」危险得多。
 * 想要落盘就显式加 `--yes`：那个名字选得刻意的 —— 铁律 0 不许交互，也就意味着
 * 没有「人看过提示再敲 y」这个环节，`--yes` 表达的是「我接受上面这份自动决定」，
 * 不是「我确认过了」（后者在本仓做不到，也假装做到了）。
 */
import { findConfigUpwards } from '../config-file.js'
import { collectProjectFacts } from '../project-facts.js'
import type { ResolvedFlags, RunContext } from '../run.js'
import { deriveZeroConfig } from '../zero-config.js'
import { runApply } from './apply.js'

/**
 * 零配置只造本机主机。猜 SSH 连接串与凭据比直接报错危险得多，
 * 主机 id 也固定成这一个 —— 主机名会出现在日志、发布目录与 compose 项目名里，
 * 按 cwd 推一个出来只会在这些地方制造「看起来像用户指定的」假象。
 */
const HOST_ID = 'local'

export interface DeployFlags extends ResolvedFlags {
  /** 接受上面这份自动决定，真的落盘。零配置路径默认干跑 */
  readonly yes?: boolean
}

/**
 * 这次该不该走零配置。
 *
 * 判据是「盘上有没有配置文件」，而不是「loadConfig 有没有报错」：配置文件存在却
 * 加载失败（JSON 写错 / 校验不过）是**用户的配置有问题**，那必须原样报错；
 * 退到零配置去部署一份猜的，等于用一次静默成功盖住他自己的笔误。
 * 显式 `--config` / `DP_CONFIG` 同理 —— 用户已经点名要哪份配置，猜一份是背叛。
 */
function shouldUseZeroConfig(context: RunContext, flags: ResolvedFlags): boolean {
  if (flags.config !== undefined) return false
  if ((context.env['DP_CONFIG'] ?? '') !== '') return false
  return findConfigUpwards(context.cwd) === undefined
}

export async function runDeploy(context: RunContext, flags: DeployFlags): Promise<number> {
  if (!shouldUseZeroConfig(context, flags)) {
    // 有配置文件：行为与 `dp apply` 逐字一致，零配置不介入
    return runApply(context, flags)
  }

  const facts = collectProjectFacts(context.cwd)
  const derived = deriveZeroConfig({
    projectName: facts.projectName,
    hostId: HOST_ID,
    entries: facts.entries,
    packageScripts: facts.packageScripts,
    existingDirs: facts.existingDirs,
    ...(flags.env !== undefined ? { env: flags.env } : {}),
  })

  const dryRun = flags.dryRun || flags.yes !== true
  // 剥掉 `yes`：它是 deploy 自己的判据，不该流进 apply（apply 的开关集合里没有它）
  const { yes: _yes, ...applyFlags } = flags
  return runApply(context, { ...applyFlags, dryRun }, { config: derived.config, notes: derived.notes })
}

/**
 * deploy 的开关集合。**刻意与 apply 差一个 `--yes`**：apply 前面有一份写好的配置，
 * 而 deploy 的配置是猜出来的，确认开关只对后者有意义。
 */
export const DEPLOY_ALLOWED_FLAGS: readonly string[] = [
  'config',
  'env',
  'host',
  'project',
  'all',
  'facts',
  'json',
  'dry-run',
  'yes',
  'log-format',
  'log-level',
  'log-file',
  'verbose',
  'quiet',
]
