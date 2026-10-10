import { resolveTargetKind, type DetectResult, type TargetPick } from '@dp/core'
import { DpError } from '@dp/ports'
import {
  defineConfig,
  defineDocker,
  defineHost,
  defineProject,
  defineTarget,
  type Config,
  type DockerConfig,
  type HostConfig,
  type ProjectConfig,
  type TargetConfig,
} from '@dp/schema'
import { CliUsageError } from './args.js'

/**
 * 源根候选，**顺序即优先级**。
 */
export const SOURCE_ROOT_CANDIDATES: readonly string[] = ['dist', 'build', 'out', 'public']

/**
 * 零配置装配的输入。**目录清单与源清单都由调用方注入**：本文件不 stat、不读 package.json —— 一旦它自己枚举 cwd，「给一组 entries 就能断言结论」就再也做不到，而那正是最值得反复断言的部分。
 */
export interface ZeroConfigInput {
  /** 项目名。零配置下就是当前目录名 */
  readonly projectName: string
  /** 主机 id，默认调用方给 'local' */
  readonly hostId: string
  /** 源条目（相对路径，如 `docker-compose.yml`、`assets/app.js`）。由调用方枚举注入 */
  readonly entries: readonly string[]
  /** package.json 里的 scripts 名字，供 delegate 探测 */
  readonly packageScripts?: readonly string[]
  /** cwd 下真实存在的目录名（相对 cwd）。源根候选靠它筛，本函数不 stat */
  readonly existingDirs?: readonly string[]
  /** 覆盖 target.pick；不给时**必须**用 schema 里 targetSchema.pick 的默认值，不许另写死一个 */
  readonly pick?: TargetPick
  /** 环境仲裁用：配置里（零配置场景下由调用方给出）存在的 profile 名 */
  readonly profiles?: readonly string[]
  readonly env?: string
}

/**
 * 装配结果。配置只在内存里（见文件头），`notes` 逐条说明每个自动决定的理由 ——「自动不等于静默」：用户必须能一条条反驳，而不是只能整体接受或放弃。
 */
export interface ZeroConfigResult {
  /** 补出来的配置。形状与 schema 的 Config 完全一致（可以直接喂给 selectTargets） */
  readonly config: Config
  /** 目标类型探测的结论（CLI 靠它打印「为什么选了它」） */
  readonly detected: DetectResult
  /**
   * 每一步自动决定的一行人话，供 CLI 逐行打印。
   */
  readonly notes: readonly string[]
}

/**
 * 多环境不能猜：多个 profile 且没指定 `--env` 时报错，不默认挑第一个。
 *
 * @param profiles 配置里真实存在的环境名（零配置下通常为空数组）
 * @param env `--env` 的值；undefined 表示没给
 * @param defaultEnv 可选的默认环境（如来自 `profiles.default`），
 * 它同样必须是在册的真实环境 —— 不存在的默认值在这里报错而不是静默忽略，
 * 否则「配了 default 但拼错了」这件事永远不会被发现
 * @returns 环境名；**没有 profile 且没给 env 时返回空串**（不是 undefined：
 * 空串是「不套用任何环境覆盖」的可承载值，undefined 会逼调用方再判一次）
 * @throws CliUsageError `--env` 或 defaultEnv 不在 profiles 里
 * @throws DpError 多个 profile 且没给 --env、也没有 defaultEnv
 */

export function resolveEnv(
  profiles: readonly string[],
  env: string | undefined,
  defaultEnv?: string,
): string {
  if (env !== undefined) {
    if (!profiles.includes(env)) {
      throw new CliUsageError(`配置里没有环境 ${env}`, {
        path: '--env',
        hint: `可用环境：${profiles.join(' | ') || '（配置里一个都没有）'}`,
      })
    }
    return env
  }

  // 没有 profile 是「无环境」而不是错误：单主机单项目的部署本来就不分环境
  if (profiles.length === 0) return ''

  const [only] = profiles
  if (only !== undefined && profiles.length === 1) return only

  if (defaultEnv !== undefined) {
    if (!profiles.includes(defaultEnv)) {
      throw new CliUsageError(`默认环境 ${defaultEnv} 不在 profiles 里`, {
        path: '--env',
        hint: `可用环境：${profiles.join(' | ')}。默认环境只是「没给 --env 时用哪个」，它同样必须是真实存在的 profile`,
      })
    }
    return defaultEnv
  }

  throw new DpError('DP.CONFIG.INVALID', `配置里有 ${profiles.length} 个环境，没给 --env 时 dp 不猜`, {
    path: '--env',
    hint: `可选：${profiles.join(' | ')}。默认挑第一个就是把预发的东西发到生产的入口 —— 显式用 --env 指定`,
  })
}

/**
 * `target.pick` 的默认值 —— **只从 schema 取**。
 */
function defaultPick(): TargetPick {
  return defineTarget({ type: 'static' }).pick
}

/**
 * 源根写成 contents 形态（`./dist/**`）而不是目录本身（`./dist`）：- release 目录里应当**直接**是产物本身。写成目录本身会让 `current/dist/index.html`凭空多一层，而 nginx 的 `root: ${release.current}` 也就指不到 index.html；- compose 文件的路径是**相对 release 目录**的（绝对路径 / `..` 会被`DP.DOCKER.COMPOSE_FILE_INVALID` 顶回），多一层目录会让 `files` 与盘上的真实位置差一级。
 */
function sourceSpecFor(root: string): string {
  return `./${root}/**`
}

function pickSourceRoot(projectName: string, existingDirs: readonly string[]): string {
  const hit = SOURCE_ROOT_CANDIDATES.find((dir) => existingDirs.includes(dir))
  if (hit !== undefined) return hit
  throw new DpError('DP.CONFIG.INVALID', `零配置找不到源根：cwd 下没有 ${SOURCE_ROOT_CANDIDATES.join(' / ')}`, {
    path: `projects.${projectName}.source.root`,
    hint:
      `它只看了这四个目录名（按 ${SOURCE_ROOT_CANDIDATES.join(' > ')} 取第一个存在的），一个都没出现。` +
      "这里刻意不退到 '.' —— 那会把 node_modules 一起传上去。" +
      '用 --config 给一份配置，在里面显式写 source.root',
  })
}

/** 零配置只造本地主机：猜 SSH 连接串与凭据，比直接报错危险得多 */
function hostFor(): HostConfig {
  return defineHost({ local: true })
}

function nginxAutoConfigError(projectName: string, detected: DetectResult): DpError {
  return new DpError('DP.CONFIG.INVALID', `零配置不装配 nginx：探测到 ${detected.evidence.join('、')}`, {
    path: `projects.${projectName}.target.nginx`,
    hint:
      'target.nginx 需要一个 server 块（listen / server_name / 反代规则），凭空造一份就是编造你的意图。' +
      `用 --config 指向一份配置，在里面写 projects.${projectName}.target.nginx.server；` +
      `若这个项目其实只是静态站点，把 ${detected.evidence.join('、')} 从 source 里 exclude 掉，它就会走 static`,
  })
}

/**
 * 按探测结论补出一份内存中的配置。**不读盘、不写盘**。
 *
 * @param input 全部事实由调用方注入（源条目、已存在目录、scripts），本函数不 stat、不读盘 ——
 * 一旦它自己去看文件系统，「同一份源清单推导出同一份配置」这条断言就没法在测试里成立
 * @returns 内存中的配置 + 探测结论 + 逐条理由
 * @throws DP.CONFIG.INVALID 探测到 nginx（server 块无从推导）或目标类型不在零配置支持范围内
 */
export function deriveZeroConfig(input: ZeroConfigInput): ZeroConfigResult {
  const root = pickSourceRoot(input.projectName, input.existingDirs ?? [])
  const pick = input.pick ?? defaultPick()
  const env = resolveEnv(input.profiles ?? [], input.env)

  const detected = resolveTargetKind(
    { entries: input.entries, packageScripts: input.packageScripts },
    pick,
  )

  const notes: string[] = [
    `源根：cwd 下存在 ${root}（按 ${SOURCE_ROOT_CANDIDATES.join(' > ')} 取第一个存在的）→ source.root=${sourceSpecFor(root)}`,
    `主机：零配置只造一个本地主机 ${input.hostId}（local: true）—— 远端的连接串与凭据一概不猜`,
    env === '' ? '环境：没有 profile，本次不套用任何环境覆盖' : `环境：${env}`,
    detected.reason,
  ]

  let target: TargetConfig | undefined
  switch (detected.kind) {
    case 'static':
      notes.push('目标：static 是默认目标，不写 target 段（写上去只是噪声）')
      break
    case 'docker': {
      // files 直接用探测给出的证据文件名：它们是「dp 为什么认为是 docker」的
      const files = [...detected.evidence]
      const docker: DockerConfig = defineDocker({
        compose: { files, projectName: input.projectName },
      })
      target = defineTarget({ type: 'docker', pick, docker })
      notes.push(
        `target.docker：compose 文件取探测证据 ${files.join('、')}，projectName 用项目名 ${input.projectName}；` +
          'compose 文件里的变量由 compose 自己解释，dp 不碰',
      )
      break
    }
    case 'nginx':
      throw nginxAutoConfigError(input.projectName, detected)
    default:
      throw new DpError('DP.CONFIG.INVALID', `零配置不支持 ${detected.kind} 目标`, {
        path: `projects.${input.projectName}.target.type`,
        hint: '用 --config 给一份配置，在里面显式写 target.type',
      })
  }

  const project: ProjectConfig = defineProject({
    source: { root: sourceSpecFor(root) },
    hosts: [input.hostId],
    ...(target !== undefined ? { target } : {}),
  })

  const config: Config = defineConfig({
    hosts: { [input.hostId]: hostFor() },
    projects: { [input.projectName]: project },
  })

  notes.push('这份配置只在内存里 —— dp 不会替你把它写到磁盘上')
  return { config, detected, notes }
}
