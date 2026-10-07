/**
 * 分层与环判据的回归测试。
 *
 * 为什么要给判据写测试：判据被改坏有两种坏法，都不会有别的信号 ——
 * 放宽到抓不住（反向依赖进仓没人看见），或误伤（分层表写反时报出一堆「反向依赖」，
 * 驱动人去改本来正确的代码）。后者在本仓真发生过：5 处违规里 3 处是层序写反造出来的。
 * 下面每条用例都对着一个已经踩过或明确预见到的坏法。
 *
 * 断言的全是行为：哪条语句算依赖、哪个包在哪一层、哪几个节点成环、边分进哪个桶。
 * 不碰内部变量，也不构造真实目录树 —— 这些函数本来就不读盘。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  IMPL_LAYER,
  analyzeCycles,
  classifyCrossLayer,
  clauseIsTypeOnly,
  findStatements,
  isTestFile,
  layerOf,
  makeAdj,
  prepare,
  shortName,
  splitPackageSpec,
} from './check-imports-rules.mjs'

/** 把源码文本跑成语句列表：prepare 与 findStatements 合起来才是「哪些是真的依赖」。 */
const statementsOf = (src) => {
  const { text, inStr } = prepare(src)
  return findStatements(text, inStr)
}
const specsOf = (src) => statementsOf(src).map((s) => s.spec)

// ---------------------------------------------------------------- 分层表

test('ports 是最底层，schema 在它之上 —— 防住层序整体写反', () => {
  // 这次写反的真实后果：schema 用 ports 的错误类型抛错这种正当依赖被判成反向依赖，
  // 报出来的「违规」会把人推向改正确的代码
  assert.equal(layerOf('@dp/ports'), 1)
  assert.equal(layerOf('@dp/schema'), 2)
  assert.equal(layerOf('@dp/core'), 3)
  assert.equal(layerOf('@dp/cli'), 5)
  // 只认短名：带 scope 的全名与短名必须落进同一层，否则同一依赖会被判两次
  assert.equal(layerOf('ports'), layerOf('@dp/ports'))
  assert.equal(shortName('@dp/target-nginx'), 'target-nginx')
})

test('未点名的包一律落实现包层，不自己切子层', () => {
  // 自切子层的失败模式是「判定依据变成脚本作者当时的理解」，下次改分层就悄悄漂移
  for (const p of ['@dp/log', '@dp/ssh', '@dp/transport', '@dp/target-docker', '@dp/nosuch']) {
    assert.equal(layerOf(p), IMPL_LAYER, `应落实现包层：${p}`)
  }
  assert.equal(IMPL_LAYER, 4)
})

test('只有指向更高层的边才算反向依赖 —— 防住不等号翻转', () => {
  // 不等号翻转会从「漏报」变成「全报」，是本门禁最贵的坏法
  assert.equal(layerOf('@dp/schema') > layerOf('@dp/ports'), true, 'schema → ports 是正当方向')
  assert.equal(layerOf('@dp/ports') > layerOf('@dp/schema'), false, 'ports → schema 才是反向')
  assert.equal(layerOf('@dp/cli') > layerOf('@dp/core'), true)
  assert.equal(layerOf('@dp/core') > layerOf('@dp/cli'), false)
})

test('测试文件判据只认 .test.ts 后缀', () => {
  assert.equal(isTestFile('packages/core/src/slice.test.ts'), true)
  assert.equal(isTestFile('packages/core/src/slice.ts'), false)
  // 子目录里的测试也要算测试：判据按后缀，不按深度
  assert.equal(isTestFile('packages/core/src/sub/deep.test.ts'), true)
})

// ---------------------------------------------------------------- 说明符解析

test('workspace 包名按 scope 两段切 —— 防住 @dp/ports 被切成 @dp 而静默消失', () => {
  // 这条错了的后果是漏报：仓内包被当成仓外依赖，从图上消失。
  // 键是 package.json 的 name（仓内全是 @dp/ 前缀），不是目录名。
  const dirByPkg = new Map([
    ['@dp/ports', 'ports'],
    ['@dp/core', 'core'],
    ['log', 'log'],
  ])
  assert.deepEqual(splitPackageSpec('@dp/ports', dirByPkg), { pkg: '@dp/ports', rest: '' })
  assert.deepEqual(splitPackageSpec('@dp/core/detect', dirByPkg), { pkg: '@dp/core', rest: 'detect' })
  assert.deepEqual(splitPackageSpec('@dp/core/detect.js', dirByPkg), { pkg: '@dp/core', rest: 'detect.js' })
  assert.deepEqual(splitPackageSpec('log', dirByPkg), { pkg: 'log', rest: '' })
  // 仓外依赖与相对路径都要老实返回「不是仓内包」
  assert.deepEqual(splitPackageSpec('node:fs', dirByPkg), { pkg: null, rest: null })
  assert.deepEqual(splitPackageSpec('lodash', dirByPkg), { pkg: null, rest: null })
  assert.deepEqual(splitPackageSpec('./x.js', dirByPkg), { pkg: null, rest: null })
  assert.deepEqual(splitPackageSpec('../core/index.js', dirByPkg), { pkg: null, rest: null })
  // 同前缀但不是包名的第二段：不能只认前两段就当成命中
  assert.deepEqual(splitPackageSpec('@dp/not-a-pkg/x', dirByPkg), { pkg: null, rest: null })
})

// ---------------------------------------------------------------- 语句识别

test('四种 import 形态都要算依赖，返回顺序按形态分组', () => {
  // 顺序也是输出的一部分：并列项的相对次序会进最终报告。
  // 分组顺序固定为「静态 → 副作用 → 动态 → re-export」，不按源码出现顺序。
  const src = [
    "import { a } from '@dp/core'",
    "export * from './star.js'",
    "export type { T } from './types.js'",
    "const m = await import('./lazy.js')",
    "import './side-effect.js'",
  ].join('\n')
  assert.deepEqual(specsOf(src), ['@dp/core', './side-effect.js', './lazy.js', './star.js', './types.js'])
})

test('多条同类语句各自成边，顺序按出现次序', () => {
  assert.deepEqual(specsOf("import a from './a'\nimport b from './b'\n"), ['./a', './b'])
  assert.deepEqual(specsOf("import a from '@dp/a'\nimport b from './b'\n"), ['@dp/a', './b'])
})

test('注释里的 import 不是依赖 —— 防止照抄示例被当成真实依赖', () => {
  // 注释是门禁最常见的假边来源：文档里贴一句 `import x from 'y'` 就会凭空造一条边
  assert.deepEqual(specsOf("// import a from '@dp/core'\nconst x = 1\n"), [])
  assert.deepEqual(specsOf("/* import a from '@dp/core' */\nconst x = 1\n"), [])
  assert.deepEqual(specsOf("/**\n * import a from '@dp/core'\n */\nexport const x = 1\n"), [])
})

test('字符串里的 import 不是依赖 —— 防止模板示例与文案被扫成边', () => {
  assert.deepEqual(specsOf('const doc = "import a from \'@dp/core\'"\n'), [])
  assert.deepEqual(specsOf("const doc = `import a from '@dp/core'`\n"), [])
  // 字符串里的动态 import() 同理
  assert.deepEqual(specsOf("const t = 'await import(\"@dp/core\")'\n"), [])
})

test('字符串里写着 specifier 的正则表达式不是依赖', () => {
  // 这类文本很常见于「怎么写 import」的说明文档
  assert.deepEqual(specsOf('const re = /import .* from/gi\n'), [])
})

test('子句里禁止再出现 import/export —— 防住跨行匹配把两条语句粘成一条假边', () => {
  // 非贪婪匹配顺着换行吃到下一条语句，就会造出 `export const a` → `./c` 这种不存在的边
  assert.deepEqual(specsOf("export const a = 1\nimport b from './c'\n"), ['./c'])
  assert.deepEqual(specsOf("const x = 1\nexport { y } from './d'\n"), ['./d'])
})

test('空输入与不闭合的字符串/注释不崩，也不凭空造边', () => {
  assert.deepEqual(specsOf(''), [])
  assert.deepEqual(specsOf('\n\n'), [])
  // 不闭合的块注释吃掉余下全部内容：宁可漏报也不能抛错
  assert.deepEqual(specsOf("const x = 1\n/* 没闭合\nimport a from './b'\n"), [])
  // 不闭合的普通引号在换行处停住，后面的语句仍要能扫出来
  assert.deepEqual(specsOf('const s = "没闭合\nimport a from "./b"\n'), ['./b'])
})

test('动态 import 要认，但成员访问上的 import 不认', () => {
  assert.deepEqual(specsOf("void import('@dp/ssh')\n"), ['@dp/ssh'])
  // `.import(` 是对象上的方法名，不是依赖语句
  assert.deepEqual(specsOf("await loader.import('@dp/ssh')\n"), [])
  assert.deepEqual(specsOf("ximport('@dp/ssh')\n"), [])
})

// ---------------------------------------------------------------- 类型专用

test('类型专用子句判为 type-only，含值成员的混合子句仍算值依赖', () => {
  // 混合子句判错的后果：值边被当类型边放行，编译后那条边还在
  assert.equal(clauseIsTypeOnly(' type '), true)
  assert.equal(clauseIsTypeOnly(' type { A } '), true)
  assert.equal(clauseIsTypeOnly(' { type A, type B } '), true)
  assert.equal(clauseIsTypeOnly(' { type A, B } '), false)
  assert.equal(clauseIsTypeOnly(' { A, B } '), false)
  assert.equal(clauseIsTypeOnly(' * as ns '), false)
  // 空子句与空花括号都不判成类型边（没解析出来 ≠ 解析出是类型）
  assert.equal(clauseIsTypeOnly(''), false)
  assert.equal(clauseIsTypeOnly(' {} '), false)
})

// ---------------------------------------------------------------- 跨层分桶

const edge = (fromPkg, toPkg, opts = {}) => ({
  fromPkg,
  toPkg,
  file: `packages/${fromPkg.replace('@dp/', '')}/src/a.ts`,
  line: 1,
  spec: '@dp/x',
  typeOnly: false,
  isTest: false,
  ...opts,
})

test('跨层边分四桶：值反向硬失败、类型反向与测试反向只报告、同层放行', () => {
  const r = classifyCrossLayer([
    edge('@dp/core', '@dp/ports'), // 正当：向下
    edge('@dp/ssh', '@dp/cli'), // 反向且是值依赖 → 硬失败
    edge('@dp/schema', '@dp/cli', { typeOnly: true }), // 反向但类型专用
    edge('@dp/core', '@dp/cli', { isTest: true }), // 反向但在测试里
    edge('@dp/ssh', '@dp/transport'), // 同层
  ])
  assert.deepEqual(r.reverse.map((x) => `${x.from}→${x.to}`), ['@dp/ssh→@dp/cli'])
  assert.deepEqual(r.typeOnlyReverse.map((x) => `${x.from}→${x.to}`), ['@dp/schema→@dp/cli'])
  assert.deepEqual(r.testOnlyReverse.map((x) => `${x.from}→${x.to}`), ['@dp/core→@dp/cli'])
  assert.deepEqual(r.sameLayer.map((x) => `${x.from}→${x.to}`), ['@dp/ssh→@dp/transport'])
})

test('类型专用优先于测试专用分桶 —— 防住按错理由去改', () => {
  // 一条来自测试的 import type 边既是类型边也是测试边；先分错桶会让人照错理由动手
  const r = classifyCrossLayer([edge('@dp/core', '@dp/cli', { typeOnly: true, isTest: true })])
  assert.deepEqual(r.typeOnlyReverse.map((x) => `${x.from}→${x.to}`), ['@dp/core→@dp/cli'])
  assert.deepEqual(r.testOnlyReverse, [])
})

test('输出项携带层号与测试标记，且同层不误判成反向', () => {
  const r = classifyCrossLayer([edge('@dp/ports', '@dp/schema', { isTest: true, file: 'packages/ports/src/a.test.ts' })])
  assert.deepEqual(r.reverse, [])
  assert.equal(r.testOnlyReverse[0].test, true)
  assert.equal(r.testOnlyReverse[0].file, 'packages/ports/src/a.test.ts')
  assert.equal(r.testOnlyReverse[0].fromLayer, 1)
  assert.equal(r.testOnlyReverse[0].toLayer, 2)
})

test('空边表分出四个空桶，不报错', () => {
  const r = classifyCrossLayer([])
  assert.deepEqual(r, { reverse: [], typeOnlyReverse: [], testOnlyReverse: [], sameLayer: [] })
})

// ---------------------------------------------------------------- 环

test('自环不算环 —— 防止每个文件都被自己判成环', () => {
  const adj = makeAdj(['a', 'b'], [{ from: 'a', to: 'a' }, { from: 'a', to: 'b' }])
  const r = analyzeCycles(['a', 'b'], adj, adj)
  assert.deepEqual(r.hard, [])
  assert.deepEqual(r.typeOnly, [])
})

test('包级成环判为硬失败并给出环路径', () => {
  const keys = ['a', 'b', 'c']
  const pairs = [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]
  const adj = makeAdj(keys, pairs)
  const r = analyzeCycles(keys, adj, adj)
  assert.equal(r.hard.length, 1)
  assert.deepEqual(r.hard[0].members, ['a', 'b', 'c'])
  // 环路径首尾闭合，这是人能照着改的形状
  assert.equal(r.hard[0].cycle[0], r.hard[0].cycle[r.hard[0].cycle.length - 1])
  assert.deepEqual(r.typeOnly, [])
})

test('A 值依赖 B、B 只类型依赖 A 不算运行时环，只进纯类型环', () => {
  // 两步判定（先全图 SCC，再按值边求 SCC）就是为了这个：只跑全图会把这种判成硬失败
  const keys = ['a', 'b']
  const all = makeAdj(keys, [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }])
  const value = makeAdj(keys, [{ from: 'a', to: 'b' }])
  const r = analyzeCycles(keys, all, value)
  assert.deepEqual(r.hard, [])
  assert.equal(r.typeOnly.length, 1)
  assert.deepEqual(r.typeOnly[0].members, ['a', 'b'])
})

test('无环的图与空图都判无环，不抛错', () => {
  const keys = ['a', 'b', 'c']
  const adj = makeAdj(keys, [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }])
  const r = analyzeCycles(keys, adj, adj)
  assert.deepEqual(r.hard, [])
  assert.deepEqual(r.typeOnly, [])
  const empty = analyzeCycles([], makeAdj([], []), makeAdj([], []))
  assert.deepEqual(empty.hard, [])
})

test('环的结果按成员名排序 —— 防住遍历顺序变化导致每次报告顺序都不同', () => {
  const keys = ['x', 'y']
  const pairs = [{ from: 'x', to: 'y' }, { from: 'y', to: 'x' }]
  const adj = makeAdj(keys, pairs)
  const a = analyzeCycles(keys, adj, adj)
  const b = analyzeCycles([...keys].reverse(), adj, adj)
  assert.deepEqual(a.hard[0].members, b.hard[0].members)
  assert.deepEqual(a.hard[0].members, ['x', 'y'])
})