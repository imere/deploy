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
import { arr, literal, num, obj, oneOf, prefChain, record, str } from './dsl.js'

function codeOf(fn: () => unknown): { code: string; message: string; path?: string; hint?: string } {
  try {
    fn()
  } catch (err) {
    if (err instanceof DpError) {
      // message 一并带出来：typeName 的产物只落在 message 里，
      // 之前只断言 code / hint，等于整条「实际是 X」没人看守，
      // 把判据翻掉（null 那条尤其如此）测试照样全绿
      return {
        code: err.code,
        message: err.message,
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
    // hint 为空不代表用户看不出问题，但「实际是 string」只在 message 里。
    // 不钉这半句，类型名的判据整体翻掉也照样绿
    assert.match(err.message, /期望对象，实际是 string/)
  })

  it('null 与数组同样被拒：null 的 typeof 是 object，数组摊开是 {}', () => {
    const errNull = codeOf(() => obj(shape).parse(null, 'p'))
    assert.equal(errNull.code, 'DP.CONFIG.INVALID')
    // null 必须单独钉：typeof null === 'object'。少了这条，把 `v === null`
    // 翻成 `!==` 时 null 会掉到 object 分支上，而 string / array 那两条一样通过
    assert.match(errNull.message, /期望对象，实际是 null/)

    const errArray = codeOf(() => obj(shape).parse([], 'p'))
    assert.equal(errArray.code, 'DP.CONFIG.INVALID')
    // 数组同理：typeof [] === 'object'，摊开还是 {}，它被拒的理由与 null 不同
    // （一个是「压根没给形状」，一个是「形状是数组但这里要对象」）
    assert.match(errArray.message, /期望对象，实际是 array/)
  })
})

describe('record · 非对象输入', () => {
  it('键自由不代表可以收标量', () => {
    const err = codeOf(() => record(str()).parse(7, 'env'))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.match(err.message, /期望对象，实际是 number/)
  })

  it('数组同样被拒：它有下标，误当键会得到一串 "0" 的值', () => {
    // 这条与 obj 那条看着重复，但守住的是 record 自己的那个使用点：
    // obj 与 record 各写了一份判据与报错，去掉其中一处调用只有这条会红
    const err = codeOf(() => record(str()).parse([], 'env'))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.path, 'env')
    assert.match(err.message, /期望对象，实际是 array/)
  })
})

describe('原子与数组 · 类型不符时报出实际类型', () => {
  it('字符串喂给 num：说它是 string，不说「不是数字」就完事', () => {
    const err = codeOf(() => num().parse('8080', 'projects.web.release.keep'))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.path, 'projects.web.release.keep')
    // 引号必须是用户的，不加引号的 8080 与 8080 在报错里分不出来 ——
    // 而「用户写了带引号的数字」正是本包刻意不转换的那一类手滑
    assert.match(err.message, /期望 number，实际是 string/)
  })

  it('对象喂给数组：报 object，不因为它有下标就当数组', () => {
    const err = codeOf(() => arr(str()).parse({}, 'projects.web.source.include'))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.path, 'projects.web.source.include')
    assert.match(err.message, /期望数组，实际是 object/)
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
