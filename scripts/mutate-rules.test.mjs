/**
 * 变异豁免清单判据的测试。
 *
 * 豁免清单是「这一处杀不死是合理的」的唯一授权来源，判据判错会直接改动存活率的分子，
 * 所以这里断言的是四条边界：什么形状的清单能进、一处变异算不算命中、跑完绿的/红的各归
 * 哪一类、哪些条目本轮没用上。
 *
 * 全是纯函数，不需要构建产物，也不碰 `.tmp/mutate` —— 因此在本机派生不了子进程的
 * 环境里也能真跑。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  classifyOutcome,
  isBuildArtifactPath,
  matchExemption,
  pkgOfArtifactPath,
  unusedExemptions,
  validateExemptions,
} from './mutate-rules.mjs'

/** 一条形状合格、reason 也写了的清单条目。 */
const entry = (over = {}) => ({
  file: 'packages/schema/build/config.js',
  line: 199,
  label: '`<` → `<=`',
  reason: '越界那一轮只读到 undefined，循环外没人再用 i —— 等价变异。',
  ...over,
})

test('清单顶层不是数组时整体拒收', () => {
  const v = validateExemptions({ file: 'packages/schema/build/config.js' })
  assert.equal(v.ok, false)
  assert.equal(v.entries.length, 0)
  assert.ok(v.problems.some((p) => p.includes('顶层必须是数组')))
})

test('file 不在任何包的 build 下时拒收', () => {
  const bad = ['packages/schema/src/config.ts', 'packages/schema/config.js', 'schema/build/config.js', 'packages/schema/build/']
  for (const f of bad) {
    const v = validateExemptions([entry({ file: f })])
    assert.equal(v.ok, false, `应当拒收 ${f}`)
    assert.ok(v.problems.some((p) => p.includes('file')))
  }
})

test('line 不是正整数时拒收', () => {
  for (const line of [0, -1, 1.5, '199', null]) {
    const v = validateExemptions([entry({ line })])
    assert.equal(v.ok, false, `应当拒收 line=${String(line)}`)
  }
})

test('reason 为空或只有空白时拒收 —— 说不清理由就别豁免', () => {
  for (const reason of ['', '   ', undefined]) {
    const v = validateExemptions([entry({ reason })])
    assert.equal(v.ok, false, `应当拒收 reason=${JSON.stringify(reason)}`)
    assert.ok(v.problems.some((p) => p.includes('reason')))
  }
})

test('同一处重复登记时拒收，并指出来是跟第几条撞的', () => {
  const v = validateExemptions([entry(), entry({ reason: '换了个说法，但还是同一处' })])
  assert.equal(v.ok, false)
  assert.ok(v.problems.some((p) => p.includes('撞复') && p.includes('第 1 条')))
})

test('同一行两个不同 label 不算撞复 —— 它们是两个候选', () => {
  const v = validateExemptions([entry(), entry({ label: '`&&` → `||`' })])
  assert.equal(v.ok, true)
  assert.equal(v.entries.length, 2)
})

test('通过的条目带上 key，形状与报告里的写法一致', () => {
  const v = validateExemptions([entry()])
  assert.equal(v.ok, true)
  assert.equal(v.entries[0].key, 'packages/schema/build/config.js:199 `<` → `<=`')
})

test('isBuildArtifactPath 不放行嵌套路径与空文件名', () => {
  assert.equal(isBuildArtifactPath('packages/schema/build/config.js'), true)
  assert.equal(isBuildArtifactPath('packages/a/b/build/x.js'), false)
  assert.equal(isBuildArtifactPath('packages/schema/build/'), false)
  assert.equal(isBuildArtifactPath('packages/schema/src/config.ts'), false)
})

test('pkgOfArtifactPath 取包名，非产物路径返回 null', () => {
  assert.equal(pkgOfArtifactPath('packages/schema/build/config.js'), 'schema')
  assert.equal(pkgOfArtifactPath('packages/core/build/detect.js'), 'core')
  assert.equal(pkgOfArtifactPath('packages/schema/src/config.ts'), null)
})

test('matchExemption 三个字段全相等才算命中', () => {
  const list = validateExemptions([entry()]).entries
  assert.ok(matchExemption(list, { file: 'packages/schema/build/config.js', line: 199, label: '`<` → `<=`' }))
  // 位置对了但换了个算子：这是同一行的另一个候选，不该被顺带豁免
  assert.equal(matchExemption(list, { file: 'packages/schema/build/config.js', line: 199, label: '`&&` → `||`' }), null)
  assert.equal(matchExemption(list, { file: 'packages/schema/build/config.js', line: 200, label: '`<` → `<=`' }), null)
  assert.equal(matchExemption(list, { file: 'packages/core/build/detect.js', line: 199, label: '`<` → `<=`' }), null)
})

test('未登记 + 还绿 = 存活；未登记 + 变红 = 杀死', () => {
  assert.deepEqual(classifyOutcome({ ok: true }, null), { bucket: 'survived', stale: false })
  assert.deepEqual(classifyOutcome({ ok: false }, null), { bucket: 'killed', stale: false })
})

test('已登记 + 还绿 = 豁免，不计入存活分子', () => {
  assert.deepEqual(classifyOutcome({ ok: true }, entry()), { bucket: 'exempted', stale: false })
})

test('已登记 + 变红 = 杀死且标记过期 —— 当初杀不死的理由不成立', () => {
  assert.deepEqual(classifyOutcome({ ok: false }, entry()), { bucket: 'killed', stale: true })
})

test('跑不出结果（该包没测试）时归入变红一侧，不能算豁免成立', () => {
  assert.deepEqual(classifyOutcome({ ok: null }, entry()), { bucket: 'killed', stale: true })
  assert.deepEqual(classifyOutcome({ ok: null }, null), { bucket: 'killed', stale: false })
})

test('unusedExemptions 只报本轮没命中过的条目', () => {
  const list = validateExemptions([entry(), entry({ line: 239 })]).entries
  const used = new Set([list[0].key])
  const idle = unusedExemptions(list, used)
  assert.equal(idle.length, 1)
  assert.equal(idle[0].line, 239)
})
