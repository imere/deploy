import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FIXED_FIELDS, LOG_FORMATS, formatJson, formatLogfmt, formatPretty, formatRecord, orderedEntries } from './format.js'
import type { LogRecord } from '@dp/ports'

const base: LogRecord = { ts: '2026-10-02T07:00:00.000Z', level: 'info', msg: 'transfer.begin' }

describe('format / json', () => {
  it('固定字段按 FIXED_FIELDS 顺序在前，自定义字段按插入顺序在后', () => {
    const rec: LogRecord = {
      bytes: 1024,
      level: 'info',
      ts: '2026-10-02T07:00:00.000Z',
      host: 'web-01',
      msg: 'transfer.begin',
      attempt: 1,
    }
    assert.equal(
      formatJson(rec),
      '{"ts":"2026-10-02T07:00:00.000Z","level":"info","msg":"transfer.begin","host":"web-01","attempt":1,"bytes":1024}',
    )
  })

  it('undefined 的固定字段不输出', () => {
    assert.equal(formatJson(base), '{"ts":"2026-10-02T07:00:00.000Z","level":"info","msg":"transfer.begin"}')
  })

  it('null 字段也不输出', () => {
    const rec = { ...base, host: null, phase: undefined } as unknown as LogRecord
    assert.equal(formatJson(rec), '{"ts":"2026-10-02T07:00:00.000Z","level":"info","msg":"transfer.begin"}')
  })

  it('单行：值里的换行被转义', () => {
    const line = formatJson({ ...base, note: 'a\nb' })
    assert.ok(!line.includes('\n'), 'JSONL 不许真换行')
    assert.equal(line.includes('\\n'), true)
  })

  it('示例行逐字符一致', () => {
    const rec: LogRecord = {
      ts: '2026-10-02T07:00:00.000Z',
      level: 'info',
      msg: 'transfer.begin',
      deployId: 'd-7f3a',
      host: 'web-01',
      phase: 'transfer',
      span: 's-2',
      attempt: 1,
      bytes: 1048576,
    }
    assert.equal(
      formatJson(rec),
      '{"ts":"2026-10-02T07:00:00.000Z","level":"info","msg":"transfer.begin","deployId":"d-7f3a","host":"web-01","phase":"transfer","span":"s-2","attempt":1,"bytes":1048576}',
    )
  })
})

describe('format / logfmt', () => {
  it('简单字段不加引号', () => {
    assert.equal(
      formatLogfmt({ ...base, host: 'web-01', bytes: 1048576 }),
      'ts=2026-10-02T07:00:00.000Z level=info msg=transfer.begin host=web-01 bytes=1048576',
    )
  })

  it('空格 / 引号 / 反斜杠 / 等号 触发引号与转义', () => {
    assert.equal(formatLogfmt({ ...base, note: 'has space' }), 'ts=2026-10-02T07:00:00.000Z level=info msg=transfer.begin note="has space"')
    assert.equal(formatLogfmt({ ...base, note: 'say "hi"' }), 'ts=2026-10-02T07:00:00.000Z level=info msg=transfer.begin note="say \\"hi\\""')
    assert.equal(formatLogfmt({ ...base, note: 'back\\slash' }), 'ts=2026-10-02T07:00:00.000Z level=info msg=transfer.begin note="back\\\\slash"')
    assert.equal(formatLogfmt({ ...base, note: 'k=v' }), 'ts=2026-10-02T07:00:00.000Z level=info msg=transfer.begin note="k=v"')
  })

  it('嵌套对象/数组走 JSON 紧凑串再按规则加引号', () => {
    assert.equal(
      formatLogfmt({ ...base, detail: { a: 1 } }),
      'ts=2026-10-02T07:00:00.000Z level=info msg=transfer.begin detail="{\\"a\\":1}"',
    )
    assert.equal(
      formatLogfmt({ ...base, list: [1, 2] }),
      'ts=2026-10-02T07:00:00.000Z level=info msg=transfer.begin list="[1,2]"',
    )
  })

  it('null 输出为 null 字面量', () => {
    assert.ok(formatLogfmt({ ...base, extra: null } as LogRecord).endsWith('msg=transfer.begin'))
  })
})

describe('format / pretty', () => {
  it('时间只取 T 之后、截到毫秒、去掉 Z', () => {
    assert.equal(formatPretty(base), '07:00:00.000 INFO  transfer.begin')
  })

  it('level 右对齐补齐到 5 字符（EVENT 名才会成列）', () => {
    assert.ok(formatPretty({ ...base, level: 'warn' }).startsWith('07:00:00.000 WARN  '))
    assert.ok(formatPretty({ ...base, level: 'error' }).startsWith('07:00:00.000 ERROR '))
    assert.ok(formatPretty({ ...base, level: 'debug' }).startsWith('07:00:00.000 DEBUG '))
    assert.ok(formatPretty({ ...base, level: 'trace' }).startsWith('07:00:00.000 TRACE '))
  })

  it('字段以两个空格分隔，整体 logfmt 风格', () => {
    assert.equal(
      formatPretty({ ...base, host: 'web-01', bytes: 1048576 }),
      '07:00:00.000 INFO  transfer.begin  host=web-01 bytes=1048576',
    )
  })

  it('非 ISO 的 ts 原样返回，不做无依据猜测', () => {
    assert.ok(formatPretty({ ...base, ts: 'not-a-date' }).startsWith('not-a-date '))
    assert.ok(formatPretty({ ...base, ts: '2026-10-02T07:00:00.000+08:00' }).startsWith('07:00:00.000 '))
  })

  it('无额外字段时不留尾随空格', () => {
    assert.equal(formatPretty(base), '07:00:00.000 INFO  transfer.begin')
  })
})

describe('format / 分发与顺序', () => {
  it('formatRecord 按 format 分发', () => {
    assert.equal(formatRecord(base, 'json'), formatJson(base))
    assert.equal(formatRecord(base, 'logfmt'), formatLogfmt(base))
    assert.equal(formatRecord(base, 'pretty'), formatPretty(base))
    assert.deepEqual([...LOG_FORMATS], ['json', 'pretty', 'logfmt'])
  })

  it('未知 format 退回 json（JS 调用方传脏值也不炸）', () => {
    assert.equal(formatRecord(base, 'nope' as 'json'), formatJson(base))
  })

  it('orderedEntries：固定在前、自定义在后，undefined/null 剔除', () => {
    const entries = orderedEntries({ ...base, host: 'h', span: 's1', z: 1, a: undefined })
    assert.deepEqual(
      entries.map(([k]) => k),
      ['ts', 'level', 'msg', 'host', 'span', 'z'],
    )
    assert.deepEqual([...FIXED_FIELDS], ['ts', 'level', 'msg', 'deployId', 'host', 'phase', 'span', 'attempt'])
  })

  it('确定性：同一 record 两次格式化完全一致（黄金快照的前提）', () => {
    const rec: LogRecord = { ...base, host: 'web-01', n: 1, nested: { a: [1, 2] } }
    for (const f of LOG_FORMATS) {
      assert.equal(formatRecord(rec, f), formatRecord(rec, f))
    }
  })
})
