import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'
import { caught, caughtAsync } from './capture.js'

function dpThrowing(): never {
  throw new DpError('DP.CONFIG.INVALID', '原始文案', { path: 'hosts.x', hint: '写成 user@host', cause: new Error('底层现场') })
}

function plainThrowing(): never {
  throw new Error('纯 Error')
}

class UsageLike extends DpError {
  constructor(message: string) {
    super('DP.CONFIG.INVALID', message)
    this.name = 'UsageLike'
  }
}

function usageThrowing(): never {
  throw new UsageLike('usage wrong')
}

describe('caught · 同步', () => {
  it('返回 DpError，code/message/cause 链原样可断言', () => {
    const err = caught(dpThrowing)
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.message, '原始文案')
    assert.equal(err.path, 'hosts.x')
    assert.equal(err.cause instanceof Error, true)
    assert.equal((err.cause as Error).message, '底层现场')
  })

  it('kind 给了就真校验具体子类：抛别的类必须当场红，不能「抛了什么都能过」', () => {
    assert.throws(() => caught(plainThrowing, UsageLike), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /UsageLike/)
      assert.match(err.message, /纯 Error/)
      return true
    })
  })

  it('kind 命中具体子类时把错误交还', () => {
    const err = caught(usageThrowing, UsageLike)
    assert.ok(err instanceof UsageLike)
    assert.equal(err.message, 'usage wrong')
  })

  it('没给 kind 而抛的是非 DpError → 抛带 cause 的 Error，现场不丢', () => {
    assert.throws(() => caught(plainThrowing), (err: unknown) => {
      assert.ok(err instanceof Error)
      assert.match(err.message, /期望 DpError/)
      assert.equal((err as Error).cause instanceof Error, true)
      return true
    })
  })

  it('没有抛错时给可读的「期望抛错，但没有」', () => {
    assert.throws(() => caught(() => undefined), (err: unknown) => {
      return err instanceof Error && err.message.includes('期望抛错，但没有')
    })
  })
})

describe('caughtAsync · 异步', () => {
  it('reject 被 capture 成 DpError，字段齐全', async () => {
    const err = await caughtAsync((async () => dpThrowing())())
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.hint, '写成 user@host')
  })

  it('Promise 正常完成 → 「期望 reject，但没有」', async () => {
    await assert.rejects(
      caughtAsync(Promise.resolve('fine')),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /期望 reject，但没有/)
        return true
      },
    )
  })

  it('kind 校验在异步同样生效', async () => {
    await assert.rejects(
      caughtAsync(Promise.reject(new DpError('DP.CONFIG.INVALID', '基类')), UsageLike),
      (err: unknown) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /UsageLike/)
        return true
      },
    )
  })
})
