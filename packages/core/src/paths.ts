/**
 * 路径：模板展开、发布目录候选、跨平台校验。
 *
 * 全部是**纯函数** —— 注入 Facts 即可断言，不需要任何机器。
 */
import { DpError, type Facts, type Layout, type Platform } from '@dp/ports'

// ------------------------------------------------------------
// 模板展开
// ------------------------------------------------------------

/**
 * 展开所需的三个值。**全由调用方注入**，本文件不读 `process.env`：
 * 注入让展开结果可断言（给定 env 必得给定字符串），直读环境则没法测。
 */
export interface TemplateContext {
  /** 项目名，替换模板里的 `<name>` */
  readonly name: string
  /** 目标机 home 目录。取**目标机**的而不是本机的 —— 展开发生在目标机语境下 */
  readonly homedir: string
  /** 目标机的环境变量全集，不是本机的 */
  readonly env: Readonly<Record<string, string | undefined>>
}

/**
 * 展开 `~` / `$XDG_*` / `%LOCALAPPDATA%` / `%ProgramFiles%` / `<name>`
 *
 * 只在**串首**替换环境变量（`out.startsWith`），中间的 `$FOO` 原样保留：
 * 全文替换会把路径里合法的 `${...}` 形态也吃掉，产出的路径指向一个不存在的目录。
 *
 * @param tpl 待展开的模板串，形如 `/srv/<name>`
 * @param ctx 注入的 home / env / name
 * @returns 展开后的路径；未识别的 token 原样保留（不报错，交由后续的实证去否定它）
 */
export function expandTemplate(tpl: string, ctx: TemplateContext): string {
  const home = ctx.homedir.replace(/[\\/]+$/, '')
  const table: ReadonlyArray<readonly [string, string]> = [
    ['$XDG_DATA_HOME', ctx.env.XDG_DATA_HOME ?? `${home}/.local/share`],
    ['$XDG_STATE_HOME', ctx.env.XDG_STATE_HOME ?? `${home}/.local/state`],
    ['%LOCALAPPDATA%', ctx.env.LOCALAPPDATA ?? `${home}/AppData/Local`],
    ['%ProgramFiles%', ctx.env.ProgramFiles ?? 'C:/Program Files'],
    ['%ProgramData%', ctx.env.ProgramData ?? 'C:/ProgramData'],
    ['~', home],
  ]
  let out = tpl
  for (const [token, value] of table) {
    if (out.startsWith(token)) out = value + out.slice(token.length)
  }
  return out.replaceAll('<name>', ctx.name)
}

// ------------------------------------------------------------
// 发布目录候选（规则明示）
// ------------------------------------------------------------

/**
 * 发布根目录候选表：platform × layout → 按优先级排好的路径模板。
 *
 * 顺序即优先级，**不可按字母排**：第一个可写的目录会被采用，
 * 调换顺序等于悄悄改了部署落点，而 plan 之外没有任何地方会暴露这个变化。
 * 每条都写明所属 layout，是为了让「为什么这台机器选了 user 布局」能从表本身读出来。
 */
export const RELEASE_ROOT_CANDIDATES: Readonly<
  Record<Platform, Readonly<Record<Layout, readonly string[]>>>
> = {
  linux: {
    system: ['/srv/<name>', '/opt/<name>', '/var/www/<name>'],
    hybrid: ['/srv/<name>', '~/apps/<name>', '$XDG_DATA_HOME/<name>'],
    user: ['~/apps/<name>', '$XDG_DATA_HOME/<name>'],
  },
  darwin: {
    system: ['/opt/<name>', '/usr/local/var/<name>', '/usr/local/opt/<name>'],
    hybrid: ['/opt/<name>', '~/Applications/<name>'],
    user: ['~/Applications/<name>', '$XDG_DATA_HOME/<name>'],
  },
  win32: {
    system: ['%ProgramFiles%/<name>', '%ProgramData%/<name>'],
    hybrid: ['%ProgramData%/<name>', '%LOCALAPPDATA%/<name>'],
    user: ['%LOCALAPPDATA%/<name>', '~/<name>'],
  },
  freebsd: {
    system: ['/usr/local/<name>', '/usr/local/www/<name>', '/opt/<name>'],
    hybrid: ['/usr/local/<name>', '~/apps/<name>'],
    user: ['~/apps/<name>', '$XDG_DATA_HOME/<name>'],
  },
  unknown: {
    system: ['~/apps/<name>'],
    hybrid: ['~/apps/<name>'],
    user: ['~/apps/<name>'],
  },
}

/** 一个候选的实测结论。`writable: false` 时 reason 必填 —— 只判死不解释等于没明示 */
export interface CandidateResult {
  readonly path: string
  readonly writable: boolean
  /** 跳过原因。plan 必须打印它 —— 只给结果不给理由等于没明示 */
  readonly reason?: string
}

/**
 * 选定的发布根。`candidates` 一并返回（**包括没选中的**），
 * 因为「为什么不是 /opt」是用户最常问的问题，plan 阶段就要能答。
 */
export interface ReleaseRootChoice {
  readonly root: string
  /** 是否来自 `release.root` 显式配置。false 表示是按能力挑的默认落点 */
  readonly explicit: boolean
  readonly candidates: readonly CandidateResult[]
}

/** 选根的输入。`explicitRoot` 给了也不保证可用 —— 仍要过一遍可写性实证 */
export interface PickReleaseRootInput {
  readonly facts: Facts
  readonly layout: Layout
  readonly name: string
  /** 配置里显式写的 `release.root`；不可写时报错而不静默换一个 */
  readonly explicitRoot?: string
}

/**
 * 按候选表 + 实测可写性选定发布根。
 *
 * 显式配置**优先于**能力推导但仍要过可写性检查：用户显式指定一个不可写的目录时
 * 静默改用别的落点，症状是「配了 root 却发到了别处」，比直接报错难查得多。
 *
 * @param input 注入的事实、布局、项目名与可选的显式 root
 * @returns 选中的根、是否来自显式配置，以及**全部**候选的判定结果
 * @throws DpError 显式 root 不可写，或没有任何候选可写
 */
export function pickReleaseRoot(input: PickReleaseRootInput): ReleaseRootChoice {
  const { facts, layout, name } = input
  const ctx: TemplateContext = {
    name,
    homedir: facts.homedir,
    env: facts.env as Readonly<Record<string, string | undefined>>,
  }

  if (input.explicitRoot !== undefined) {
    const writable = facts.capabilities.canWrite[input.explicitRoot] === true
    if (!writable) {
      throw new DpError('DP.PATH.NOT_WRITABLE', `release.root 不可写：${input.explicitRoot}`, {
        path: 'release.root',
        hint: '检查权限 / 只读挂载 / SELinux 标签；或改成一个当前身份可写的路径',
      })
    }
    return {
      root: input.explicitRoot,
      explicit: true,
      candidates: [{ path: input.explicitRoot, writable: true }],
    }
  }

  const templates =
    RELEASE_ROOT_CANDIDATES[facts.platform]?.[layout] ?? RELEASE_ROOT_CANDIDATES.unknown[layout]

  const candidates: CandidateResult[] = templates.map((tpl) => {
    const path = expandTemplate(tpl, ctx)
    const writable = facts.capabilities.canWrite[path] === true
    return writable
      ? { path, writable }
      : { path, writable, reason: '不可写（只读挂载 / 权限不足 / SELinux）' }
  })

  const hit = candidates.find((c) => c.writable)
  if (hit === undefined) {
    throw new DpError(
      'DP.PATH.NOT_WRITABLE',
      `没有可写的发布目录（已试 ${candidates.length} 个候选）`,
      {
        hint: `候选：${candidates.map((c) => c.path).join(' | ')}。可显式指定 release.root，或让运维授权其中一个目录`,
      },
    )
  }
  return { root: hit.path, explicit: false, candidates }
}

// ------------------------------------------------------------
// 布局推导
// ------------------------------------------------------------

const SYSTEM_PROBE_PATHS = ['/var/lib', '/usr/local', 'C:/ProgramData'] as const

/**
 * 由**实证能力**推导布局，不靠 uid 推断
 *
 * uid 0 不等于有权限：`canWrite` 是建了文件再删掉测出来的，
 * 容器里 root 照样可能只读挂载。凭 uid 判成 system 布局，
 * 后果是 plan 通过而 install 阶段在第一行就失败。
 *
 * @param facts 目标机事实，布局只看 capabilities 里的可写性
 * @returns 'system'（系统目录可写）/ 'hybrid'（需提权）/ 'user'（两者都不行）
 */
export function deriveLayout(facts: Facts): Layout {
  const c = facts.capabilities
  const systemWritable = SYSTEM_PROBE_PATHS.some((p) => c.canWrite[p] === true)
  if (systemWritable) return 'system'
  if (c.sudoAllowlist.length > 0) return 'hybrid'
  return 'user'
}

// ------------------------------------------------------------
// 跨平台路径校验（四条，本机即可查）
// ------------------------------------------------------------

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const WIN_ILLEGAL = /[<>:"|?*\u0000-\u001f]/

const PATH_LIMIT: Readonly<Record<Platform, number>> = {
  win32: 260,
  darwin: 1024,
  linux: 4096,
  freebsd: 4096,
  unknown: 4096,
}

/**
 * 源路径检查。**在传第一个字节之前**发现问题 —— 此时还没有任何副作用。
 *
 *  - `DP.PATH.RESERVED_NAME`  Windows 保留名（`NUL` / `CON` / `aux.txt`）
 *  - `DP.PATH.ILLEGAL_CHAR`   目标平台非法字符
 *  - `DP.PATH.TOO_LONG`       超过目标平台长度上限
 *  - `DP.PATH.CASE_COLLISION` 仅大小写不同的路径，在不敏感平台上会静默互相覆盖
 *
 * @param entries 源里的相对路径清单
 * @param platform **目标机**平台：按源机的平台判非法字符会漏掉目标机才会炸的那些
 * @throws DpError 命中上面四类之一
 */
export function checkSourcePaths(entries: readonly string[], platform: Platform): void {
  const limit = PATH_LIMIT[platform]
  const seen = new Map<string, string>()

  for (const entry of entries) {
    const last = entry.split(/[\\/]/).pop() ?? entry

    if (platform === 'win32') {
      if (WIN_RESERVED.test(last)) {
        throw new DpError('DP.PATH.RESERVED_NAME', `Windows 保留名，落到目标机即废：${entry}`, {
          hint: '重命名该文件或目录',
        })
      }
      if (WIN_ILLEGAL.test(entry)) {
        throw new DpError('DP.PATH.ILLEGAL_CHAR', `含 Windows 非法字符：${entry}`, {
          hint: 'Windows 路径不能包含 < > : " | ? * 与控制字符',
        })
      }
    }

    if (entry.length > limit) {
      throw new DpError('DP.PATH.TOO_LONG', `路径长度 ${entry.length} 超过 ${platform} 上限 ${limit}：${entry}`, {
        hint: '缩短路径，或在 Windows 上启用 LongPathsEnabled',
      })
    }

    if (platform !== 'linux') {
      const key = entry.toLowerCase()
      const previous = seen.get(key)
      if (previous !== undefined && previous !== entry) {
        throw new DpError(
          'DP.PATH.CASE_COLLISION',
          `「${previous}」与「${entry}」在 ${platform} 上会互相覆盖（大小写不敏感）`,
          { hint: '合并或重命名其中一个，否则部署后会静默丢文件' },
        )
      }
      seen.set(key, entry)
    }
  }
}
