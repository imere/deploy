/**
 * DSL 原子与复合类型的**类型层判不出来**的那些分支。
 *
 * 关注三类：字面量不符、复合类型收到非预期形状、偏好链里混进不支持的项。
 * 它们各自对应一种真实事故 —— 字面量静默放过会让 `reload: false` 被当成 true，
 * 偏好链不校验会让不受支持的传输方式一路走到执行期才炸。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { arr, literal, obj, oneOf, prefChain, record, str } from './dsl.js'

function codeOf(fn: () => unknown): { code: string; path?: string; hint?: string } {
  try {
    fn()
  } catch (err) {
    if (err instanceof DpError) {
      return {
        code: err.code,
        ...(err.path !== undefined ? { path: err.path } : {}),
        ...(err.hint !== undefined ? { hint: err.hint } : {}),
      }
    }
    throw err
  }
  assert.fail('应当抛错')
}

describe('literal · 单一字面量', () => {
  it('严格相等，不匹配即报错', () => {
    const err = codeOf(() => literal(false).parse(true, 'projects.web.reload'))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.path, 'projects.web.reload')
  })

  it('布尔字面量命中时原样返回', () => {
    assert.equal(literal(false).parse(false, 'p'), false)
  })
})

describe('obj · 非对象输入', () => {
  const shape = { name: str() }

  it('字符串不是对象', () => {
    const err = codeOf(() => obj(shape).parse('web', 'projects.web'))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.match(String(err.hint ?? ''), /^$/)
  })

  it('null 与数组同样被拒：null 的 typeof 是 object，数组摊开是 {}', () => {
    assert.equal(codeOf(() => obj(shape).parse(null, 'p')).code, 'DP.CONFIG.INVALID')
    assert.equal(codeOf(() => obj(shape).parse([], 'p')).code, 'DP.CONFIG.INVALID')
  })
})

describe('record · 非对象输入', () => {
  it('键自由不代表可以收标量', () => {
    const err = codeOf(() => record(str()).parse(7, 'env'))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
  })
})

describe('prefChain · 链内项不被支持', () => {
  it('单值写法里混入不支持的传输方式，路径带下标', () => {
    const chain = prefChain(['rsync', 'tar-ssh'], ['rsync'])
    const err = codeOf(() => chain.parse('carrier-pigeon', 'project.transport.strategy'))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.path, 'project.transport.strategy[0]')
    assert.equal(err.hint, '可用：rsync, tar-ssh')
  })

  it('数组写法里混入非字符串：typeof 不对与不在白名单是同一条失败路径', () => {
    const chain = prefChain(['rsync', 'tar-ssh'], ['rsync'])
    const err = codeOf(() => chain.parse([1] as never, 'p'))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.path, 'p[0]')
  })

  it('默认链不被校验：它是实现给的常量', () => {
    const chain = prefChain(['rsync'], ['rsync'])
    assert.deepEqual(chain.parse(undefined, 'p'), ['rsync'])
    assert.deepEqual(chain.parse('auto', 'p'), ['rsync'])
  })
})

describe('复合类型的 toJsonSchema', () => {
  it('oneOf 的 enum 与错误 hint 同源', () => {
    const values = ['static', 'nginx'] as const
    const schema = oneOf(values)
    assert.deepEqual(schema.toJsonSchema().enum, values)
    const err = codeOf(() => schema.parse('nope', 'p'))
    assert.equal(err.hint, '可选值：static, nginx')
  })

  it('数组元素的路径带下标：元素写错要能定位到那一项', () => {
    const schema = arr(str())
    const err = codeOf(() => schema.parse(['a', 2], 'locations'))
    assert.equal(err.path, 'locations[1]')
  })
})
