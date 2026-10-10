import { join } from 'node:path'
import { DpError, type Runner } from '@dp/ports'
import type { TransferRequest, TransferResult } from './types.js'

const rel = (root: string, relativePath: string): string => join(root, ...relativePath.split('/'))

/**
 * 本地复制：**不起任何子进程，也不碰网络**。
 *
 * @param req 传输声明。`entries` 为空直接报 DP.SOURCE.EMPTY —— 空清单会让
 * 「部署成功」变成一句无法证伪的话
 * @param runner 落盘通道，由调用方注入（本包零依赖 @dp/local，只认 ports 的 Runner 接口）
 * @returns 复制结果。`command` 是一行**给人看的说明**，不是 argv —— 本地没有 argv
 * @throws DpError DP.SOURCE.EMPTY；写失败由注入的 Runner 抛（DP.PATH.NOT_WRITABLE）
 */
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
  const warnings: string[] = []
  // 逐条 writeFile 不会隐式补父目录，所以**按条目的祖先链**去建。
  const ensured = new Set<string>()
  const ensureDir = async (relativeDir: string): Promise<void> => {
    if (relativeDir === '' || ensured.has(relativeDir)) return
    await runner.mkdir(join(req.remoteRoot, ...relativeDir.split('/')), { recursive: true })
    ensured.add(relativeDir)
  }

  for (const entry of req.entries) {
    if (entry.endsWith('/')) {
      await ensureDir(entry.replace(/\/+$/, ''))
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
