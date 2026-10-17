import type { BecomeConfig } from '@dp/ports'
import { quoteArg, wrapCommand } from '@dp/ssh'
import { runProcess, type RunProcessResult } from './proc.js'
import { buildRshArgv, type RshOptions } from './rsh.js'
import type { SpawnImpl } from './types.js'

/**
 * 按父目录把条目分组。rsync / scp 的「多源一目的」形态只保每个文件的 basename，
 * 嵌套条目的路径会被拍平成 `assets/app.js` → `<dest>/app.js` —— 真机实测如此
 * （rsync 3.2.7，多条显式文件源只往同一个目的目录放 basename）。所以以父目录为
 * 单位分组，每组用自己的目的目录发一条；平铺清单恰好一组，argv 形态不变。
 */
export interface EntryGroup {
  /** 相对 remoteRoot 的父目录，空串表示 remoteRoot 本身 */
  readonly dir: string
  /** 该组要传的文件路径（相对 localRoot） */
  readonly files: readonly string[]
}

export function groupByParentDir(entries: readonly string[]): readonly EntryGroup[] {
  const map = new Map<string, string[]>()
  for (const entry of entries) {
    const i = entry.lastIndexOf('/')
    const dir = i === -1 ? '' : entry.slice(0, i)
    const list = map.get(dir)
    if (list === undefined) map.set(dir, [entry])
    else list.push(entry)
  }
  // Map 保插入序，而入参清单有序（来源侧已排序）—— 产出随之确定，不靠运气
  return [...map.entries()].map(([dir, files]) => ({ dir, files }))
}

/**
 * 需要先在远端建出来的**嵌套**目的目录（绝对路径）。
 * remoteRoot 本身不算 —— rsync / scp 会自己建目的串的最后一段；
 * 缺的只是中间层，而 `mkdir -p` 一条命令补齐全部。
 */
export function nestedDirs(input: { readonly entries: readonly string[]; readonly remoteRoot: string }): readonly string[] {
  const root = input.remoteRoot.replace(/\/+$/, '')
  return [
    ...new Set(
      groupByParentDir(input.entries)
        .map((g) => g.dir)
        .filter((d) => d !== '')
        .map((d) => `${root}/${d}`),
    ),
  ]
}

/**
 * rsync / scp 都没有「远端 mkdir」的位置，嵌套目的目录只能用自己的 ssh 通道先建。
 *
 * 远端命令必须拼成**一条字符串**：ssh 不壳引其余 argv，`ssh host mkdir -p a b`
 * 到了远端 shell 就是四个词 —— 路径带空格必炸。逐段过 `quoteArg` 再 join，
 * 让远端 shell 看到的仍然是一个词一段路径。
 */
export function buildSshMkdirArgv(input: {
  readonly rsh: RshOptions
  readonly remoteTarget: string
  readonly dirs: readonly string[]
  readonly become?: BecomeConfig
}): readonly string[] {
  const inner = ['mkdir', '-p', ...input.dirs]
  const wrapped =
    input.become === undefined || input.become.type === 'none' ? inner : wrapCommand(inner, input.become)
  // buildRshArgv 产出 ssh 本体 + 连接选项（含 -J 跳板链），正合单独一条 ssh 用
  return [...buildRshArgv(input.rsh), input.remoteTarget, wrapped.map(quoteArg).join(' ')]
}

export async function ensureRemoteDirs(
  argv: readonly string[],
  options: { readonly timeoutMs?: number; readonly spawnImpl?: SpawnImpl } = {},
): Promise<RunProcessResult> {
  return runProcess(argv, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
    label: 'ssh',
  })
}
