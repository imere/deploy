/**
 * JSDoc 门禁判据的回归测试。
 *
 * 为什么要给判据写测试：这门禁有过七个解析 bug，每一个报出来的结论都说得过去、判定却是错的。
 * 其中模板串那条坏掉时是**漏报**（脚本安静地看不见一批导出），比误报更难发现。
 * 判据内联在扫描循环里的时候，改坏了不会有任何东西变红 —— 它恰好是「谁来验验证者」那条链的一环。
 *
 * 下面每条用例名都写明它防的是哪种坏法，断言全部只碰行为（返回什么、判成什么），
 * 不碰内部变量。两条标了「当前行为」的用例锁的是实测现状而不是设计意图：
 * 它们的成因与影响记在同批交付的检查报告里，修它们要连判据一起改。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  arrowParams,
  checkMembers,
  docBefore,
  findParamsOpen,
  lineOf,
  looksRestated,
  mask,
  maskString,
  matchBracket,
  matchParamDocs,
  membersOf,
  memberDocBefore,
  paramNames,
  parseDoc,
  resolveSpecifier,
  scanDeclarations,
  splitTop,
} from './check-jsdoc-rules.mjs'

// ---------------------------------------------------------------- 源码遮罩

test('mask：注释与字符串内容换成等长空格、换行保留 —— 后续正则只该看到真实代码', () => {
  const src = 'const s = "export function fake() {}" // export function alsoFake() {}\nexport function real() {}\n'
  const m = mask(src)
  assert.equal(m.length, src.length)
  assert.equal(m.split('\n').length, src.split('\n').length)
  assert.equal(m.includes('fake'), false, '字符串里的假声明必须被遮掉')
  assert.equal(m.includes('alsoFake'), false, '行注释里的假声明必须被遮掉')
  assert.match(m, /export function real\(\) \{\}/)
})

test('mask：模板串 `${}` 里的代码要递归遮罩 —— 这一条坏掉是漏报，不是误报', () => {
  // 插值里再套一个模板串：模板被判成提前结束时，从那一行往后整段代码被当成字符串吃掉，
  // 那批导出在门禁眼里根本不存在（报「导出找不到定义」）。
  const nested = 'export const s = `a${`b${x}c`}d`\nexport function afterNested() { return 1 }\n'
  const m1 = mask(nested)
  assert.match(m1, /export function afterNested\(\)/, '嵌套模板串不许吃掉后面的声明')
  assert.equal(m1.length, nested.length)

  // 插值跨行时最容易破：不穿透 `${}` 的扫法会一路找到文末，中间全成字符串。
  const multiline = "export const s = `a${\n  fn('x')\n}d`\nexport function afterMulti() { return 2 }\n"
  const m2 = mask(multiline)
  assert.match(m2, /export function afterMulti\(\)/)
  assert.equal(m2.includes('fn('), false, '插值里的代码要被遮罩')
  assert.equal(m2.split('\n').length, multiline.split('\n').length)
})

test('mask：转义引号不提前结束字符串 —— 否则字符串后面几十行代码全被吃掉', () => {
  const src = "const s = 'it\\'s ok'\nexport function afterEsc() { return 3 }\n"
  assert.match(mask(src), /export function afterEsc\(\)/)
  const dq = 'const s = "say \\"hi\\""\nexport function afterDq() { return 4 }\n'
  assert.match(mask(dq), /export function afterDq\(\)/)
})

test('maskString：返回结束后的下标，字面量内部被遮罩、后面的代码原样保留', () => {
  const src = 'const s = "abc"; export const t = 1'
  const out = src.split('')
  const end = maskString(src, src.indexOf('"'), out)
  assert.equal(src.slice(end).startsWith(';'), true, '返回下标应落在闭合引号之后')
  assert.equal(out.join('').includes('abc'), false)
  assert.match(out.join(''), /export const t = 1/)
})

test('mask：未闭合的字符串、未闭合的注释、空输入都不抛异常', () => {
  for (const src of ['const s = "abc', 'const s = /* abc', '/*', '`a${', 'export function f(', '']) {
    assert.doesNotThrow(() => mask(src), `不该抛异常：${JSON.stringify(src)}`)
  }
  assert.equal(mask('').length, 0)
})

test('mask(stringsToo=false)：只去注释，模块说明符必须留着 —— 吃掉它整条再导出链就断了', () => {
  const src = 'export { a } from "./x.js"\n// export { b } from "./y.js"\n'
  assert.match(mask(src, false), /from "\.\/x\.js"/)
  assert.equal(mask(src, false).includes('y.js'), false)
  assert.equal(mask(src).includes('x.js'), false, '全遮罩那份会把说明符一起吃掉')
})

// ---------------------------------------------------------------- 括号配平与切分

test('matchBracket：硬括号配平；尖括号要显式才参与；不闭合返回 -1 而不是抛异常', () => {
  const m = mask('f(a, [b], { c: (d) })')
  assert.equal(matchBracket(m, m.indexOf('(')), m.length - 1)
  assert.equal(matchBracket(m, m.indexOf('[')), m.indexOf(']'))
  const inner = m.indexOf('(d)')
  assert.equal(matchBracket(m, inner), inner + 2)

  const g = 'Record<string, T>'
  assert.equal(matchBracket(g, g.indexOf('<'), true), g.indexOf('>'))
  assert.equal(matchBracket(g, g.indexOf('<')), -1, 'angle 为假时尖括号不算括号')

  assert.equal(matchBracket('f(a', 1), -1)
  assert.equal(matchBracket('(a]', 0), -1, '错配的闭合括号不许配平成功')
  assert.equal(matchBracket('', 0), -1)
})

test('splitTop：泛型 <> 里的逗号不切碎 —— 切碎了会冒出一个叫 string 的假形参', () => {
  const m = mask('opts: Readonly<Record<string, string | boolean>>, n: number')
  const parts = splitTop(m, 0, m.length)
  assert.deepEqual(parts, ['opts: Readonly<Record<string, string | boolean>>', 'n: number'])
  assert.equal(parts.includes('string'), false, '不许出现叫 string 的碎片')
})

test('splitTop：嵌套圆括号与方括号内的逗号不算；字符串里的逗号也不算', () => {
  const cb = mask('cb: (a: string, b: number) => void, arr: string[], n: number')
  assert.deepEqual(splitTop(cb, 0, cb.length), ['cb: (a: string, b: number) => void', 'arr: string[]', 'n: number'])

  const lit = mask('s: "a,b", n: number')
  assert.deepEqual(splitTop(lit, 0, lit.length), ['s:', 'n: number'])
})

test('splitTop：箭头整体跳过；默认值里的比较运算不当泛型（否则后面的逗号被吞掉）', () => {
  const a = mask('cb: (x: number) => void, n: number')
  assert.deepEqual(splitTop(a, 0, a.length), ['cb: (x: number) => void', 'n: number'])

  const b = mask('n = 1 < 2, m: number')
  assert.deepEqual(splitTop(b, 0, b.length), ['n = 1 < 2', 'm: number'])
})

test('splitTop：空区间与全空白都返回空数组，不抛异常', () => {
  assert.deepEqual(splitTop('', 0, 0), [])
  assert.deepEqual(splitTop('   \n  ', 0, 5), [])
  assert.deepEqual(splitTop('a', 0, 0), [])
})

// ---------------------------------------------------------------- 形参取名

test('paramNames：可选、解构、默认值、剩余、修饰符都要取到绑定的名字', () => {
  assert.deepEqual(paramNames('a'), ['a'])
  assert.deepEqual(paramNames('a?: string'), ['a'])
  assert.deepEqual(paramNames('a: string = 1'), ['a'])
  assert.deepEqual(paramNames('...rest: string[]'), ['rest'])
  assert.deepEqual(paramNames('readonly cwd?: string'), ['cwd'])
  assert.deepEqual(paramNames('{ a, b }'), ['a', 'b'])
  assert.deepEqual(paramNames('{ a: x, b = 2, ...rest }'), ['a', 'b', 'rest'])
  assert.deepEqual(paramNames('   '), [])
  assert.deepEqual(paramNames('{ a, b'), [], '不闭合的解构：不抛异常，也不编出名字')
})

test('paramNames：泛型形参表不产生假形参 —— 它由 findParamsOpen 整段跳过', () => {
  assert.deepEqual(paramNames('<T>'), [])
  const m = mask('function id<T, U>(x: T): T { return x }')
  const open = findParamsOpen(m, m.indexOf('id') + 2)
  assert.deepEqual(
    splitTop(m, open + 1, matchBracket(m, open)).flatMap(paramNames),
    ['x'],
    'T 与 U 是类型形参，不是函数形参',
  )
})

// ---------------------------------------------------------------- 箭头函数识别

test('arrowParams：const LIMIT = 1024 * 1024 不是箭头 —— 判成箭头会要求常量写 @param', () => {
  const m = mask('const LIMIT = 1024 * 1024\nexport const f = (a, b) => a + b\n')
  assert.equal(arrowParams(m, m.indexOf('=')), null)
})

test('arrowParams：字符串常量后面跟着带箭头的函数时，那个常量仍不是箭头', () => {
  // 字符串已被遮罩成空格，只看等号右边会看到字符串**后面**的骨架，常量照样蒙混过关。
  const m = mask("const HINT = 'see foo'\nexport const summarize = (x: string): string => x\n")
  assert.equal(arrowParams(m, m.indexOf('=')), null)
})

test('arrowParams：真的箭头要认出来，形参表落在箭头之前；单个标识符形参也算', () => {
  const m = mask('export const f = (a, b) => a + b\nexport const g = x => x + 1\n')
  const r = arrowParams(m, m.indexOf('='))
  assert.equal(m.slice(r.open, r.close + 1), '(a, b)')
  assert.deepEqual(arrowParams(m, m.indexOf('=', m.indexOf('g'))), { text: 'x' })
})

// ---------------------------------------------------------------- JSDoc 块定位与解析

test('docBefore：注释正文里出现块起始字面量时，块起点取在上一个结束标记之后', () => {
  const src = [
    '/**',
    ' * 前一段说明，正文里提过 /** README 这种写法',
    ' * @param old 旧参数',
    ' */',
    '/**',
    ' * 目标符号的说明。',
    ' * @param a 形参说明',
    ' * @returns 数字',
    ' */',
    'export function f(a: number): number { return a }',
  ].join('\n')
  const doc = docBefore(src, src.indexOf('export function'))
  const parsed = parseDoc(doc.text)
  // 用整块的内容断言：截在字面量处时摘要会变成 README 那截、@param 会变成 old
  assert.equal(parsed.summary, '目标符号的说明。')
  assert.deepEqual(parsed.params.map((p) => p.name), ['a'])
  assert.equal(parsed.returns, '数字')
})

test('docBefore：没有块 / 中间隔着别的东西时返回 null，不抛异常', () => {
  const noDoc = 'export function f() {}\n'
  assert.equal(docBefore(noDoc, noDoc.indexOf('export function')), null)
  const separated = 'const x = 1;\n\nexport function f() {}\n'
  assert.equal(docBefore(separated, separated.indexOf('export function')), null)
  assert.equal(docBefore('/***/\nexport function f() {}\n', 12), null, '空块不算注释块')
  assert.equal(docBefore('', 0), null)
  assert.equal(docBefore('abc', 99), null, '越界位置不许抛异常')
})

test('docBefore 当前行为：/**/ 被当成「有块但没描述」，所以报的是无描述而不是缺块', () => {
  const src = '/**/\nexport function f() {}\n'
  const doc = docBefore(src, src.indexOf('export function'))
  assert.equal(parseDoc(doc.text).summary, '')
})

test('parseDoc：三种 @param 写法都能取到名字；只有标签没说明的进 emptyParams', () => {
  const block = [
    ' * 摘要。',
    ' * @param {string} a - 说明一',
    ' * @param b 说明二',
    ' * @param {number} [c=1] 说明三',
    ' * @param d',
    ' * @returns 结果',
    '',
  ].join('\n')
  const p = parseDoc(block)
  assert.equal(p.summary, '摘要。')
  assert.deepEqual(p.params.map((x) => x.name), ['a', 'b', 'c', 'd'])
  assert.deepEqual(p.emptyParams, ['d'], '@param 只有标签没有说明 = 等于没写')
  assert.equal(p.returns, '结果')
  assert.deepEqual(p.tags, ['param', 'param', 'param', 'param', 'returns'])
  assert.deepEqual(parseDoc(' * 只有摘要。').params, [])
})

// ---------------------------------------------------------------- 复述启发式

test('looksRestated：只是复述函数名的短摘要判为复述；写清理由的摘要不判（该启发式不参与退出码）', () => {
  assert.equal(looksRestated('SpawnOptions', 'spawn 的注入点。'), true)
  assert.equal(looksRestated('getX', '获取 getX。'), true)
  assert.equal(looksRestated('parseArgs', '把 argv 解析成阈值表。'), false)
  assert.equal(looksRestated('getX', '获取 x 的完整流程，这里写清楚为什么要这样做、要付出什么代价，请读完再决定'), false)
  assert.equal(looksRestated('getX', '获取 port。'), false, 'camelCase 拆词对不上中文宾语时不报警（宁可漏报）')
  assert.equal(looksRestated('getX', ''), false)
  assert.equal(looksRestated('getX', '   '), false)
})

// ---------------------------------------------------------------- 声明扫描（纯函数）

test('scanDeclarations：形参名从源码文本推出来；泛型表被跳过，void 返回被认出', () => {
  const { decls } = scanDeclarations(
    'export function pick<T>(a: T, opts: Readonly<Record<string, string | boolean>>, ...rest: string[]): void {}',
    'x.ts',
  )
  assert.deepEqual(decls.get('pick').params, ['a', 'opts', 'rest'])
  assert.equal(decls.get('pick').returnsVoid, true)

  const arrow = scanDeclarations('export const sum = (a: number, b: number) => a + b', 'x.ts')
  assert.deepEqual(arrow.decls.get('sum').params, ['a', 'b'])
  assert.equal(arrow.decls.get('sum').returnsVoid, false, '表达式体不是 void')

  const empty = scanDeclarations('export const nothing = () => {}', 'x.ts')
  assert.deepEqual(empty.decls.get('nothing').params, [])
  assert.equal(empty.decls.get('nothing').returnsVoid, true)
})

test('scanDeclarations 当前行为：returnsVoid 的尾窗会串到后一个声明的 => {}', () => {
  const src = ['export const a = (x: number) => x', 'export const b = () => {}'].join('\n')
  const { decls } = scanDeclarations(src, 'x.ts')
  assert.equal(decls.get('a').returnsVoid, true)
})

test('scanDeclarations：返回类型标在箭头前面的写法当前不被认成形参（门禁因此不查它）', () => {
  const src = 'export const typed = (): void => undefined\n'
  const { decls } = scanDeclarations(src, 'x.ts')
  assert.equal(decls.get('typed').params, null)
})

test('scanDeclarations：模板串吃不掉后面的声明 —— 吃掉就是漏报（报「导出找不到定义」）', () => {
  const src = [
    'const HINT = `use ${`${x}`} carefully`',
    'export function realExport(a: number): number { return a }',
  ].join('\n')
  const { decls } = scanDeclarations(src, 'x.ts')
  assert.equal(decls.has('realExport'), true, '模板串必须止于自己那个闭合反引号')
  assert.deepEqual(decls.get('realExport').params, ['a'])
})

test('lineOf：下标换算成行号，越界不抛异常', () => {
  const src = 'a\nb\nc'
  assert.equal(lineOf(src, 0), 1)
  assert.equal(lineOf(src, 2), 2)
  assert.equal(lineOf(src, src.length - 1), 3)
  assert.equal(lineOf(src, 9999), 3, '越界按文末夹住，不抛异常')
})

// ---------------------------------------------------------------- 说明符解析

test('resolveSpecifier：workspace 包名、相对说明符、目录索引都要落到真实 .ts，认不出返回 null', () => {
  const present = new Set([
    '/repo/packages/ports/src/index.ts',
    '/repo/packages/a/src/impl.ts',
    '/repo/packages/a/src/sub/index.ts',
  ])
  const exists = (p) => present.has(p.split('\\').join('/'))
  const from = '/repo/packages/a/src/index.ts'
  const norm = (p) => (p === null ? null : p.split('\\').join('/'))

  assert.equal(norm(resolveSpecifier(from, '@dp/ports', exists)), '/repo/packages/ports/src/index.ts')
  assert.equal(norm(resolveSpecifier(from, './impl.js', exists)), '/repo/packages/a/src/impl.ts')
  assert.equal(norm(resolveSpecifier(from, './sub.js', exists)), '/repo/packages/a/src/sub/index.ts')
  assert.equal(resolveSpecifier(from, '@dp/nope', exists), null)
  assert.equal(resolveSpecifier(from, 'node:fs', exists), null, '非 @dp 的裸说明符不猜')
  assert.equal(resolveSpecifier('/elsewhere/x.ts', '@dp/ports', exists), null, '不在 packages/ 下就没有包根')
})

// ---------------------------------------------------------------- 成员判定

test('checkMembers：成员注释就在上一行时找得到 —— 成员名起点不能用正则长度反推（会偏进名字内部）', () => {
  const src = 'export interface Cfg { /** 首项 */ path: string, /** 次项 */ type: string }'
  const { decls } = scanDeclarations(src, 'x.ts')
  const d = decls.get('Cfg')
  assert.deepEqual(membersOf(d).map((m) => m.name), ['path', 'type'])
  assert.equal(memberDocBefore(d, 'type'), '次项', '偏移错一位就会退回「成员缺 JSDoc」')
  assert.deepEqual(checkMembers(d, 'Cfg'), [])
})

test('checkMembers 当前行为：成员缺块与「块里没有描述」都报无描述 —— 非中文那条结论到不了', () => {
  const src = 'export interface Cfg { path: string, type: string, /**  */ other: string, /** plain */ third: string }'
  const { decls } = scanDeclarations(src, 'x.ts')
  assert.deepEqual(checkMembers(decls.get('Cfg'), 'Cfg'), [
    { symbol: 'Cfg.path', problem: '成员缺 JSDoc' },
    { symbol: 'Cfg.type', problem: '成员缺 JSDoc' },
    { symbol: 'Cfg.other', problem: '成员 JSDoc 无描述' },
    { symbol: 'Cfg.third', problem: '成员 JSDoc 无描述' },
  ])
})

test('membersOf 当前行为：本仓 interface 的换行写法取不出成员（切分靠顶层逗号）', () => {
  const src = ['export interface Cfg {', '  readonly a: string', '  readonly b: number', '}'].join('\n')
  const { decls } = scanDeclarations(src, 'x.ts')
  assert.deepEqual(membersOf(decls.get('Cfg')), [])
  assert.deepEqual(checkMembers(decls.get('Cfg'), 'Cfg'), [])
})

test('checkMembers：非 interface / type 的声明不产成员结论', () => {
  const src = 'export const f = (a: number) => a\n'
  const { decls } = scanDeclarations(src, 'x.ts')
  assert.deepEqual(checkMembers(decls.get('f'), 'f'), [])
})

// ---------------------------------------------------------------- @param 缺口判定

test('matchParamDocs：缺形参、多余形参、缺说明三类分开报，顺序固定', () => {
  const doc = parseDoc([' * 说明。', ' * @param a 说明', ' * @param ghost 说明', ' * @param c'].join('\n'))
  const r = matchParamDocs(['a', 'b'], doc)
  assert.deepEqual(r.missing, ['b'])
  assert.deepEqual(r.extra, ['ghost', 'c'], '既不在形参里、又缺说明的，两个结论各报一次')
  assert.deepEqual(r.empty, ['c'])
})

test('matchParamDocs 当前行为：解构字段写作 根名.字段 时取到的名字就是根名', () => {
  // paramTagName 只吃一段标识符，所以「根名.字段」这条写法落到判定里就是根名 ——
  // 缺/多余两侧都按根名判，能对上；那个专门为点号写法留的分支反而走不到。
  const doc = parseDoc([' * 说明。', ' * @param opts.path 说明'].join('\n'))
  assert.deepEqual(doc.params.map((p) => p.name), ['opts'])
  assert.deepEqual(matchParamDocs(['opts'], doc), { missing: [], extra: [], empty: [] })
  // 真写成根名而形参是解构出来的字段时才算缺
  assert.deepEqual(matchParamDocs(['opts', 'host'], doc).missing, ['host'])
})

test('matchParamDocs：没有形参信息时三侧都不报（不会把「没解析出来」当成缺口）', () => {
  const r = matchParamDocs(null, parseDoc(' * 说明。\n * @returns 结果\n'))
  assert.deepEqual(r, { missing: [], extra: [], empty: [] })
})