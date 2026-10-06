#!/usr/bin/env node
/**
 * 假测试扫描器 —— 找「跑着是绿的、但什么也没验证」的用例。
 *
 * 静态扫描只能抓「断言写坏了」，抓不到「断言写对了但夹具区分不出正确与错误的实现」。
 * 所以本脚本只报信号、不下结论：每一条都要人眼过一遍再决定修不修。
 *
 * 分级：
 *   P0 致命  零断言用例 / 形同虚设的 assert.throws / 被忽略的校验形参（退出码非 0）
 *   P1 提示  弱存在性 assert.ok / 被 skip 的用例 / 空 catch
 *
 * 另有一类「断言常量字面量」：右值是常量的 assert 是完全正常的写法，它占全部命中的
 * 九成以上。逐条铺开时真正要改的十几条会被埋掉 —— 报告工具自己有噪声，它的输出就没人看。
 * 所以默认折叠（`--verbose` 展开），且不计入 P0。判据一次没少，只是不占默认屏。
 *
 * 只用 Node 内置模块，正则 + 括号配平扫描 .ts 源码（不是 build 产物 —— 源码才是人改的）。
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKGS = join(ROOT, 'packages')

const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
// 关掉类型收窄豁免，用来对比判据本身有没有起作用（不然没人知道豁免是真判对了还是判据写空了）
const NARROW_EXEMPT = !argv.includes('--no-narrow-exempt')
// 展开「断言常量字面量」那一大段。默认折叠的理由写在文件头：它信噪比极低，
// 铺开会把真正要改的那十几条埋掉。折叠只影响默认输出，不影响任何判据与退出码。
const VERBOSE = argv.includes('--verbose')

/* ---------------------------------------------------------------- 词法遮罩 */

const PAIRS = { '(': ')', '[': ']', '{': '}' }

/**
 * 把字符串 / 模板 / 注释 / 正则字面量的内容替换成空格（换行保留），长度不变。
 * 不遮罩就没法可靠配平括号 —— 仓库里到处是 `${x}`、`/\d{2}/`、`// 注释`。
 */
function mask(src) {
  const out = src.split('')
  const n = src.length
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' ' }
  const isRegexStart = (i) => {
    for (let j = i - 1; j >= 0; j--) {
      const c = out[j]
      if (c === ' ' || c === '\n' || c === '\t') continue
      return '(,=:[!&|?{;+-*%~^<>'.includes(c) || /\b(?:return|typeof|case|in|of|do|else|yield|await)$/.test(src.slice(0, i).replace(/\s+$/, '').split(/[^\w$]/).pop() ?? '')
    }
    return true
  }
  let i = 0
  while (i < n) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') blank(i++)
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      blank(i++); blank(i)
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) blank(i++)
      if (i < n) { blank(i); blank(i + 1); i++ }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      blank(i++)
      while (i < n) {
        if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue }
        if (src[i] === q) { blank(i); i++; break }
        if (q !== '`' && src[i] === '\n') break
        blank(i); i++
      }
      continue
    }
    if (c === '/' && src[i + 1] !== '/' && src[i + 1] !== '*' && src[i + 1] !== '=' && isRegexStart(i)) {
      blank(i++)
      let inClass = false
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\') { blank(i); blank(i + 1); i += 2; continue }
        if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
        else if (src[i] === '/' && !inClass) { blank(i); i++; break }
        blank(i); i++
      }
      while (i < n && /[gimsuyvd]/.test(src[i])) { blank(i); i++ }
      continue
    }
    i++
  }
  return out.join('')
}

/** 从开括号位置找配平的闭括号，位置错乱一律返回 -1（宁可漏报也不制造假信号） */
function findMatching(masked, start) {
  const stack = [PAIRS[masked[start]]]
  if (!stack[0]) return -1
  for (let i = start + 1; i < masked.length; i++) {
    const c = masked[i]
    if (PAIRS[c]) stack.push(PAIRS[c])
    else if (c === ')' || c === ']' || c === '}') {
      if (c !== stack[stack.length - 1]) return -1
      stack.pop()
      if (!stack.length) return i
    }
  }
  return -1
}

/** 顶层实参区间 —— 嵌套的逗号不算分隔 */
function splitArgs(masked, open, close) {
  const spans = []
  let depth = 0
  let start = open + 1
  for (let i = open + 1; i < close; i++) {
    const c = masked[i]
    if (PAIRS[c]) depth++
    else if (c === ')' || c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) { spans.push([start, i]); start = i + 1 }
  }
  if (masked.slice(start, close).trim()) spans.push([start, close])
  return spans
}

function lineStarts(src) {
  const ls = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') ls.push(i + 1)
  return ls
}
const lineOf = (ls, off) => {
  let lo = 0, hi = ls.length - 1
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ls[mid] <= off) lo = mid; else hi = mid - 1 }
  return lo + 1
}
const rel = (p) => relative(ROOT, p).split('\\').join('/')
const snippet = (src, a, b) => src.slice(a, Math.min(b, src.length)).replace(/\s+/g, ' ').trim()

/* ---------------------------------------------------------------- 采集 */

function walk(dir, out = [], filter = () => true) {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'build' || e.name === 'node_modules' || e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out, filter)
    else if (filter(e.name)) out.push(p)
  }
  return out
}

const testFiles = walk(PKGS, [], (n) => n.endsWith('.test.ts'))
const srcFiles = walk(PKGS, [], (n) => n.endsWith('.ts') && !n.endsWith('.d.ts'))

const P0 = []
const P0_REPORT = []
const P1 = []
const stat = { files: testFiles.length, cases: 0, narrowingExempted: 0, narrowingFlagged: 0, blocks: [] }

const add = (bucket, level, file, line, name, msg) => bucket.push({ level, file, line, name, msg })

/* ---------------------------------------------- helper：名字含 throw/reject */

const helperRe = [
  /(?:^|[\s;{}()])(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|[\s;{}()])const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?\(/g,
]

/**
 * 找出「形参被忽略」的 throw/reject helper。
 * 只看名字带 throw/reject 的 —— 那是「声称在校验错误」的那一类，
 * 形参被丢掉就等于「抛什么都算过」。
 */
const ignoredHelpers = []
const assertingHelpers = new Set()

for (const file of srcFiles) {
  const src = readFileSync(file, 'utf8')
  const masked = mask(src)
  for (const re of helperRe) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(masked)) !== null) {
      const name = m[1]
      const open = masked.indexOf('(', m.index + m[0].length - 1)
      if (open < 0) continue
      const close = findMatching(masked, open)
      if (close < 0) continue

      // 函数体定位：函数声明是 `name(...): T { }`，箭头是 `name(...) => { }` 或 `=> expr`。
      // 两种都得认，否则 `function caughtThrows(...){...}` 整个漏掉 ——
      // 漏掉的 helper 会被当成「没有断言」，于是它的每个调用点都变成假 P0。
      const after = masked.slice(close + 1, close + 60)
      let bodyStart, bodyEnd
      if (/^\s*=\s*>/.test(after)) {
        const arrow = masked.indexOf('=>', close + 1)
        bodyStart = arrow + 2
        const braceRel = masked.slice(bodyStart, bodyStart + 4)
        if (/^\s*\{/.test(braceRel)) {
          bodyStart = masked.indexOf('{', bodyStart)
          bodyEnd = findMatching(masked, bodyStart)
        } else {
          // 表达式体：取到语句末尾即可，够判「形参有没有被引用」
          bodyEnd = bodyStart
          for (let i = bodyStart; i < masked.length; i++) {
            if (masked[i] === '\n' || masked[i] === ';' || masked[i] === '}' || masked[i] === '{') { bodyEnd = i; break }
          }
        }
      } else {
        // 函数声明：跳过返回类型标注，第一个 `{` 才是体
        bodyStart = masked.indexOf('{', close + 1)
        if (bodyStart < 0 || bodyStart - close > 60) continue
        bodyEnd = findMatching(masked, bodyStart)
      }
      if (bodyEnd < 0) continue

      const body = masked.slice(bodyStart, bodyEnd)
      const ls = lineStarts(src)
      if (/\bassert\.\w+|throw\s+new\s+Error/.test(body)) assertingHelpers.add(name)

      // 只有「声称在校验错误」的 helper 才有形参可丢：名字必须带 throw/reject。
      // 别的 helper 形参没用上不是 P0（多半是压根不接那个参数）。
      if (!/throw|reject/i.test(name)) continue
      const params = splitArgs(masked, open, close)
      params.forEach(([a, b], idx) => {
        // 形参写法很杂：`fn: T` / `_ctor?: unknown` / `ctor: Function = Cli` / `...rest`。
        // 可选形参恰好是最该被查的那类（`caughtThrows(fn, _ctor?)`），不能因为一个 `?` 就丢掉。
        const pname = src.slice(a, b).trim()
          .replace(/^\.\.\./, '')
          .split('=')[0]
          .split(':')[0]
          .replace(/\?$/, '')
          .trim()
        if (!/^[A-Za-z_$][\w$]*$/.test(pname)) return
        // 形参带 `_` 前缀 = 作者明说「这个参数不用」；名字不带 `_` 但体里从没引用 = 同样没用
        const referenced = new RegExp(`\\b${pname.replace(/^_/, '')}\\b`).test(body)
        if (pname.startsWith('_') || !referenced) {
          ignoredHelpers.push({ name, file: rel(file), line: lineOf(ls, a), param: pname, index: idx, callers: [] })
        }
      })
    }
  }
}

// 调用处：helper 形参被丢了，调用方却传了值 —— 那处「断言错误类型」是假的
// 只在 helper 所在文件内找调用处：同名 helper 在别的文件里可能是另一个实现
// （本仓 args.test.ts 的 caughtThrows 真校验了 ctor，targets.test.ts 的没校验，
//  按名字跨文件归因会把好的算成坏的）。
for (const h of ignoredHelpers) {
  for (const file of testFiles) {
    if (rel(file) !== h.file) continue
    const src = readFileSync(file, 'utf8')
    const masked = mask(src)
    const re = new RegExp(`\\b${h.name}\\s*\\(`, 'g')
    let m
    while ((m = re.exec(masked)) !== null) {
      const open = masked.indexOf('(', m.index)
      if (open < 0) continue
      const close = findMatching(masked, open)
      if (close < 0) continue
      const args = splitArgs(masked, open, close)
      // 跳过定义本身：形参位上写的是形参声明，不是实参
      const at0 = args[h.index]
      if (at0) {
        const declName = src.slice(at0[0], at0[1]).trim()
          .replace(/^\.\.\./, '').split('=')[0].split(':')[0].replace(/\?$/, '').trim()
        if (declName === h.param) continue
      }
      const at = args[h.index]
      if (!at) continue
      const passed = src.slice(at[0], at[1]).trim()
      if (!passed) continue
      h.callers.push({ file: rel(file), line: lineOf(lineStarts(src), at[0]), passed: snippet(src, at[0], at[1]) })
    }
  }
  if (h.callers.length) {
    add(P0, 'P0', h.file, h.line, `helper ${h.name}`,
      `形参 ${h.param} 从未被引用，但 ${h.callers.length} 处调用传了值（如 ${h.callers[0].file}:${h.callers[0].line} 传 ${h.callers[0].passed}）—— 这些用例实际只验证了「抛了某些东西」`)
  } else {
    add(P1, 'P1', h.file, h.line, `helper ${h.name}`,
      `形参 ${h.param} 从未被引用，当前没有调用处传值；一旦有人传了就会静默失效`)
  }
}

/* ---------------------------------------------------------------- 用例块 */

const titleRe = /(?:it|test|describe)\s*(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/

for (const file of testFiles) {
  const src = readFileSync(file, 'utf8')
  const masked = mask(src)
  const ls = lineStarts(src)
  const fileRel = rel(file)

  const re = /(^|[^\w$.])(it|test|describe)(\.(skip|todo|only))?\s*\(/g
  let m
  while ((m = re.exec(masked)) !== null) {
    const kind = m[2]
    const modifier = m[4] ?? ''
    const open = masked.indexOf('(', m.index + m[0].length - 1)
    if (open < 0) continue
    const close = findMatching(masked, open)
    if (close < 0) continue

    const titleM = titleRe.exec(src.slice(m.index, close))
    const name = titleM ? titleM[2] : '(匿名)'
    const line = lineOf(ls, open)
    const body = src.slice(open, close)
    const bodyMasked = masked.slice(open, close)

    if (kind === 'describe') {
      // describe 只登记 skip，不吃掉块体：里面的 it() 还要继续扫。
      // 本仓几乎每个文件都把全部用例包在一个 describe 里，跳过块体 = 漏报全仓。
      if (modifier === 'skip' || modifier === 'todo') {
        add(P1, 'P1', fileRel, line, name, `describe.${modifier}：整块不跑，里面的用例不提供任何保障`)
      }
      re.lastIndex = open + 1
      continue
    }
    re.lastIndex = close
    if (modifier === 'only') {
      add(P1, 'P1', fileRel, line, name, 'it.only：CI 上会静默只跑这一条，其余用例等于没跑')
    }
    stat.cases++

    const skipped = modifier === 'skip' || modifier === 'todo'
    if (skipped) {
      add(P1, 'P1', fileRel, line, name, `${kind}.${modifier}：不执行，不提供保障`)
      continue
    }

    const bodyLineOf = (off) => lineOf(ls, open + off)

    /* --- P0-1 零断言：内联 assert + 真的做断言的 helper 都没有 --- */
    const inlineAsserts = [...bodyMasked.matchAll(/\bassert\s*\.\s*\w+\s*\(/g)]
    const helperCalls = [...assertingHelpers].filter((h) =>
      new RegExp(`\\b${h}\\s*\\(`).test(bodyMasked))
    if (!inlineAsserts.length && !helperCalls.length) {
      add(P0, 'P0', fileRel, line, name, '用例体里没有任何 assert（含有断言的 helper 调用）—— 函数改成永远不抛，这用例照样绿')
    }

    /* --- P0-2 形同虚设的 assert.throws / rejects：没有第二参 = 没校验错误 ---
       注意：下面所有偏移都在 bodyMasked/body 这套「块内相对坐标」里算。
       混用文件绝对坐标会让每个括号都落到别的表达式上，报出来的行号是假的。 */
    for (const a of [...bodyMasked.matchAll(/\bassert\s*\.\s*(throws|rejects)\s*\(/g)]) {
      const o = bodyMasked.indexOf('(', a.index)
      if (o < 0) continue
      const c = findMatching(bodyMasked, o)
      if (c < 0) continue
      if (splitArgs(bodyMasked, o, c).length < 2) {
        add(P0, 'P0', fileRel, bodyLineOf(a.index), name,
          `assert.${a[1]}(fn) 没有第二个参数：只验证「抛了东西」，错误类型/码/消息一条都没验（实现抛别的错测试照样绿）`)
      }
    }

    /* --- 断言常量字面量：左边是函数调用、右边是字面量（只报告，不判死，默认折叠） --- */
    for (const a of [...bodyMasked.matchAll(/\bassert\s*\.\s*(equal|strictEqual|deepEqual|deepStrictEqual)\s*\(/g)]) {
      const o = bodyMasked.indexOf('(', a.index)
      if (o < 0) continue
      const c = findMatching(bodyMasked, o)
      if (c < 0) continue
      const spans = splitArgs(bodyMasked, o, c)
      if (spans.length < 2) continue
      const lhs = snippet(body, spans[0][0], spans[0][1])
      const rhs = snippet(body, spans[1][0], spans[1][1])
      if (/\w\s*\(/.test(lhs) && /^(?:true|false|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|null|undefined|\[\]|\{\})$/.test(rhs)) {
        add(P0_REPORT, '仅报告', fileRel, bodyLineOf(a.index), name,
          `assert.${a[1]}(${lhs}, ${rhs})：右边是常量。可能是「把输出和期望常量对比」的合法写法，也可能是把函数调用结果写死；看被测逻辑对不对`)
      }
    }

    /* --- P1-5 弱存在性 assert.ok(x)：紧跟字段断言的是类型收窄，豁免 --- */
    for (const a of [...bodyMasked.matchAll(/\bassert\s*\.\s*ok\s*\(/g)]) {
      const o = bodyMasked.indexOf('(', a.index)
      if (o < 0) continue
      const c = findMatching(bodyMasked, o)
      if (c < 0) continue
      const spans = splitArgs(bodyMasked, o, c)
      if (spans.length !== 1) continue
      const arg = snippet(body, spans[0][0], spans[0][1])
      // 只认「裸标识符 / 成员链 / 下标」：assert.ok(x > 0)、assert.ok(f()) 本身就是实质断言
      if (!/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*|\??\[[^\]]+\])*$/.test(arg)) continue
      // 豁免判据：其后 3 行内出现对同一标识符的 `x.<字段>` 断言 → 是类型收窄，不是弱断言
      let end = bodyMasked.length
      let nl = 0
      for (let i = a.index; i < bodyMasked.length; i++) {
        if (bodyMasked[i] === '\n' && ++nl > 3) { end = i; break }
      }
      const esc = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const narrowed = new RegExp(`\\b${esc}\\s*\\.\\s*[A-Za-z_$][\\w$]*`)
      if (NARROW_EXEMPT && narrowed.test(bodyMasked.slice(a.index, end))) {
        stat.narrowingExempted++
      } else {
        stat.narrowingFlagged++
        add(P1, 'P1', fileRel, bodyLineOf(a.index), name,
          `assert.ok(${arg}) 后面没有针对 ${arg} 字段的断言：只验了「非空」，它是什么内容一条都没验${NARROW_EXEMPT ? '' : '（--no-narrow-exempt）'}`)
      }
    }

    /* --- P1-7 空 catch：吞掉失败 --- */
    for (const a of [...bodyMasked.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)]) {
      const brace = bodyMasked.indexOf('{', a.index)
      const c = findMatching(bodyMasked, brace)
      if (c < 0) continue
      const inner = bodyMasked.slice(brace + 1, c)
      if (!inner.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()) {
        add(P1, 'P1', fileRel, bodyLineOf(a.index), name, '空 catch：抛了也被当成通过')
      }
    }
  }
}

/* ---------------------------------------------------------------- 输出 */

const totalP0 = P0.length
const exitCode = totalP0 > 0 ? 1 : 0

if (AS_JSON) {
  // JSON 是显式的机器出口，折叠只针对人读的默认输出 —— 这里仍然给全量。
  console.log(JSON.stringify({
    scanned: stat,
    p0Fatal: P0,
    // 不归进 p0：它不参与判失败，也不该在消费方眼里算一个 P0
    reportedOnly: { kind: '断言常量字面量', items: P0_REPORT },
    p1: P1,
    summary: { p0Fatal: totalP0, reportedOnly: P0_REPORT.length, p1: P1.length, exitCode },
  }, null, 2))
  process.exit(exitCode)
}

const line = (f) => `${f.file}:${f.line} 「${f.name}」 —— ${f.msg}`
console.log(`扫描 ${stat.files} 个测试文件，${stat.cases} 个用例（源码，非 build 产物）`)
console.log(`类型收窄豁免：${NARROW_EXEMPT ? '开' : '关（--no-narrow-exempt）'}，豁免 ${stat.narrowingExempted} 条弱存在性`)

const section = (title, list, note) => {
  if (!list.length) { console.log(`\n===== ${title}（0）=====\n  无`); return }
  console.log(`\n===== ${title}（${list.length}）${note ? ` — ${note}` : ''} =====`)
  for (const f of list) console.log('  ' + line(f))
}

section('P0 致命', P0, '退出码非 0')
if (VERBOSE) {
  section('仅报告：断言常量字面量', P0_REPORT, '合法写法很多，不影响退出码')
} else if (P0_REPORT.length) {
  console.log(
    `\n（断言常量字面量 ${P0_REPORT.length} 条已折叠：右值是常量的 assert 绝大多数是正常写法，` +
      '判据没错但信噪比太低，铺开会把上面这十几条埋掉。--verbose 逐条展开。不计入 P0，不影响退出码。）',
  )
}
section('P1 提示', P1, '不影响退出码')

console.log(`\n汇总：P0 致命 ${totalP0} · P1 ${P1.length} · 退出码 ${exitCode}`)
process.exit(exitCode)
