import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createFileSink, createLineSink, createMemorySink, createStdoutSink, describeError } from './sink.js'
import type { LogRecord } from '@dp/ports'

/** 临时替换 stderr.write 捕获兜底告警，测完必须还原（否则整个 runner 的输出都被吞） */
let originalWrite: typeof process.stderr.write
const captured: string[] = []

function captureStderr(): void {
  captured.length = 0
  originalWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }) as typeof process.stderr.write
}

function restoreStderr(): void {
  process.stderr.write = originalWrite
}

afterEach(() => {
  if (originalWrite !== undefined) restoreStderr()
  captured.length = 0
})

const rec: LogRecord = { ts: '2026-10-02T07:00:00.000Z', level: 'info', msg: 'x' }

describe('sink', () => {
  it('createLineSink 补上行终止符——JSONL 的"一行一条"不能靠自觉', () => {
    const got: string[] = []
    createLineSink((l) => got.push(l)).write('a', rec)
    assert.deepEqual(got, ['a\n'])
  })

  it('createLineSink：out 抛错 → 吞掉并走 stderr 兜底', () => {
    captureStderr()
    const sink = createLineSink(() => {
      throw new Error('磁盘满了')
    })
    assert.doesNotThrow(() => sink.write('a', rec))
    assert.equal(captured.length, 1)
    assert.ok(captured[0]!.startsWith('[dp/log] '))
    assert.ok(captured[0]!.includes('磁盘满了'))
  })

  it('createMemorySink 收集 lines 与 records，可 clear', () => {
    const sink = createMemorySink()
    sink.write('line-1', rec)
    sink.write('line-2', { ...rec, msg: 'y' })
    assert.deepEqual([...sink.lines], ['line-1', 'line-2'])
    assert.equal(sink.records.length, 2)
    assert.equal(sink.records[1]!.msg, 'y')
    sink.clear()
    assert.equal(sink.lines.length, 0)
    assert.equal(sink.records.length, 0)
  })

  it('createFileSink 追加写并由 flush 排空', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dp-log-'))
    try {
      const path = join(dir, 'a.log')
      const sink = createFileSink(path)
      sink.write('one', rec)
      sink.write('two', rec)
      await sink.flush?.()
      assert.equal(await readFile(path, 'utf8'), 'one\ntwo\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('createFileSink：路径不可写时吞掉并告警，不冒泡', async () => {
    captureStderr()
    const sink = createFileSink(join(tmpdir(), 'dp-log-no-such-dir', 'x.log'))
    assert.doesNotThrow(() => sink.write('one', rec))
    await assert.doesNotReject(async () => {
      await sink.flush?.()
    })
    assert.equal(captured.length, 1)
    assert.ok(captured[0]!.includes('[dp/log] '))
  })

  it('createStdoutSink 真的走 process.stdout.write', () => {
    // 必须把 stdout 拦下来：测试运行器自己就在用 stdout 写 TAP，
    // 往里插一个换行会让 reporter 解析错乱（表现为随机 fail）。
    const original = process.stdout.write
    const seen: string[] = []
    process.stdout.write = ((chunk: string | Uint8Array) => {
      seen.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
      return true
    }) as typeof process.stdout.write
    try {
      createStdoutSink().write('line', rec)
    } finally {
      process.stdout.write = original
    }
    assert.deepEqual(seen, ['line\n'])
  })

  it('describeError 覆盖 Error / string / 其它，且对恶毒对象不炸', () => {
    assert.equal(describeError(new Error('boom')), 'Error: boom')
    assert.equal(describeError('plain'), 'plain')
    assert.equal(describeError(42), '42')
    const evil = {
      toString(): string {
        throw new Error('toString 炸了')
      },
    }
    assert.equal(describeError(evil), '<unprintable>')
  })
})
