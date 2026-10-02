import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createContext, type ResolvedFlags } from './run.js'

const BASE: ResolvedFlags = {
  all: false,
  json: false,
  dryRun: true,
  verbose: false,
  quiet: false,
  help: false,
  version: false,
  logFormat: 'pretty',
  logLevel: 'info',
}

/**
 * 这些用例守的是**流的归属**，不是日志内容本身。
 *
 * 为什么值得单独测：`--json` 时 stdout 混进一行日志，`dp plan --json | jq` 就整条管道废掉，
 * 而这类 bug 在手工跑的时候根本看不出来（人眼会自动忽略前面那行 INFO）。
 */
describe('run · 日志出口（--json 时 stdout 必须只有结果）', () => {
  it('--json：日志走 stderr，stdout 一行都没有', () => {
    const out: string[] = []
    const err: string[] = []
    const ctx = createContext({ ...BASE, json: true }, { write: (t) => out.push(t), writeErr: (t) => err.push(t) })
    ctx.logger.info('plan.done', { steps: 8 })
    assert.equal(out.length, 0, `stdout 被日志污染了：${out.join('')}`)
    assert.ok(err.length > 0, '日志应该去 stderr')
  })

  it('非 --json：日志走 stdout（人在终端看）', () => {
    const out: string[] = []
    const err: string[] = []
    const ctx = createContext({ ...BASE }, { write: (t) => out.push(t), writeErr: (t) => err.push(t) })
    ctx.logger.info('plan.done', { steps: 8 })
    assert.ok(out.length > 0, '日志应该在 stdout')
    assert.equal(err.length, 0)
  })

  it('--log-file：真的写进文件，且两个流都不被污染', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'dp-cli-log-'))
    const file = join(dir, 'dp.log')
    try {
      const out: string[] = []
      const err: string[] = []
      const ctx = createContext(
        { ...BASE, json: true, logFile: file },
        { write: (t) => out.push(t), writeErr: (t) => err.push(t) },
      )
      ctx.logger.info('plan.done', { steps: 8 })
      const text = await fs.readFile(file, 'utf8')
      assert.match(text, /plan\.done/, `--log-file 指定的文件里没有日志：${text}`)
      assert.equal(out.length, 0, '有了 --log-file，日志也不许进 stdout')
      assert.equal(err.length, 0, '有了 --log-file，日志也不许进 stderr')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('--log-file 指向不可写的路径时降级到流，而不是把命令搞崩', () => {
    const err: string[] = []
    const ctx = createContext(
      { ...BASE, json: true, logFile: join(tmpdir(), 'no-such-dir-'.padEnd(300, 'x'), 'dp.log') },
      { write: () => {}, writeErr: (t) => err.push(t) },
    )
    // 只要不抛就算过关；降级必须留下痕迹，否则用户会以为日志落盘了其实没有
    ctx.logger.info('plan.done', { steps: 8 })
    assert.ok(err.some((l) => /log-file/.test(l)), `降级时应该说明原因，实际：${err.join('')}`)
  })
})
