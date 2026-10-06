/**
 * 零配置需要的那几项「cwd 到底是什么样」—— **读盘**，但只读不写、也不起子进程。
 *
 * 与 `zero-config.ts` 分成两个文件是硬约束：那边必须保持零 IO，否则
 * `deriveZeroConfig()` 的纯函数测试就不成立了。合并两边的后果是探测函数开始
 * 依赖真实文件系统，于是「给一组 entries 就能断言结论」这件事再也做不到 ——
 * 而那正是最值得反复断言的部分。
 *
 * 同步 API 是刻意的：调用方只有一处（deploy 命令），异步化只会多一层 await
 * 而没有任何并发收益。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { DpError } from '@dp/ports'
import { SOURCE_ROOT_CANDIDATES } from './zero-config.js'

/** 源条目上限。超过就报错而不是截断 */
const MAX_ENTRIES = 2000

/**
 * 这两个目录永远不是源根候选，也不是源内容。
 *
 * `node_modules` 是依赖树（几十万条目，且里面确实有 `index.html` 之类的文件 ——
 * 留着它会让探测看到一个与你的项目无关的 static 证据）；`.git` 同理。
 */
const EXCLUDED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git'])

/**
 * 零配置装配需要的全部「cwd 到底是什么样」。
 *
 * 字段与 `zero-config.ts` 的输入**逐个对应**且不多不少：多一个字段就得在
 * 纯函数那边加一个必填项，少一个则探测结论少一块证据 —— 两边不对齐时
 * 编译期毫无提示，只在「改了探测却忘了改装配」之后表现为一次诡异的部署。
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
 *
 * 推不出来就报错：拿 `''` 当项目名会让下游的路径、compose 项目名、release
 * 目录名全部变成一个不可见的空串，错误要等到远端某条命令的参数为空时才炸，
 * 那时已经没有任何线索指回「你的 cwd 没有名字」。
 */
function projectNameOf(cwd: string): string {
  const abs = resolve(cwd)
  const name = basename(abs)
  if (name === '' || name === '.' || name === '..' || name === '/' || abs === name) {
    throw new DpError('DP.CONFIG.INVALID', `从路径推不出项目名：${abs}`, {
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
 *
 * 目录条目不进清单：探测只看文件名，而 `SourceEntry` 的目录条目由 apply 那层
 * 按 relativePath 补齐（见 apply.ts 的 withParentDirs）—— 这里补一份等于
 * 造第二个来源。
 *
 * 软链不进清单也不递归：`Dirent.isDirectory()` 对软链返回 false，所以软链目录
 * 会被整体跳过。跟随它可能绕成环，递归一次就是一个挂住的进程。
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
        // 「以为它是 static」与「它是 compose」只差一个没被看到的文件名
        throw new DpError('DP.CONFIG.INVALID', `源目录条目超过 ${MAX_ENTRIES} 个：${root}`, {
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
 *
 * 解析失败**报错**而不是当成「没有 scripts」：scripts 里的 `deploy` 是一条
 * delegate 证据，静默吞掉解析错误等于让探测少看一个信号却不告诉任何人。
 */
function packageScriptsOf(cwd: string, projectName: string): readonly string[] {
  const path = join(cwd, 'package.json')
  if (!existsSync(path)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new DpError('DP.CONFIG.INVALID', `package.json 解析失败：${path}`, {
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
 * 读齐零配置装配需要的全部事实。**读盘，不写盘，不起子进程。**
 *
 * 找不到源根时**不**在这里报错：`entries` 就是空的，源根由 `deriveZeroConfig`
 * 用同一张候选表去挑并给出带候选名的错误 —— 两处各挑一次就会有两份「源根在哪」
 * 的判据，而它们迟早会不一致。
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
    packageScripts: packageScriptsOf(cwd, projectName),
  }
}
