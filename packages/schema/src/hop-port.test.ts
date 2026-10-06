/**
 * 多跳每一跳的端口判定。
 *
 * 关注「串里写了端口 + port 字段也写了」这条：两处都能写端口时，
 * 静默取其中一个会让用户以为连的是自己写的那台 —— 而连错机器的代价
 * 比当场报错高得多。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { defineHost } from './config.js'

describe('hops[].port · 与 ssh 串里的端口互斥', () => {
  it('两处端口一致：放行，不当成冲突', () => {
    const host = defineHost({ hops: [{ ssh: 'ops@jump.example.com:2222', port: 2222 }] })
    assert.equal(host.hops?.[0]?.port, 2222)
  })

  it('两处端口矛盾：报错而不是二选一', () => {
    try {
      defineHost({ hops: [{ ssh: 'ops@jump.example.com:2222', port: 2200 }] })
      assert.fail('应当抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.CONFIG.INVALID')
      assert.equal(err.path, 'host.hops[0].port')
      assert.ok((err.hint ?? '').includes('留一个就行'))
    }
  })

  it('串里不带端口时 port 字段是唯一写法，不报冲突', () => {
    const host = defineHost({ hops: [{ ssh: 'ops@jump.example.com', port: 2222 }] })
    assert.equal(host.hops?.[0]?.port, 2222)
  })
})
