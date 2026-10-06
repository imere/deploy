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

/**
 * 归一化后的源。两字段合起来才是完整语义，`mode` 不能事后补：
 * root 决定从哪读，mode 决定产出的相对路径以谁开头，二者任意一个猜错，
 * 部署都会「成功」而内容放错了位置。
 */
export interface SourceSpec {
  /** 归一化后的基目录绝对路径 */
  readonly root: string
  /** `self` = 连目录本身一起放过去；`contents` = 只放里面的东西 */
  readonly mode: 'self' | 'contents'
}

/**
 * 把配置里的写法收敛成一个不带歧义的源。
 *
 * 为什么**只在这一处**解析：解析规则散到各消费点，就会有地方把 `./dist` 当
 * contents、另一个地方当 self，而两端各自测试都是绿的。故意的报错多于默认值。
 *
 * @param pattern 配置里写的原始串，尾部两个星号（`**`）表示「内容」，尾分隔符一律拒绝
 *   （这里不用「斜杠加两个星号」的写法，是为了让 JSDoc 块里不出现会提前结束块的内容）
 * @param cwd 解析相对路径的基准，一般是配置文件所在目录而非 shell 的 pwd ——
 *   后者会随调用方式变化，让同一份配置在两次运行里指向不同位置
 * @returns 绝对路径 + 模式；不保证 root 存在，存在性留给 listSourceEntries 判定
 * @throws DpError 空串或以路径分隔符结尾（DP.CONFIG.INVALID，path 固定为 `projects.*.source`）
 */
export function normalizeSourceSpec(pattern: string, cwd: string): SourceSpec {
  const trimmed = pattern.trim()
  if (trimmed === '') {
    throw new DpError('DP.CONFIG.INVALID', 'source 不能为空', { path: 'projects.*.source' })
  }
  if (/[\\/]$/.test(trimmed)) {
    throw new DpError('DP.CONFIG.INVALID', `source 不能以路径分隔符结尾：${pattern}`, {
      path: 'projects.*.source',
      hint: '写 "./dist" 表示目录本身，写 "./dist/**" 表示目录内容。尾斜杠两种解释都成立，我们不猜',
    })
  }

  const isContents = trimmed.endsWith('/**') || trimmed.endsWith('\\**')
  const base = isContents ? trimmed.slice(0, -3) : trimmed
  return { root: resolvePath(cwd, base), mode: isContents ? 'contents' : 'self' }
}

/**
 * 枚举源。
 *
 * 相对路径一律 `/` 分隔 —— 目标端不一定是同一种文件系统，交给传输层原样拼路径时
 * 一旦混进 `\` 就会在 Linux 上被当成文件名的一部分，于是「部署成功」而文件少了。
 *
 * @param spec 归一化后的源（由 normalizeSourceSpec 得到）。单个文件按文件处理：
 *   `contents` 模式在文件上没有意义，两个字段组合只有一种可解释的结果
 * @returns 目录的深度优先条目列表（父目录在子条目之前，传输层据此先建目录）；
 *   指向单文件时返回恰好一个条目，`relativePath` 是该文件名本身
 * @throws DpError source 不存在或不是可读路径（DP.CONFIG.INVALID）；
 *   软链指向失效（DP.PATH.NOT_WRITABLE）—— 软链按目标搬运，坏链必须报出来而不是当空目录
 */
export async function listSourceEntries(spec: SourceSpec): Promise<readonly SourceEntry[]> {
  let stat
  try {
    stat = await fs.stat(spec.root)
  } catch (err) {
    throw new DpError('DP.CONFIG.INVALID', `source 不存在：${spec.root}`, {
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
