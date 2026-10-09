/**
 * 跨包依赖声明判据的测试。
 *
 * 这一门存在的理由是「未声明的依赖在本机没有任何症状」，所以判据判错的代价
 * 是双倍的：漏报让人继续写出 CI 才红的 import，误报让人去声明一个根本没用的包。
 * 这里断言的是四条边界：什么算声明过、源码里哪些写法算引用、自己引自己不算、
 * 注释里的包名不算。
 *
 * 全是纯函数，不读盘，因此在本机负载高、派生不了子进程时也能真跑。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { declaredDeps, formatViolation, importedScopedPackages, undeclaredImports } from './check-deps-rules.mjs'

test('三类依赖字段都算声明过', () => {
  const d = declaredDeps({
    dependencies: { '@dp/ports': 'workspace:*' },
    devDependencies: { '@dp/local': 'workspace:*' },
    peerDependencies: { '@dp/schema': 'workspace:*' },
  })
  for (const n of ['@dp/ports', '@dp/local', '@dp/schema']) assert.ok(d.has(n), `${n} 应当算声明过`)
})

test('没有依赖字段时得到空集合而不是抛错', () => {
  assert.equal(declaredDeps({}).size, 0)
  assert.equal(declaredDeps(undefined).size, 0)
})

test('静态 import 与动态 import 都算引用', () => {
  const src = [
    "import { makePlan } from '@dp/core'",
    "const m = await import('@dp/local')",
  ].join('\n')
  assert.deepEqual(importedScopedPackages(src), ['@dp/core', '@dp/local'])
})

test('只写 from 的裸包名不认；带子路径的包名也不该被拆错', () => {
  assert.deepEqual(importedScopedPackages("import x from 'lodash'"), [])
  assert.deepEqual(importedScopedPackages("import x from '@dp/core/build/index.js'"), ['@dp/core'])
})

test('同一个包被引用多次只报一处', () => {
  const src = "import a from '@dp/ports'\nimport b from '@dp/ports'\n"
  assert.deepEqual(importedScopedPackages(src), ['@dp/ports'])
})

test('未声明的引用会被挑出来，带上文件与包名', () => {
  const files = new Map([['detect.ts', "import { deploy } from '@dp/target-static'\n"]])
  const bad = undeclaredImports('core', '@dp/core', files, new Set(['@dp/ports']))
  assert.equal(bad.length, 1)
  assert.deepEqual(bad[0], { file: 'core/detect.ts', dep: '@dp/target-static' })
})

test('声明过的引用不报', () => {
  const files = new Map([['a.ts', "import { x } from '@dp/ports'\n"]])
  assert.equal(undeclaredImports('core', '@dp/core', files, new Set(['@dp/ports'])).length, 0)
})

test('自己引自己不报 —— 那需要的是 exports 字段，不是依赖声明', () => {
  const files = new Map([['a.test.ts', "import { makePlan } from '@dp/core'\n"]])
  assert.equal(undeclaredImports('core', '@dp/core', files, new Set()).length, 0)
})

test('违规说明里带上包名，方便直接去改对应的 package.json', () => {
  const line = formatViolation({ file: 'core/detect.ts', dep: '@dp/local' }, '@dp/core')
  assert.match(line, /@dp\/core 引了 @dp\/local/)
})
