/**
 * 源枚举。
 *
 * 语义必须**无歧义**：
 *
 *   | 写法        | 含义                                   |
 *   |-------------|----------------------------------------|
 *   | `./dist`    | 目录本身 → 目标出现 `<root>/dist/...`   |
 *   | `./dist/**` | 目录内容 → 目标出现 `<root>/...`        |
 *   | `./dist/`   | **报错** —— 尾斜杠在两边都可能，不猜     |
 *
 * 「歧义靠拒绝，不靠默认值」：给它一个默认含义，用户写错时就会静默地放错位置，
 * 而这恰恰是部署中最难排查的一类事故。
 */
import { promises as fs } from 'node:fs'
import { basename, join, resolve as resolvePath, sep } from 'node:path'
import { DpError, type SourceEntry } from '@dp/ports'

export interface SourceSpec {
  /** 归一化后的基目录绝对路径 */
  readonly root: string
  /** `self` = 连目录本身一起放过去；`contents` = 只放里面的东西 */
  readonly mode: 'self' | 'contents'
}

export function normalizeSourceSpec(pattern: string, cwd: string): SourceSpec {
  const trimmed = pattern.trim()
  if (trimmed === '') {
    throw new DpError('CONFIG_INVALID', 'source 不能为空', { path: 'projects.*.source' })
  }
  if (/[\\/]$/.test(trimmed)) {
    throw new DpError('CONFIG_INVALID', `source 不能以路径分隔符结尾：${pattern}`, {
      path: 'projects.*.source',
      hint: '写 "./dist" 表示目录本身，写 "./dist/**" 表示目录内容。尾斜杠两种解释都成立，我们不猜',
    })
  }

  const isContents = trimmed.endsWith('/**') || trimmed.endsWith('\\**')
  const base = isContents ? trimmed.slice(0, -3) : trimmed
  return { root: resolvePath(cwd, base), mode: isContents ? 'contents' : 'self' }
}

/** 枚举源。相对路径一律 `/` 分隔 —— 目标端不一定是同一种文件系统 */
export async function listSourceEntries(spec: SourceSpec): Promise<readonly SourceEntry[]> {
  let stat
  try {
    stat = await fs.stat(spec.root)
  } catch (err) {
    throw new DpError('CONFIG_INVALID', `source 不存在：${spec.root}`, {
      cause: err,
      path: 'projects.*.source',
      hint: '先跑构建，或检查 cwd',
    })
  }

  if (!stat.isDirectory()) {
    const name = basename(spec.root)
    return [
      {
        kind: 'file',
        relativePath: name,
        read: () => fs.readFile(spec.root),
      },
    ]
  }

  const entries: SourceEntry[] = []
  await walk(spec.root, spec.root, spec.mode, entries)
  return entries
}

async function walk(
  root: string,
  dir: string,
  mode: SourceSpec['mode'],
  out: SourceEntry[],
): Promise<void> {
  const items = await fs.readdir(dir, { withFileTypes: true })
  for (const item of items) {
    const abs = join(dir, item.name)
    const rel = slash(abs.slice(root.length + 1))
    const mapName = mode === 'contents' ? rel : slash(`${basename(root)}/${rel}`)

    if (item.isDirectory()) {
      out.push({ kind: 'dir', relativePath: mapName })
      await walk(root, abs, mode, out)
    } else if (item.isFile()) {
      out.push({ kind: 'file', relativePath: mapName, read: () => fs.readFile(abs) })
    } else if (item.isSymbolicLink()) {
      // 软链按它指向的东西搬运，而不是把链接本身搬过去 ——
      // 跨机器时链接目标几乎一定不存在
      try {
        const target = await fs.stat(abs)
        if (target.isDirectory()) await walk(root, abs, mode, out)
        else out.push({ kind: 'file', relativePath: mapName, read: () => fs.readFile(abs) })
      } catch {
        throw new DpError('DP.PATH.NOT_WRITABLE', `软链失效：${abs}`, {
          hint: '修好这个链接，或把它排除出 source',
        })
      }
    }
  }
}

function slash(p: string): string {
  return p.split(sep).join('/')
}
