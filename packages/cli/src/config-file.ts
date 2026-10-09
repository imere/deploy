/**
 * 配置发现与加载。
 *
 * 优先级：`-c/--config` > `DP_CONFIG` > 自动发现。
 * 冲突时**明确报错**而不是静默选一个 —— 部署工具最贵的 bug 是「我以为用了 prod
 * 配置，其实用了 dev」，而这种静默选择恰好制造它。
 *
 * IO 只在这一个文件里发生。三个函数（discover / load / validate）各自可单测：
 * 纯逻辑（优先级判定、校验、扩展名分流）都是纯函数，只有 stat/readdir/import 是 IO。
 */
import { existsSync, promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DpError } from '@dp/ports'
import { configSchema, type Config, type ProjectConfig } from '@dp/schema'

/** 自动发现的文件名，顺序即优先级（ts > js > json：前者能写逻辑，后者最通用） */
export const CONFIG_FILENAMES: readonly string[] = [
  'deploy.config.ts',
  'deploy.config.js',
  'deploy.config.json',
]

/**
 * 生效配置的来源。三态而不是布尔 `explicit`：
 * 「用户显式指定的」与「环境里继承来的」在用户心里的份量不同 ——
 * 后者常常是 CI 镜像里烤进去的，用户根本没意识到它存在。所以这个值会进
 * 报告与帮助里，让人能看出「这次到底是谁定的」。
 */
export type ConfigSource = 'explicit' | 'env' | 'discovered'

/**
 * 配置文件的位置，外加它是被哪一级选中的。
 *
 * 为什么要带 `source` 而不只给一个路径：三级来源里「显式 --config」与「镜像里烤进去的
 * discovered」在盘上长得一模一样，只报路径的话，用户看到配置不生效时无从判断该改命令行
 * 还是改镜像。来源级别让报告能直接说「这次是谁定的」。
 */
export interface ConfigLocation {
  /** 绝对路径。相对路径在这里就该已经解完，下游不必再拼接 cwd */
  readonly path: string
  /** 它是被哪一级选中的 */
  readonly source: ConfigSource
}

// ============================================================
// 纯逻辑：扩展名 → 加载方式
// ============================================================

/**
 * 两种加载方式，判据只有扩展名。
 *
 * 为什么不看内容：`deploy.config.js` 里写 JSON 是合法的（很多人就这么干），
 * 而 `.json` 文件里带注释则不是。按内容判会让同一个文件在不同 Node 版本上
 * 走不同分支，而分支差异体现在「报错来自 JSON.parse 还是 import」上 ——
 * 用户看到的是两条毫不相干的错误，却实际是同一个配置问题。
 */
export type ConfigLoaderKind = 'json' | 'module'

/**
 * 扩展名 → 加载方式。**纯函数**。
 *
 * @param file 配置文件路径，不要求存在、大小写敏感
 * @returns `.json` 结尾（含 `.JSON` 这类写法不算）走 json，其余一律 module
 */
export function loaderKindFor(file: string): ConfigLoaderKind {
  return file.endsWith('.json') ? 'json' : 'module'
}

// ============================================================
// 纯逻辑：优先级判定
// ============================================================

/**
 * 优先级判定的全部输入。
 *
 * 三个来源各占一个字段而不是收成数组：数组会逼调用方自己排序，而
 * 「谁在前」是这个函数唯一的业务事实 —— 写成顺序依赖数组，某个调用方
 * 少传一项时优先级就悄悄变了，而编译期毫无提示。
 */
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
 *
 * `DP_CONFIG` 不参与冲突判定：它是环境级的隐式配置，本来就可能与仓库里那份
 * 指向不同环境，把它变成硬错误会在 CI 里拦住大量本来正确的运行。
 *
 * @param input 三个来源 + 解析相对路径用的基准目录
 * @returns 选中的绝对路径与来源；三者皆无时为 undefined（**不**抛错 ——
 *   「没找到配置」的错误要由调用方给出，因为那里才知道该提示哪几处候选）
 * @throws DpError `DP.CONFIG.INVALID` 显式指定与自动发现指向不同文件
 */
export function resolveConfigPath(input: ResolveConfigInput): ConfigLocation | undefined {
  const { cwd, discovered, envValue, explicit } = input

  const explicitAbs = explicit === undefined ? undefined : resolvePath(cwd, explicit)
  const envAbs = envValue === undefined ? undefined : resolvePath(cwd, envValue)

  if (explicitAbs !== undefined) {
    if (discovered !== undefined && !samePath(discovered, explicitAbs)) {
      throw new DpError('DP.CONFIG.INVALID', `--config 指定的文件与自动发现到的文件不是同一个`, {
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
 *
 * 每层内部按 `CONFIG_FILENAMES` 的顺序挑，不做「哪个更新」的比较 ——
 * 时间戳比较在 checkout、缓存恢复、容器分层拷贝之后都不再代表用户的意图。
 *
 * @param cwd 起点目录，可以是相对路径
 * @returns 第一个命中的**绝对**路径；一路到文件系统根都没找到则为 undefined
 *   （不抛错：还没到能区分「没配」与「配错了」的时候）
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
  return new DpError('DP.CONFIG.INVALID', `找不到 deploy-kit 配置文件（从 ${cwd} 向上找到仓库根都没找到）`, {
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
 *
 * 只做**加载**，不校验也不归一化：校验错误要带配置内的字段路径（`projects.web.…`），
 * 而这里还没有 sourcePath 之外的上下文；两者分开后，校验可以纯函数化。
 *
 * @param path 配置文件的绝对路径
 * @returns 模块的 default 导出；`module.exports = {...}` 形态时返回整个 module 对象
 * @throws DpError 读文件失败 / JSON 语法错 / 模块加载失败，三者的 hint 各自指向不同的修复动作
 */
export async function loadConfigFile(path: string): Promise<unknown> {
  if (loaderKindFor(path) === 'json') {
    let text: string
    try {
      text = await fs.readFile(path, 'utf8')
    } catch (err) {
      throw new DpError('DP.CONFIG.INVALID', `读配置失败：${path}`, {
        path,
        hint: '检查文件是否存在、当前用户是否有读权限',
        cause: err,
      })
    }
    try {
      return JSON.parse(text)
    } catch (err) {
      throw new DpError('DP.CONFIG.INVALID', `配置文件不是合法 JSON：${path}`, {
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
    throw new DpError('DP.CONFIG.INVALID', `加载配置模块失败：${path}`, {
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
 *
 * **纯函数**（除抛错外无副作用）：默认值在这里被填上，所以下游拿到的
 * 一定是归一化形态，不必再各自判 undefined。
 *
 * @param raw loadConfigFile 的原样产物，不要求是对象
 * @param sourcePath 配置文件路径，仅在 schema 没能给出更精确的字段路径时兜底
 * @returns 通过校验的配置；带 schema 的默认值，release.root **未**绝对化
 * @throws DpError 保留 schema 的 code 与 path
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
          `配置必须符合 configSchema。跑 \`dp schema > deploy.schema.json\`，把 $schema 写进 ${sourcePath}，编辑器就会指出第几行错了`,
        cause: err,
      })
    }
    throw err
  }
}

// ============================================================
// 组装：发现 + 加载 + 校验
// ============================================================

/**
 * 发现 + 加载 + 校验的输入。`env` 可注入是为了让「环境里烤着 DP_CONFIG」
 * 这条路径能被单测覆盖，而不真的去改 process.env（改了会污染同进程里的其他测试）。
 */
export interface LoadConfigOptions {
  readonly cwd: string
  readonly explicit?: string
  readonly env?: NodeJS.ProcessEnv
  /** 显式给定时跳过自动发现（测试用） */
  readonly skipDiscovery?: boolean
}

/**
 * 一份已加载并过校验的配置，连同伴生的出处信息。
 *
 * 为什么配置与出处要一起返回而不是只返回配置：下游写报告、写 `dp config show` 都要说清
 * 「这次用的是哪个文件、谁定的」，而等到了下游再回头找，出处已经丢了（尤其 discovered
 * 那一级，路径是搜索出来的，不记下来就再也复现不出同一个结果）。
 */
export interface LoadedConfig {
  /** 已过 schema 校验，且 `release.root` 已绝对化（`source.root` 保持原样） */
  readonly config: Config
  /** 绝对路径，与 `config` 的来源同一个文件 */
  readonly path: string
  readonly source: ConfigSource
}

/**
 * 一次到位：定来源 → 读文件 → 校验 → 归一化 release.root。**这里是 config-file 里唯一的编排点。**
 *
 * 顺序上刻意把「存在性检查」放在「加载」之前：让用户先看到「文件不存在」，
 * 而不是拿到一段 import 失败栈。两者都是错，但后者看不出是自己路径打错了。
 *
 * @param options cwd 必给，其余按需
 * @returns 归一化后的配置及其来源；`release.root` 已相对 cwd 绝对化
 * @throws DpError 任一来源指向不存在的文件、两处来源冲突、schema 校验不过
 */
export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const env = options.env ?? process.env
  const explicit = options.explicit

  let explicitAbs: string | undefined
  if (explicit !== undefined) {
    explicitAbs = resolvePath(options.cwd, explicit)
    if (!existsSync(explicitAbs)) {
      throw new DpError('DP.CONFIG.INVALID', `--config 指定的文件不存在：${explicitAbs}`, {
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
      throw new DpError('DP.CONFIG.INVALID', `环境变量 DP_CONFIG 指向的文件不存在：${envAbs}`, {
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
  return {
    config: withAbsoluteReleaseRoots(validateConfig(raw, location.path), options.cwd),
    path: location.path,
    source: location.source,
  }
}

/**
 * 把 `release.root` 归一化成绝对路径。
 *
 * 两条理由，都是踩出来的：
 * ① **探测的 key 必须与查询的 key 是同一个字符串**。能力探测往
 *    `canWrite[<root>]` 里写结论，`pickReleaseRoot` 又按 `project.release.root`
 *    去查它。一个写相对、一个查绝对（或反过来）就会得出「不可写」这种
 *    莫名其妙的结论 —— 而实际上目录好得很。
 * ② **打印出来的发布根必须是能直接 cd 进去的**。`./srv` 出现在日志和 JSON 里，
 *    读者没法知道它相对的是哪儿。
 *
 * 只动 release.root：`source.root` 的相对语义由 `@dp/local` 的
 * normalizeSourceSpec 按 cwd 解析（构建产物本来就该相对你跑命令的地方）。
 */
function withAbsoluteReleaseRoots(config: Config, cwd: string): Config {
  const projects: Record<string, ProjectConfig> = {}
  for (const [name, project] of Object.entries(config.projects)) {
    // 用局部变量承接：直接写 `project.release?.root === undefined` 时 TS 不会把
    // project.release 收窄成非 undefined，展开出来的 keep / switchStrategy 就都变成可选
    const release = project.release
    projects[name] =
      release?.root === undefined
        ? project
        : { ...project, release: { ...release, root: absolutize(release.root, cwd) } }
  }
  return { ...config, projects }
}

/**
 * `--config` 的相对路径解析：只在 index.ts 用，避免各处各写一遍 isAbsolute 判断。
 *
 * **不做展开**（`~`、环境变量都不认）：命令行里的路径是用户敲进来的字面量，
 * 而 shell 在多数情况下已经展开过一次；dp 再展开一次会让「配置文件里写的相对
 * 路径是相对谁」这个问题在两个不同基准之间漂移。
 *
 * @param p 用户写的路径，可以是绝对或相对
 * @param cwd 相对路径的基准目录
 * @returns 绝对路径；已是绝对的原样返回（不做归一化，`..` 保留）
 */
export function absolutize(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolvePath(cwd, p)
}

export { fileURLToPath }
