/**
 * 目标选择 —— **纯函数**，歧义靠拒绝。
 *
 * 为什么单独一个文件：`plan` / `facts` 两个命令都要「从配置 + 开关」算出
 * 「这次要处理哪些 (project, host)」。这段逻辑一旦和 IO 混在一起，就只能靠
 * 起子进程来测；而「多个候选却没指定」是最容易写错也最值得反复断言的一处。
 */
import { DpError } from '@dp/ports'
import type { Config, HostConfig, ProjectConfig } from '@dp/schema'
import { CliUsageError } from './args.js'

export interface TargetSelectionInput {
  readonly config: Config
  /** `--project` */
  readonly project?: string
  /** `--host` */
  readonly host?: string
  /** `--all` */
  readonly all?: boolean
  /** `--env`，对应 `config.profiles.<name>` */
  readonly env?: string
}

export interface SelectedTarget {
  readonly project: string
  readonly host: string
  /**
   * 注意类型：configSchema 的 `record(projectSchema)` 推出来的元素类型是**输入**
   * 形态（`keep?: number | undefined`），而 makePlan 要的是**归一化后**的形态
   * （`keep: number`）。configSchema.parse 已经把默认值填上了，所以这里断言成
   * ProjectConfig 是安全的 —— 断言放在唯一的取用点上，而不是散进各命令。
   */
  readonly projectConfig: ProjectConfig
  readonly hostConfig: HostConfig
}

function hostNames(config: Config): string[] {
  return Object.keys(config.hosts ?? {}).sort()
}

function projectNames(config: Config): string[] {
  return Object.keys(config.projects).sort()
}

/** profiles.<env> 里的 hosts 覆盖顶层同名主机 */
function resolveHostConfig(config: Config, host: string, env?: string): HostConfig {
  const base = config.hosts?.[host]
  if (base === undefined) {
    throw new CliUsageError(`配置里没有主机 ${host}`, {
      path: '--host',
      hint: `可用主机：${hostNames(config).join(' | ') || '（配置里一个都没有）'}`,
    })
  }
  const override = env === undefined ? undefined : config.profiles?.[env]?.hosts?.[host]
  return { ...(config.defaults?.hosts?.[host] ?? {}), ...base, ...(override ?? {}) } as HostConfig
}

/**
 * 算出这次要处理的目标列表。
 *
 * 拒绝歧义的具体规则（铁律 2）：
 *  - 没给 `--project` 且配置里有多个项目 → 报错并列出全部名字
 *  - 没给 `--host` 且候选主机多于一个 → 报错并列出全部名字
 *  - `--all` 与 `--host` 同时给 → 报错（一个要全部一个要一个，意图冲突）
 *  - 只有一个候选时**不**追问，直接用它 —— 这不是歧义
 */
export function selectTargets(input: TargetSelectionInput): SelectedTarget[] {
  const { all, config, env, host, project } = input

  if (all === true && host !== undefined) {
    throw new CliUsageError('--all 与 --host 不能同时给：一个要全部，一个要指定', {
      path: '--all',
      hint: '要么 `dp plan --all`，要么 `dp plan --host <id>`',
    })
  }

  const allProjects = projectNames(config)
  if (allProjects.length === 0) {
    throw new DpError('CONFIG_INVALID', '配置里没有任何项目（projects 为空）', {
      path: 'config.projects',
      hint: '至少写一个项目，形如 { "projects": { "web": { "source": { "root": "./dist" } } } }',
    })
  }

  let chosenProjects: string[]
  if (project !== undefined) {
    if (!allProjects.includes(project)) {
      throw new CliUsageError(`配置里没有项目 ${project}`, {
        path: '--project',
        hint: `可用项目：${allProjects.join(' | ')}`,
      })
    }
    chosenProjects = [project]
  } else if (all === true) {
    chosenProjects = allProjects
  } else if (allProjects.length === 1) {
    chosenProjects = allProjects
  } else {
    throw new CliUsageError(`配置里有 ${allProjects.length} 个项目，必须用 --project 指定`, {
      path: '--project',
      hint: `可选：${allProjects.join(' | ')}。要全部就加 --all（注意 --all 不能与 --host 同用）`,
    })
  }

  const out: SelectedTarget[] = []
  for (const name of chosenProjects) {
    const projectConfig = config.projects[name]
    if (projectConfig === undefined) continue
    const declared = projectConfig.hosts
    const available = hostNames(config)

    let hosts: string[]
    if (host !== undefined) {
      if (!available.includes(host)) {
        throw new CliUsageError(`配置里没有主机 ${host}`, {
          path: '--host',
          hint: `可用主机：${available.join(' | ') || '（配置里一个都没有）'}`,
        })
      }
      hosts = [host]
    } else if (declared !== undefined && declared.length > 0) {
      // 项目自己声明了 hosts —— 这是配置里显式的意图，不算歧义
      hosts = [...declared].sort()
    } else if (available.length === 1) {
      hosts = available
    } else if (available.length === 0) {
      throw new DpError('CONFIG_INVALID', `配置里没有主机（config.hosts 为空），项目 ${name} 无处可部署`, {
        path: 'config.hosts',
        hint: '加一个主机条目，形如 { "hosts": { "local": { "local": true } } }',
      })
    } else if (all === true) {
      // --all 的含义就是「全部」，这里不追问；追问反而会让 --all 在多主机下永远不可用
      hosts = available
    } else {
      throw new CliUsageError(
        `项目 ${name} 有 ${available.length} 个可用主机，必须用 --host 指定（或写进 projects.${name}.hosts）`,
        { path: '--host', hint: `可选：${available.join(' | ')}` },
      )
    }

    for (const h of hosts) {
      out.push({
        project: name,
        host: h,
        projectConfig: projectConfig as ProjectConfig,
        hostConfig: resolveHostConfig(config, h, env),
      })
    }
  }
  return out
}
