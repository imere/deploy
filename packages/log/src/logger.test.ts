import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { createLogger } from './logger.js'
import { createMemorySink } from './sink.js'
import type { LogRecord, LogSink } from '@dp/ports'

const TS = '2026-10-02T07:00:00.000Z'
const fixedClock = (): Date => new Date(TS)

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
afterEach(() => {
  if (originalWrite !== undefined) process.stderr.write = originalWrite
  captured.length = 0
})

function makeLogger(options: Parameters<typeof createLogger>[0] = {}) {
  const sink = createMemorySink()
  const log = createLogger({ sink, clock: fixedClock, ...options })
  return { log, sink }
}

describe('logger / 级别过滤', () => {
  it('默认 info：debug/trace 被丢弃，且**不进 sink**（连格式化都不做）', () => {
    const { log, sink } = makeLogger()
    log.trace('t')
    log.debug('d')
    log.info('i')
    log.warn('w')
    log.error('e')
    assert.equal(sink.lines.length, 3)
    assert.equal(sink.records[0]!.level, 'info')
  })

  it('阈值等于自身要输出', () => {
    const { log, sink } = makeLogger({ level: 'warn' })
    log.warn('w')
    assert.equal(sink.lines.length, 1)
  })

  it('级别可配到 trace', () => {
    const { log, sink } = makeLogger({ level: 'trace' })
    log.trace('t')
    assert.equal(sink.records[0]!.level, 'trace')
  })
})

describe('logger / record 组装', () => {
  it('固定字段顺序 + 自定义字段', () => {
    const { log, sink } = makeLogger({ deployId: 'd-1', bind: { host: 'web-01' } })
    log.info('transfer.begin', { phase: 'transfer', span: 's-2', attempt: 1, bytes: 1024 })
    assert.equal(
      sink.lines[0],
      '{"ts":"' + TS + '","level":"info","msg":"transfer.begin","deployId":"d-1","host":"web-01","phase":"transfer","span":"s-2","attempt":1,"bytes":1024}',
    )
  })

  it('bind < 调用字段：后者覆盖前者', () => {
    const { log, sink } = makeLogger({ bind: { host: 'a', region: 'cn' } })
    log.info('m', { host: 'b' })
    const r = sink.records[0] as LogRecord
    assert.equal(r.host, 'b')
    assert.equal(r.region, 'cn')
  })

  it('undefined 字段不输出（否则 JSON 里会出现 "host":null 这种噪音）', () => {
    const { log, sink } = makeLogger({ deployId: 'd' })
    log.info('m', { host: undefined })
    assert.equal(sink.lines[0]!.includes('host'), false)
  })

  it('三种 format 都可用', () => {
    const j = makeLogger()
    j.log.info('transfer.begin', { bytes: 8 })
    assert.ok(j.sink.lines[0]!.startsWith('{'))

    const l = makeLogger({ format: 'logfmt' })
    l.log.info('transfer.begin', { bytes: 8 })
    assert.ok(l.sink.lines[0]!.includes('msg=transfer.begin'))

    const p = makeLogger({ format: 'pretty' })
    p.log.info('transfer.begin', { bytes: 8 })
    assert.ok(p.sink.lines[0]!.startsWith('07:00:00.000 INFO  transfer.begin'))
  })
})

describe('logger / 脱敏在出口', () => {
  it('sink 收到的 record 必须是**脱敏后**的那份', () => {
    const { log, sink } = makeLogger()
    log.info('login', { password: 'hunter2', note: 'Bearer abc123XYZ' })
    const r = sink.records[0] as LogRecord
    assert.equal(r.password, '***')
    // 整串就是凭据本身 → 整串换掉（值模式替换的是命中片段，这里片段=全串）
    assert.equal(r.note, '***')
    assert.equal(sink.lines[0]!.includes('hunter2'), false)
  })

  it('msg 里的凭据也脱敏', () => {
    const { log, sink } = makeLogger()
    log.info('token is ghp_abcdefghij0123456789ABCDEFGHIJ')
    assert.equal(sink.lines[0]!.includes('ghp_abcdefghij'), false)
  })

  it('redact 选项透传', () => {
    const { log, sink } = makeLogger({ redact: { replacement: '<redacted>' } })
    log.info('m', { password: 'x' })
    assert.equal((sink.records[0] as LogRecord).password, '<redacted>')
  })
})

describe('logger / child 与 span', () => {
  it('child 继承 level/format/clock/sink，只覆盖自己', () => {
    const { log, sink } = makeLogger({ deployId: 'd-1', bind: { host: 'parent' } })
    const child = log.child({ host: 'child', phase: 'transfer' })
    child.info('from-child')
    log.info('from-parent')
    assert.equal((sink.records[0] as LogRecord).host, 'child')
    assert.equal((sink.records[0] as LogRecord).deployId, 'd-1')
    assert.equal((sink.records[1] as LogRecord).host, 'parent', '子字段不许污染父')
  })

  it('child 不允许改 level：需要不同 level 就新建 logger', () => {
    const { log, sink } = makeLogger({ level: 'info' })
    log.child({ level: 'trace' } as Record<string, unknown>).trace('t')
    assert.equal(sink.lines.length, 0, 'level 是配置项，不是绑定字段')
  })

  it('span() 等价于 child({ span })', () => {
    const { log, sink } = makeLogger()
    log.span('s-2').info('m')
    assert.equal((sink.records[0] as LogRecord).span, 's-2')
  })

  it('多层 child：越深优先级越高', () => {
    const { log, sink } = makeLogger({ bind: { host: 'root', a: 1 } })
    log.child({ a: 2 }).child({ a: 3, b: 4 }).info('m')
    const r = sink.records[0] as LogRecord
    assert.equal(r.a, 3)
    assert.equal(r.b, 4)
    assert.equal(r.host, 'root')
  })
})

describe('logger / begin 计时', () => {
  it('假时钟推进 → durationMs 正确，且是整数毫秒', () => {
    let now = 0
    const sink = createMemorySink()
    const log = createLogger({ sink, clock: (): Date => new Date(now) })
    const end = log.begin('transfer.begin', { host: 'web-01' })
    now = 1500
    end({ bytes: 1024 })
    const r = sink.records[0] as LogRecord
    assert.equal(r.durationMs, 1500)
    assert.equal(r.host, 'web-01')
    assert.equal(r.bytes, 1024)
  })

  it('不足 1ms 向下取整为 0（不取整会显示 0.x 假精度）', () => {
    let now = 0
    const sink = createMemorySink()
    const log = createLogger({ sink, clock: (): Date => new Date(now) })
    const end = log.begin('m')
    now = 0.9
    end()
    assert.equal((sink.records[0] as LogRecord).durationMs, 0)
  })

  it('end() 可不带参数', () => {
    const sink = createMemorySink()
    const log = createLogger({ sink, clock: fixedClock })
    log.begin('m')()
    assert.equal(sink.records[0]!.msg, 'm')
  })

  it('end() 调用两次只写一次，也不抛错', () => {
    const sink = createMemorySink()
    const log = createLogger({ sink, clock: fixedClock })
    const end = log.begin('m')
    end()
    assert.doesNotThrow(() => end())
    end({ late: true })
    assert.equal(sink.records.length, 1)
  })

  it('begin 走的是注入的 clock，不是 Date.now', () => {
    const sink = createMemorySink()
    const log = createLogger({ sink, clock: (): Date => new Date('2026-10-02T07:00:00.000Z') })
    log.begin('m')()
    assert.equal(sink.records[0]!.ts, TS)
  })

  it('begin 的字段也会脱敏', () => {
    const { log, sink } = makeLogger()
    log.begin('m', { token: 'ghp_abcdefghij0123456789ABCDEFGHIJ' })()
    assert.equal((sink.records[0] as LogRecord).token, '***')
  })
})

describe('logger / 绝不抛异常（铁律 1）', () => {
  it('sink 抛错 → 不冒泡 + stderr 兜底', () => {
    captureStderr()
    const log = createLogger({
      clock: fixedClock,
      sink: {
        write() {
          throw new Error('sink 炸了')
        },
      },
    })
    assert.doesNotThrow(() => log.info('m'))
    assert.equal(captured.length, 1)
    assert.ok(captured[0]!.includes('[dp/log] '))
  })

  it('字段带毒 getter → 不冒泡', () => {
    const { log, sink } = makeLogger()
    const bad = {
      get boom(): string {
        throw new Error('getter 炸了')
      },
    }
    assert.doesNotThrow(() => log.info('m', { bad }))
    assert.equal(sink.records.length, 1)
  })

  it('toJSON 抛错的对象 → 吞掉并降级', () => {
    const { log, sink } = makeLogger()
    const bad = {
      toJSON(): unknown {
        throw new Error('toJSON 炸了')
      },
    }
    assert.doesNotThrow(() => log.info('m', { bad }))
    assert.equal(sink.records.length, 1)
  })

  it('clock 抛错 → 不冒泡', () => {
    captureStderr()
    const log = createLogger({
      sink: createMemorySink(),
      clock: () => {
        throw new Error('clock 炸了')
      },
    })
    assert.doesNotThrow(() => log.info('m'))
    assert.equal(captured.length, 1)
  })

  it('非法 Date（toISOString 会抛）→ 不冒泡', () => {
    const { log, sink } = makeLogger({ clock: (): Date => new Date(NaN) })
    assert.doesNotThrow(() => log.info('m'))
    assert.equal(sink.records.length, 1)
  })

  it('SinkLike 没有任何兜底时也不冒泡', () => {
    captureStderr()
    const evil: LogSink = {
      write(): void {
        // 非 Error 的抛出：verify 一下 describeError 也不会被带崩
        throw { evil: true }
      },
    }
    const log = createLogger({ clock: fixedClock, sink: evil })
    assert.doesNotThrow(() => log.error('m'))
  })
})

describe('logger / flush', () => {
  it('await sink 的 flush', async () => {
    let flushed = false
    const log = createLogger({
      clock: fixedClock,
      sink: {
        write() {},
        async flush() {
          await Promise.resolve()
          flushed = true
        },
      },
    })
    await log.flush()
    assert.equal(flushed, true)
  })

  it('flush 失败 → 吞掉，Promise 不 reject', async () => {
    captureStderr()
    const log = createLogger({
      clock: fixedClock,
      sink: {
        write() {},
        flush: () => Promise.reject(new Error('刷盘失败')),
      },
    })
    await assert.doesNotReject(() => log.flush())
    assert.equal(captured.length, 1)
  })

  it('没有 flush 的 sink 也能 flush', async () => {
    const { log } = makeLogger()
    await assert.doesNotReject(() => log.flush())
  })
})

describe('logger / out 选项', () => {
  it('默认 sink 走 out，且自带换行', () => {
    const got: string[] = []
    const log = createLogger({ clock: fixedClock, out: (l) => got.push(l) })
    log.info('m')
    assert.equal(got.length, 1)
    assert.ok(got[0]!.endsWith('\n'))
  })
})

describe('logger / 确定性', () => {
  it('固定 clock 下同一事件两次输出完全一致', () => {
    const a = makeLogger({ deployId: 'd-7f3a' })
    a.log.info('transfer.begin', { host: 'web-01', bytes: 1024 })
    const b = makeLogger({ deployId: 'd-7f3a' })
    b.log.info('transfer.begin', { host: 'web-01', bytes: 1024 })
    assert.equal(a.sink.lines[0], b.sink.lines[0])
  })
})
