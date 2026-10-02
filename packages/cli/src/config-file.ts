/**
 * 配置发现与加载。
 *
 * 优先级（decisions.md §6）：`-c/--config` > `DP_CONFIG` > 自动发现。
 * 冲突时**明确报错**而不是静默选一个 —— 部署工具最贵的 bug 是「我以为用了 prod
 * 配置，其实用了 dev」，而这种静默选择恰好制造它。
 *
 * IO 只在这一个文件里发生。三个函数（discover / load / validate）各自可单测：
 * 纯逻辑（优先级判定、校验、扩展名分流）都是纯函数，只有 stat/readdir/import 是 IO。
 */
import { existsSync, promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, parse as parsePath, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DpError } from '@dp/ports'
import { configSchema, type Config } from '@dp/schema'
import { CliUsageError } from './args.js'

/** 自动发现的文件名，顺序即优先级（ts > js > json：前者能写逻辑，后者最通用） */
export const CONFIG_FILENAMES: readonly string[] = [
  'deploy.config.ts',
  'deploy.config.js',
  'deploy.config.json',
]

export type ConfigSource = 'explicit' | 'env' | 'discovered'

export interface ConfigLocation {
  /** 绝对路径 */
  readonly path: string
  /** 它是被哪一级选中的 */
  readonly source: ConfigSource
}

// ============================================================
// 纯逻辑：扩展名 → 加载方式
// ============================================================

export type ConfigLoaderKind = 'json' | 'module'

export function loaderKindFor(file: string): ConfigLoaderKind {
  return file.endsWith('.json') ? 'json' : 'module'
}

// ============================================================
// 纯逻辑：优先级判定
// ============================================================

export interface ResolveConfigInput {
  /** `-c/--config` 的原样值 */
  readonly explicit?: string
  /** `DP_CONFIG` 环境变量 */
  readonly envValue?: string
  /** 自动发现的结果 */
  readonly discovered?: string
  /** 用来解析相对路径的基准目录 */
  readonly cwd: string
}

/**
 * 三级优先级 + 冲突检测。**纯函数**，不碰文件系统 —— 存在性由调用方查好再传进来。
 *
 * 冲突只在「显式指定」与「自动发现」之间判定：`-c` 存在时用户已经明确表达了
 * 意图，自动发现到的另一个文件不该把它变成错误 —— 但两者**不是同一个文件**时
 * 必须报出来，否则用户会以为在部署 A。
 */
export function resolveConfigPath(input: ResolveConfigInput): ConfigLocation | undefined {
  const { cwd, discovered, envValue, explicit } = input

  const explicitAbs = explicit === undefined ? undefined : resolvePath(cwd, explicit)
  const envAbs = envValue === undefined ? undefined : resolvePath(cwd, envValue)

  if (explicitAbs !== undefined) {
    if (discovered !== undefined && !samePath(discovered, explicitAbs)) {
      throw new DpError('CONFIG_INVALID', `--config 指定的文件与自动发现到的文件不是同一个`, {
        path: '--config',
        hint: `你指定的是 ${explicitAbs}，但从当前目录向上还发现了 ${discovered}。两者都处理掉再跑：要么删掉发现的那个，要么把 --config 指向它`,
      })
    }
    return { path: explicitAbs, source: 'explicit' }
  }

  if (envAbs !== undefined) return { path: envAbs, source: 'env' }
  if (discovered !== undefined) return { path: discovered, source: 'discovered' }
  return undefined
}

/** Windows 大小写不敏感；`realpath` 之外的兜底，避免同文件被判成两个 */
function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => resolvePath(p).replace(/[\\/]+$/, '')
  const x = norm(a)
  const y = norm(b)
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

// ============================================================
// IO：自动发现
// ============================================================

/**
 * 从 cwd 向上冒泡找配置文件，**到 git 根为止**（再往上就是仓库外的家目录，
 * 在那里找到的配置几乎一定是用户搞错了）。
 */
export function findConfigUpwards(cwd: string): string | undefined {
  let dir = resolvePath(cwd)
  const stop = gitRoot(dir)
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
    if (stop !== undefined && samePath(dir, stop)) return undefined
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function gitRoot(from: string): string | undefined {
  let dir = from
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** 找不到任何来源时的统一报错。三种来源都写清楚，用户才知道该做什么。 */
function notFoundError(cwd: string): DpError {
  return new DpError('CONFIG_INVALID', `找不到 deploy-kit 配置文件（从 ${cwd} 向上找到仓库根都没找到）`, {
    path: '--config',
    hint: `按优先级检查这三处：① --config <path> ② 环境变量 DP_CONFIG ③ 在仓库里放一个 ${CONFIG_FILENAMES.join(' / ')}。也可以先跑 \`dp schema > deploy.schema.json\` 看配置长什么样`,
  })
}

// ============================================================
// IO：加载
// ============================================================

/**
 * 读一个配置文件。`.json` 走 readFile + JSON.parse，其余走动态 import。
 *
 * `.ts` 能被 Node 24 原生加载（type stripping），但**只在它是纯 ESM 且不含
 * 需要擦除的类型语法之外的东西**时才成立；失败信息要指向可执行的下一步，
 * 而不是把 node 的原始栈糊给用户。
 */
export async function loadConfigFile(path: string): Promise<unknown> {
  if (loaderKindFor(path) === 'json') {
    let text: string
    try {
      text = await fs.readFile(path, 'utf8')
    } catch (err) {
      throw new DpError('CONFIG_INVALID', `读配置失败：${path}`, {
        path,
        hint: '检查文件是否存在、当前用户是否有读权限',
        cause: err,
      })
    }
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new DpError('CONFIG_INVALID', `配置文件不是合法 JSON：${path}`, {
        path,
        hint: 'JSON 末尾不能有逗号；若是 .ts/.js 想写注释或表达式，改用 deploy.config.ts',
        cause: err,
      })
    }
  }

  try {
    const mod = await import(pathToFileURL(path).href)
    // 允许 `export default {...}` 与 `module.exports = {...}` 两种习惯
    const value = (mod as { default?: unknown }).default ?? mod
    return value
  } catch (err) {
    throw new DpError('CONFIG_INVALID', `加载配置模块失败：${path}`, {
      path,
      hint: '确认文件能被 Node 24 直接加载（.ts 需无 Node 尚不支持的语法）、其中的 import 路径可解析、且没有顶层 await 之外的副作用。Node 说：' + messageOf(err),
      cause: err,
    })
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// ============================================================
// 纯逻辑：校验
// ============================================================

/**
 * 走 @dp/schema 的 configSchema。schema 抛的 DpError 已经带 `path`（形如
 * `config.projects.web.source.root`），直接透传即可 —— 不在这里二次包装，
 * 否则用户会看到两层 message 且丢掉最精确的那个路径。
 */
export function validateConfig(raw: unknown, sourcePath: string): Config {
  try {
    return configSchema.parse(raw, 'config')
  } catch (err) {
    if (err instanceof DpError) {
      throw new DpError(err.code, err.message, {
        path: err.path ?? sourcePath,
        hint:
          err.hint ??
          `配置必须符合 configSchema。跑 \`dp schema > deploy.schema.json\`，把 \$schema 写进 ${sourcePath}，编辑器就会指出第几行错了`,
        cause: err,
      })
    }
    throw err
  }
}

// ============================================================
// 组装：发现 + 加载 + 校验
// ============================================================

export interface LoadConfigOptions {
  readonly cwd: string
  readonly explicit?: string
  readonly env?: NodeJS.ProcessEnv
  /** 显式给定时跳过自动发现（测试用） */
  readonly skipDiscovery?: boolean
}

export interface LoadedConfig {
  readonly config: Config
  readonly path: string
  readonly source: ConfigSource
}

export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const env = options.env ?? process.env
  const explicit = options.explicit

  let explicitAbs: string | undefined
  if (explicit !== undefined) {
    explicitAbs = resolvePath(options.cwd, explicit)
    if (!existsSync(explicitAbs)) {
      throw new DpError('CONFIG_INVALID', `--config 指定的文件不存在：${explicitAbs}`, {
        path: '--config',
        hint: `你给的是 ${explicit}（已按 cwd=${options.cwd} 解析为绝对路径）。确认路径拼写，或去掉 --config 让它自动发现`,
      })
    }
  }

  let envAbs: string | undefined
  const envValue = env['DP_CONFIG']
  if (explicit === undefined && envValue !== undefined && envValue !== '') {
    envAbs = resolvePath(options.cwd, envValue)
    if (!existsSync(envAbs)) {
      throw new DpError('CONFIG_INVALID', `环境变量 DP_CONFIG 指向的文件不存在：${envAbs}`, {
        path: 'DP_CONFIG',
        hint: `DP_CONFIG=${envValue}，按 cwd=${options.cwd} 解析为绝对路径。修正环境变量，或 unset 它改用自动发现`,
      })
    }
  }

  // 给了 -c 也照样要发现一次：只有知道「自动发现会命中谁」，才能判断两者是不是同一个文件。
  // 跳过这步的话，resolveConfigPath 的冲突分支永远走不到 —— 于是「我以为部署的是 prod
  // 配置，其实仓库里那份 dev 才是生效的」这类最贵的事故又变回可能。
  const discovered = options.skipDiscovery === true ? undefined : findConfigUpwards(options.cwd)

  const location = resolveConfigPath({
    cwd: options.cwd,
    explicit,
    envValue: envValue !== undefined && envValue !== '' ? envValue : undefined,
    discovered,
  })
  if (location === undefined) throw notFoundError(options.cwd)
  if (!existsSync(location.path)) throw notFoundError(options.cwd)

  const raw = await loadConfigFile(location.path)
  return { config: validateConfig(raw, location.path), path: location.path, source: location.source }
}

/** `--config` 的相对路径解析：只在 index.ts 用，避免各处各写一遍 isAbsolute 判断 */
export function absolutize(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolvePath(cwd, p)
}

export { fileURLToPath }
