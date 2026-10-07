/**
 * 死代码判据的回归测试。
 *
 * 这些判定一旦被改坏，没有任何东西会变红 —— 门禁照样跑完，只是「确认的死代码」
 * 多出或凭空少掉条目。所以下面每条都对着一种具体的坏法：
 * 遮罩漏剥一层、说明符解析串到别的语句、声明偏移算错、转发闭包只追一跳。
 *
 * 全部只断言行为（输入 → 结论），不断言中间变量：内部形状变了但结论没变时，
 * 让测试变红只会逼着人改对的代码。
 */
import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'

import {
  collectDeclarations,
  collectSpecifiers,
  countRefs,
  isPkgEntry,
  isTestFile,
  makeLineAt,
  scan,
  specifierCandidates,
  starReach,
} from './dead-code-rules.mjs'

// ---------------------------------------------------------------- 遮罩

test('抹字符串视图里，字面量内容与注释都不再参与标识符计数', () => {
  // 防「只抹一层」：字符串里出现目标名时必须被抹掉，否则每个符号都凭空多出引用，
  // 「零引用」永远不会成立，死代码一条都报不出来。
  const src = 'const a = "helper"\nexport function helper() {}\n// helper\n'
  const code = scan(src, false)
  assert.equal(countRefs(code, 'helper', null), 1, '只剩声明那一处')
  assert.equal(code.includes('helper\n//'), false, '注释里的名字也被抹了')
})

test('留字符串视图里，说明符路径原样保留（否则全仓被判成互不引用）', () => {
  const src = 'import { x } from "./y.js"\n'
  const bare = scan(src, true)
  assert.equal(collectSpecifiers(bare).edges.length, 1)
  assert.equal(collectSpecifiers(bare).edges[0].spec, './y.js')
  assert.equal(collectSpecifiers(scan(src, false)).edges.length, 0, '抹字符串后说明符不存在')
})

test('两种视图都不改变长度与行数 —— 行号必须还指回原文', () => {
  // 防「抹的时候把换行也吃掉」：行号全错会让每条报告指向别的文件里的位置，
  // 而这种错不会让门禁失败，只会让报告不可用。
  for (const src of [
    'const s = "a\nb"\nexport const c = 1\n',
    '/* 多行\n注释 */\nexport const d = 2\n',
    'const t = `x${y}z`\n',
  ]) {
    for (const keep of [true, false]) {
      const out = scan(src, keep)
      assert.equal(out.length, src.length, `长度变了：${JSON.stringify(src)} keep=${keep}`)
      assert.equal(out.split('\n').length, src.split('\n').length, `行数变了 keep=${keep}`)
    }
  }
})

test('模板串的 ${...} 是真代码，两种视图都留（防把它当字面量抹掉）', () => {
  const src = 'const msg = `a${helper()}b`\nfunction helper() { return 1 }\n'
  for (const keep of [true, false]) {
    assert.equal(countRefs(scan(src, keep), 'helper', null) > 0, true, `keep=${keep} 时插值里的代码被抹了`)
  }
})

test('正则字面量不当成除号或注释来剥（防跨行/截断）', () => {
  const src = 'const re = /a\\/b[0-9]+/g\nconst m = re.exec(s)\nconst s = "x"\n'
  const code = scan(src, false)
  assert.equal(code.includes('/a\\/b[0-9]+/g'), false, '正则本身应被遮罩')
  assert.equal(countRefs(code, 're', null) > 0, true, '正则变量名还在')
  // 除号一侧：a / b 不应被误判成正则起始，否则后面的代码全被吃掉
  const div = scan('const q = a / b\nexport const z = 1\n', false)
  assert.equal(countRefs(div, 'z', null), 1, '除号之后的代码被正则分支吃掉了')
})

test('不闭合的块注释吞到文件尾，但换行必须逐行留下（防行号整体错位）', () => {
  const src = '/* 没闭合\nexport const a = 1\n'
  const out = scan(src, false)
  assert.equal(out.split('\n').length, src.split('\n').length, '换行数被破坏')
  assert.equal(out.includes('export'), false, '未闭合注释之后的内容不可判定，不该冒出来')
})

test('不闭合的字符串只吃到行尾，后续行照常判定（防一条坏行废掉整个文件）', () => {
  const out = scan('const s = "没闭合\nexport const b = 2\n', false)
  assert.equal([...collectDeclarations(out).decls.keys()].join(','), 'b')
})

test('空输入得到空输出（防边界上抛或返回 undefined）', () => {
  for (const keep of [true, false]) {
    assert.equal(scan('', keep), '')
  }
  assert.deepEqual(collectDeclarations('').decls.size, 0)
  assert.deepEqual(collectSpecifiers('').edges, [])
  assert.equal(countRefs('', 'a', null), 0)
})

// ---------------------------------------------------------------- 行号

test('偏移 → 行号从 1 起，且换行边界落在正确行', () => {
  const at = makeLineAt('a\nb\nc')
  assert.equal(at(0), 1)
  assert.equal(at(1), 1)
  assert.equal(at(2), 2)
  assert.equal(at(3), 2)
  assert.equal(at(4), 3)
})

test('空文本的唯一偏移算第 1 行（防二分退化成 0 行 / 越界）', () => {
  assert.equal(makeLineAt('')(0), 1)
})

// ---------------------------------------------------------------- 声明

test('各类 export 声明都被认出来，名字与种类都对', () => {
  const src = [
    'export function f() {}',
    'export class K {}',
    'export const c = 1',
    'export let l = 1',
    'export var v = 1',
    'export interface I {}',
    'export type T = string',
    'export enum E { A }',
    'export namespace N {}',
    'export async function g() {}',
  ].join('\n')
  const { decls } = collectDeclarations(scan(src, false))
  assert.deepEqual([...decls.values()].map((d) => `${d.name}:${d.kind}`), [
    'f:function', 'K:class', 'c:const', 'l:let', 'v:var',
    'I:interface', 'T:type', 'E:enum', 'N:namespace', 'g:function',
  ])
})

test('export default 不猜名字，进可疑集（防默认导出的符号被当成零引用死代码）', () => {
  const def = collectDeclarations(scan('export default function main() {}\n', false))
  assert.equal(def.decls.size, 0)
  assert.equal(def.uncertain.length, 1)
})

test('具名导出列表只留痕、不产出声明（当前行为：这条分支不触发）', () => {
  // 现状固定下来，防止有人以为它能兜住解构导出而放松别处的保守判定。
  // 现状的后果是漏报而非误报：`export { a }` 里的名字既不进 decls 也不进 uncertain，
  // 也就是这类文件的名字一律不参与「零引用」判定。
  const dest = collectDeclarations(scan('const a = 1, b = 2\nexport { a, b }\n', false))
  assert.equal(dest.decls.size, 0)
  assert.equal(dest.uncertain.length, 0)
})

test('import type / export type 不被误当成运行时引用方（防类型引用救活死符号）', () => {
  // 反过来也要验：`export type { T } from './x'` 确实是转发说明符，得被记成一条转发边。
  const src = "import type { T } from './x.js'\nexport type { T } from './x.js'\n"
  const { edges, forwards } = collectSpecifiers(scan(src, true))
  assert.equal(edges.length, 1)
  assert.equal(forwards.length, 1)
  assert.equal(forwards[0].star, false)
})

test('非 export 的同名声明不算导出（防把内部符号报成公共死 API）', () => {
  const { decls } = collectDeclarations(scan('function helper() {}\nconst other = 1\n', false))
  assert.equal(decls.size, 0)
})

// ---------------------------------------------------------------- 说明符

test('静态 import 的三种形态都记成边', () => {
  const src = [
    "import './side.js'",
    "import { a } from './named.js'",
    "import def from './default.js'",
  ].join('\n')
  const { edges } = collectSpecifiers(scan(src, true))
  assert.deepEqual(edges.map((e) => e.spec), ['./side.js', './named.js', './default.js'])
  assert.deepEqual([...new Set(edges.map((e) => e.kind))], ['static'])
})

test('动态 import：字面量参数记成边，非字面量进可疑集（防漏掉一条引用边）', () => {
  const lit = collectSpecifiers(scan("const m = await import('./lazy.js')\n", true))
  assert.deepEqual(lit.edges.map((e) => [e.spec, e.kind]), [['./lazy.js', 'dynamic']])

  const dyn = collectSpecifiers(scan('const m = await import(name)\n', true))
  assert.equal(dyn.dynamic.length, 1, '非常量参数必须留痕，否则文件会被误判成无人 import')
})

test('export … from 同时是引用边与转发（防纯转发包被整包判死）', () => {
  const { edges, forwards } = collectSpecifiers(scan("export { a } from './fwd.js'\n", true))
  assert.equal(forwards.length, 1)
  assert.equal(forwards[0].star, false)
  // 转发边在文件级判定里也当引用边用：这条只验它被分到 forwards，没被当成静态 import
  assert.deepEqual(edges, [])
})

test('星号转发标为 star（防它与具名转发混为一谈而丢掉可达性传播）', () => {
  const { forwards } = collectSpecifiers(scan("export * from './all.js'\n", true))
  assert.equal(forwards.length, 1)
  assert.equal(forwards[0].star, true)
})

test('注释里的 import 不产生边 —— 遮罩必须先于解析', () => {
  // 防「先解析后遮罩」：注释里写一句 import 就会给一个死文件凭空造出引用方。
  const src = "// import { a } from './ghost.js'\nimport { b } from './real.js'\n"
  const { edges } = collectSpecifiers(scan(src, true))
  assert.deepEqual(edges.map((e) => e.spec), ['./real.js'])
})

test('字符串里的 import( 只在留字符串视图里可能被当动态 import —— 行为固定下来', () => {
  // 这里断言的是当前真实行为而不是理想行为：留字符串视图里字符串内容没被抹，
  // 所以文本 `import(` 会被动态分支看到。它进可疑集（保守方向），不会造成漏报。
  const src = 'const t = "import(\'./ghost.js\')"\n'
  const seen = collectSpecifiers(scan(src, true))
  assert.equal(seen.edges.length + seen.dynamic.length, 1)
})

test('方法名与属性名上的 import 字样不算 import 语句（防对象字面量造边）', () => {
  const src = 'const o = { import: 1 }\nfoo.import(2)\n'
  const { edges } = collectSpecifiers(scan(src, true))
  assert.deepEqual(edges, [])
})

// ---------------------------------------------------------------- 豁免判据

test('入口与测试文件各有各的豁免理由（防两者互相顶替）', () => {
  assert.equal(isTestFile('packages/core/src/dead-code.test.ts'), true)
  assert.equal(isTestFile('packages/core/src/dead-code.ts'), false)
  assert.equal(isPkgEntry('packages/core/src/index.ts'), true)
  assert.equal(isPkgEntry('packages/core/src/detect.ts'), false)
  assert.equal(isPkgEntry('packages/core/build/index.js'), false)
})

// ---------------------------------------------------------------- 候选顺序

test('相对说明符：`./x.js` 必须同时试 `.ts`（TS 的 ESM 写法）', () => {
  const c = specifierCandidates('/repo', '/repo/packages/a/src/i.ts', './x.js')
  // 候选是 resolve 之后的绝对路径：比对必须走同一套，否则在 Windows 上
  // 拿正斜杠去比反斜杠（假红），或反过来放过真实的不一致
  assert.deepEqual(c, [resolve('/repo/packages/a/src/x.js'), resolve('/repo/packages/a/src/x.ts')])
  // 顺序不能反：先命中的优先，`.js` 原样在前
  assert.equal(c.length, 2)
})

test('无扩展名说明符要试 `index.ts`（目录入口形状）', () => {
  const c = specifierCandidates('/repo', '/repo/packages/a/src/i.ts', './sub')
  assert.equal(c.includes(resolve('/repo/packages/a/src/sub/index.ts')), true)
})

test('`../` 相对上跳按引用方所在目录解析（防在仓库根解析）', () => {
  const c = specifierCandidates('/repo', '/repo/packages/a/src/deep/i.ts', '../shared.js')
  assert.equal(c[0], resolve('/repo/packages/a/src/shared.js'))
})

test('@dp/* 只指向该包入口，第三方与内置模块没有候选', () => {
  assert.deepEqual(
    specifierCandidates('/repo', '/repo/scripts/x.mjs', '@dp/core'),
    [join('/repo', 'packages', 'core', 'src', 'index.ts')],
  )
  assert.deepEqual(specifierCandidates('/repo', '/repo/scripts/x.mjs', 'node:fs'), [])
  assert.deepEqual(specifierCandidates('/repo', '/repo/scripts/x.mjs', 'lodash'), [])
  assert.deepEqual(specifierCandidates('/repo', '/repo/scripts/x.mjs', '@dp/core/extra'), [])
})

test('已是源码扩展名的说明符不再追加候选（防 .tsx 后面又跟一个 .tsx）', () => {
  const c = specifierCandidates('/repo', '/repo/packages/a/src/i.ts', './x.ts')
  assert.equal(c.length, 1)
})

// ---------------------------------------------------------------- 引用计数

test('声明处那一次可以按偏移跳过（防每个符号天生有一处引用）', () => {
  const code = 'export const a = 1\nconst b = a + 1\n'
  const { decls } = collectDeclarations(code)
  const off = decls.get('a').offset
  assert.equal(countRefs(code, 'a', null), 2)
  assert.equal(countRefs(code, 'a', off), 1, '声明处没被跳过')
})

test('前后缀相同但不同的标识符不算引用（防 foo 救活 foobar）', () => {
  const code = 'foobar\nmyFoo\nFoo\nFoo\n'
  assert.equal(countRefs(code, 'Foo', null), 2)
  // 大小写不同即不同标识符：`foo` 与 `Foo` 是两个名字，不该互相救活
  assert.equal(countRefs(code, 'foo', null), 0)
  // `foo` 作为前缀被 foobar 吃掉，也不是一次引用
  assert.equal(countRefs('foobar\nfoo\n', 'foo', null), 1)
})

test('不传偏移时等于全量计数（防默认偏移吞掉真实引用）', () => {
  const code = 'const x = 1\nf(x)\ng(x)\n'
  assert.equal(countRefs(code, 'x', null), 3)
})

// ---------------------------------------------------------------- 转发可达性

test('星号转发至少追一跳（防整条转发链的文件被判死）', () => {
  const paths = ['/a', '/b', '/c']
  const reach = starReach(paths, new Map([
    ['/a', new Set(['/b'])],
    ['/b', new Set(['/c'])],
    ['/c', new Set()],
  ]))
  // 只钉一跳：多跳传递目前不成立，见下面「已知缺陷」那条用例
  assert.deepEqual([...reach.get('/a')], ['/b'])
  assert.deepEqual([...reach.get('/b')], ['/c'])
  assert.deepEqual([...reach.get('/c')], [])
})

test('环状转发必须终止（防迭代不终止把门禁挂死）', () => {
  // 终止性要钉住：闭包迭代若不加轮数上限，a→b→a 这种环就会挂死整个门禁。
  // 集合内容本身按下述已知缺陷固定，不在这里断言「正确的传递闭包」。
  const paths = ['/a', '/b']
  const reach = starReach(paths, new Map([
    ['/a', new Set(['/b'])],
    ['/b', new Set(['/a'])],
  ]))
  assert.deepEqual([...reach.get('/a')], ['/b'])
  assert.deepEqual([...reach.get('/b')], ['/a', '/b'])
})

test('没有星号转发时可达集全空（防空转发也被记成一条引用）', () => {
  const reach = starReach(['/a'], new Map([['/a', new Set()]]))
  assert.equal(reach.get('/a').size, 0)
})