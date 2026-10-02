/**
 * 本机复制 —— **不经过任何网络，也不起任何子进程**。
 *
 * 走注入的 `Runner` 而不是 `node:fs`：本包依赖里没有 `@dp/local`（只有
 * ports/log/ssh/core），而且 CLI 手里已经有 `createLocalRunner()` 建好的那个
 * Runner。复用它等于"只有一个本机真相来源"，也不会出现两份探测事实打架。
 *
 * 同样做**空源拒绝**：空清单会让"部署成功"变成一句无法证伪的话。
 */
import { join } from 'node:path'
import { DpError, type Runner } from '@dp/ports'
import type { TransferRequest, TransferResult } from './types.js'

export interface CopyLocalResult {
  readonly files: number
  readonly dirs: number
}

const rel = (root: string, relativePath: string): string => join(root, ...relativePath.split('/'))

export async function copyLocal(
  req: TransferRequest,
  runner: Runner,
): Promise<TransferResult> {
  if (req.entries.length === 0) {
    throw new DpError('DP.SOURCE.EMPTY', '源清单为空，拒绝复制', {
      hint: '构建产物为空，或 include/exclude 把所有文件都排除了',
    })
  }

  // 只给日志与排障看；**不**把真实凭据类字段塞进 command
  const command: readonly string[] = ['<local-runner>', rel(req.localRoot, req.entries[0]!), '→', req.remoteRoot]

  if (req.dryRun === true) {
    return {
      kind: 'local-copy',
      filesTransferred: 0,
      command,
      exitCode: 0,
      warnings: ['--dry-run：未写入任何文件'],
      dryRun: true,
    }
  }

  await runner.mkdir(req.remoteRoot, { recursive: true })

  let files = 0
  let dirs = 0
  const warnings: string[] = []
  // 逐条 writeFile 不会隐式补父目录，所以**按条目的祖先链**去建。
  //
  // 之前这里是「名字里没有点就算目录」的猜测，两个错：① `README`、`Makefile`
  // 这类无扩展名文件会被当成目录建出来；② 真正的父目录（`sub/a.js` 的 `sub`）
  // 反而没建，writeFile 直接 ENOENT。判断「哪些是目录」不该靠文件名猜。
  const ensured = new Set<string>()
  const ensureDir = async (relativeDir: string): Promise<void> => {
    if (relativeDir === '' || ensured.has(relativeDir)) return
    await runner.mkdir(join(req.remoteRoot, ...relativeDir.split('/')), { recursive: true })
    ensured.add(relativeDir)
  }

  for (const entry of req.entries) {
    if (entry.endsWith('/')) {
      await ensureDir(entry.replace(/\/+$/, ''))
      dirs += 1
      continue
    }
    const parts = entry.split('/')
    for (let i = 1; i < parts.length; i += 1) await ensureDir(parts.slice(0, i).join('/'))
    const data = await runner.readBinary(rel(req.localRoot, entry))
    await runner.writeFile(rel(req.remoteRoot, entry), data)
    files += 1
  }

  if (req.deleteExtraneous === true) {
    warnings.push('local-copy 不删除目标上多出来的文件（走 Runner 的逐条写，没有"清空目录"这个动作）')
  }

  return { kind: 'local-copy', filesTransferred: files, command, exitCode: 0, warnings }
}
