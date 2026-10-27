import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { ERR, DpError } from '@dp/ports'
import { SOURCE_ROOT_CANDIDATES } from './zero-config.js'

/** 源条目上限。超过就报错而不是截断 */
const MAX_ENTRIES = 2000

/**
 * 这两个目录永远不是源根候选，也不是源内容。
 */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git'])

/**
 * 零配置装配需要的全部「cwd 到底是什么样」。
 */
export interface ProjectFacts {
  readonly projectName: string
  /** cwd 下**一层**目录名（相对 cwd） */
  readonly existingDirs: readonly string[]
  /** 源根下的相对文件路径，如 `index.html` / `assets/app.js` */
  readonly entries: readonly string[]
  /** package.json 的 scripts 键名；没有 package.json 就是空数组 */
  readonly packageScripts: readonly string[]
}

/**
 * 项目名 = cwd 的 basename。
 */
function projectNameOf(cwd: string): string {
  const abs = resolve(cwd)
  const name = basename(abs)
  if (name === '' || name === '.' || name === '..' || name === '/' || abs === name) {
    throw new DpError(ERR.CONFIG.INVALID, `从路径推不出项目名：${abs}`, {
      path: 'projects',
      hint:
        '零配置用当前目录名当项目名。cd 到项目目录下再跑，或用 --config 给一份配置显式写 projects.<name>',
    })
  }
  return name
}

/** 只读一层。返回存在的目录名，保持 readdir 返回的相对顺序（调用方按候选表顺序挑） */
function existingDirsOf(cwd: string): readonly string[] {
  const out: string[] = []
  for (const entry of readdirSync(cwd, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (EXCLUDED_DIRS.has(entry.name)) continue
    out.push(entry.name)
  }
  return out
}

/** 平台分隔符统一成正斜杠：探测按 basename 与路径段匹配，两种平台必须逐字相同 */
function toRelative(root: string, abs: string): string {
  return abs.slice(root.length).replace(/^[\\/]+/, '').split(/[\\/]+/).join('/')
}

/**
 * 递归列出源根下的**文件**（不含目录条目）。
 */
function entriesUnder(cwd: string, root: string, projectName: string): readonly string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_DIRS.has(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!entry.isFile()) continue
      out.push(toRelative(root, abs))
      if (out.length > MAX_ENTRIES) {
        // 截断会让探测基于一部分证据下结论，而那比报错更难查：
        throw new DpError(ERR.CONFIG.INVALID, `源目录条目超过 ${MAX_ENTRIES} 个：${root}`, {
          path: `projects.${projectName}.source`,
          hint:
            '探测目标类型要看完整的源清单，看到一半会得出错误结论。用 --config 显式写 source.root / ' +
            'source.include 收窄范围，或 --exclude 排掉与部署无关的大目录',
        })
      }
    }
  }
  walk(root)
  return out.sort()
}

/**
 * package.json 的 scripts 键名。
 */
function packageScriptsOf(cwd: string): readonly string[] {
  const path = join(cwd, 'package.json')
  if (!existsSync(path)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new DpError(ERR.CONFIG.INVALID, `package.json 解析失败：${path}`, {
      path: `${path}#scripts`,
      hint:
        'JSON 末尾不能有逗号、不能用注释。dp 只读它来探测目标类型（scripts.deploy 是一条证据）—— ' +
        '修好它，或删掉它并用 --config 显式写 target.type',
      cause: err,
    })
  }
  if (raw === null || typeof raw !== 'object') return []
  const scripts = (raw as { readonly scripts?: unknown }).scripts
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return []
  return Object.keys(scripts as Record<string, unknown>)
}

/**
 * 读齐零配置装配需要的全部事实。**读盘，不写盘，不起子进程。**找不到源根时**不**在这里报错：`entries` 就是空的，源根由 `deriveZeroConfig`用同一张候选表去挑并给出带候选名的错误 —— 两处各挑一次就会有两份「源根在哪」的判据，而它们迟早会不一致。
 *
 * @param cwd 起点目录；项目名取它的 basename
 * @returns 项目名、cwd 下的一层目录名、源根下的文件清单、package.json 的 scripts 名
 * @throws DpError 推不出项目名、源条目超上限、package.json 解析失败
 */

export function collectProjectFacts(cwd: string): ProjectFacts {
  const projectName = projectNameOf(cwd)
  const existingDirs = existingDirsOf(cwd)
  const root = SOURCE_ROOT_CANDIDATES.find((dir) => existingDirs.includes(dir))

  return {
    projectName,
    existingDirs,
    entries: root === undefined ? [] : entriesUnder(cwd, join(cwd, root), projectName),
    packageScripts: packageScriptsOf(cwd),
  }
}
