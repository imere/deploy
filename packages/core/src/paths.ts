/**
 * 路径：模板展开、发布目录候选、跨平台校验。
 *
 * 全部是**纯函数** —— 注入 Facts 即可断言，不需要任何机器。
 */
import { DpError, type Facts, type Layout, type Platform } from '@dp/ports'

// ------------------------------------------------------------
// 模板展开
// ------------------------------------------------------------

export interface TemplateContext {
  readonly name: string
  readonly homedir: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/** 展开 `~` / `$XDG_*` / `%LOCALAPPDATA%` / `%ProgramFiles%` / `<name>` */
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

export interface CandidateResult {
  readonly path: string
  readonly writable: boolean
  /** 跳过原因。plan 必须打印它 —— 只给结果不给理由等于没明示 */
  readonly reason?: string
}

export interface ReleaseRootChoice {
  readonly root: string
  readonly explicit: boolean
  readonly candidates: readonly CandidateResult[]
}

export interface PickReleaseRootInput {
  readonly facts: Facts
  readonly layout: Layout
  readonly name: string
  readonly explicitRoot?: string
}

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

/** 由**实证能力**推导布局，不靠 uid 推断 */
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
