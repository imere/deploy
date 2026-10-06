/**
 * 恒等断言判据的回归测试。
 *
 * 为什么要给判据写测试：判据一旦被改坏，有两种坏法，都不会有别的信号 ——
 * 放宽到抓不住（门禁全绿但什么也没验），或误伤合法写法（驱动人去改对的测试）。
 * 下面每一条都对应一个已经踩过或明确预见到的坏法。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { isTautology } from './check-tests-rules.mjs'

test('同一份纯表达式写两遍 = 恒等', () => {
  for (const expr of ['validateCodes', 'result', '42', "'abc'", 'a.b.c', 'rows[0]', 'a + b']) {
    assert.equal(isTautology(expr, expr), true, `应判恒等：${expr}`)
  }
})

test('只差空白也算恒等 —— 归一化只抹空白', () => {
  assert.equal(isTautology('a  +  b', 'a + b'), true)
  assert.equal(isTautology('rows [ 0 ]', 'rows[0]'), true)
})

test('含函数调用的实参不是恒等 —— 会被求值两次', () => {
  // 确定性测试的标准形状：实现不确定时两边就会不等，那正是它要验的东西。
  // 判成恒等就是拿形状当语义，后果比漏报更贵。
  assert.equal(isTautology('formatRecord(rec, f)', 'formatRecord(rec, f)'), false)
  assert.equal(isTautology('render(t)', 'render(t)'), false)
  // 调用在右侧也算：只看左侧会漏掉 assert.equal(expected, compute(x)) 之外的形状
  assert.equal(isTautology('x[0]', 'x[0]'), true)
  assert.equal(isTautology('f()', 'f()'), false)
})

test('两边不同 = 不是恒等', () => {
  assert.equal(isTautology('a', 'b'), false)
  assert.equal(isTautology('rows[0]', 'rows[1]'), false)
})

test('结构相同、值不同 = 不是恒等（防住「抹字面量」的退化）', () => {
  // 归一化一旦抹掉字面量，f('a') 与 f('b') 就会被判成一样
  assert.equal(isTautology("f('a')", "f('b')"), false)
  assert.equal(isTautology('g(1)', 'g(2)'), false)
})

test('空串与全空白 = 不判（没解析出来 ≠ 解析出相等）', () => {
  assert.equal(isTautology('', ''), false)
  assert.equal(isTautology('   ', '  '), false)
  assert.equal(isTautology('', 'x'), false)
})
