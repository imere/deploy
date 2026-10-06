/**
 * 死代码门禁：找出没人引用的导出符号与没人 import 的源文件。
 *
 * 为什么判定要保守到宁可漏报：一个误报会把人推向「删掉真在用的东西」，
 * 而漏报只是让人多留一段暂时没人调的代码 —— 两者代价不对等，所以本脚本
 * 只有在「零引用」这种能被静态证明的前提下才下确认结论，其余一律进可疑节。
 *
 * 三档结论（分档比二分更稳：把「只有测试在用」和「没人用」分开，
 * 前者常常是合理的内部 API，后者才是真该清的东西）：
 *   确认  非包入口的源文件里，符号在全仓（含测试）零引用
 *   可疑  仅测试引用 / 声明所在文件本身就是死的 / 包入口的公共 API /
 *         动态 import 或解构导出无法静态解析
 *   活    除上述外一律不报
 *
 * 为什么用两份文本视图：`import { x } from './y'` 的路径本身就是字符串，
 * 在「去掉字符串」的视图里它已经变成空白 —— 用同一份文本既抽说明符又数标识符，
 * 必然把全仓判成互不引用。specifier 走去注释视图，标识符计数走去字符串视图。
 *
 * 不用 typescript 编译器：本仓有它，但引进来会让门禁脚本的启动变成秒级，
 * 这里的判断只需要「去注释去字符串后的标识符计数」，手写扫描足够。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, dirname, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const asJson = process.argv.includes('--json')

/** 建产物与依赖目录：里面的 .d.ts 是编译输出，不是源码。 */
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.tmp'])

/** 由 `node --test` 按文件名发现执行，不靠 import，结构上必然无仓内引用方。 */
const isTestFile = (rel) => rel.endsWith('.test.ts')

/** 包入口：对外 API 表面，仓内无引用不等于外部无引用。 */
const isPkgEntry = (rel) => /(^|[\\/])src[\\/]index\.ts$/.test(rel)

const toRel = (p) => relative(root, p).split('\\').join('/')

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(p, out)
    } else if (e.isFile() && /\.(tsx?|mjs|cjs|mts)$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

/**
 * 扫描器。`keepStrings` 决定字面量内容是留是抹 —— 两种用途各要一份。
 *
 * 模板串要区别对待：`${...}` 里是真代码（两种视图都留），其余是字面量。
 * 这是本脚本最容易出错的地方，所以写成显式的帧栈而不是逐状态猜测。
 */
function scan(src, keepStrings) {
  let out = ''
  let i = 0
  const stack = [{ type: 'code', braces: 0 }]
  let lastSig = ''
  let lastWord = ''

  /** 除号还是正则起始：靠前一个有效字符判断，看不准就当除号（少剥一层，偏向漏报）。 */
  const regexAllowed = () => {
    if (lastSig === '') return true
    if ('(,=:[!&|?{};+-*%<>~^'.includes(lastSig)) return true
    return [
      'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
      'do', 'else', 'yield', 'await', 'instanceof',
    ].includes(lastWord)
  }

  const literal = (c) => {
    if (keepStrings) out += c
    else out += c === '\n' ? '\n' : ' '
  }

  while (i < src.length) {
    const frame = stack[stack.length - 1]
    const c = src[i]

    if (frame.type === 'tpl') {
      if (c === '\\') {
        out += keepStrings ? src.slice(i, i + 2) : (src[i + 1] === '\n' ? ' \n' : '  ')
        i += 2
        continue
      }
      if (c === '`') {
        out += keepStrings ? '`' : ' '
        i += 1
        stack.pop()
        lastSig = '`'
        lastWord = ''
        continue
      }
      if (c === '$' && src[i + 1] === '{') {
        out += '${'
        i += 2
        stack.push({ type: 'code', braces: 0 })
        continue
      }
      literal(c)
      i += 1
      continue
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }

    if (c === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 2
      continue
    }

    if (c === '"' || c === "'") {
      literal(c)
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') {
          out += keepStrings ? src.slice(i, i + 2) : (src[i + 1] === '\n' ? ' \n' : '  ')
          i += 2
          continue
        }
        if (src[i] === c) {
          literal(c)
          i += 1
          break
        }
        if (src[i] === '\n') break
        literal(src[i])
        i += 1
      }
      lastSig = '"'
      lastWord = ''
      continue
    }

    if (c === '`') {
      literal('`')
      i += 1
      stack.push({ type: 'tpl' })
      lastSig = '`'
      lastWord = ''
      continue
    }

    if (c === '/' && regexAllowed()) {
      let j = i + 1
      let inClass = false
      let ok = false
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        else if (src[j] === '/' && !inClass) {
          ok = true
          break
        }
        j += 1
      }
      if (ok) {
        const tail = /^[a-z]*/.exec(src.slice(j + 1))?.[0] ?? ''
        out += keepStrings ? src.slice(i, j + 1 + tail.length) : ' '.repeat(j - i + 1 + tail.length)
        i = j + 1 + tail.length
        lastSig = '/'
        lastWord = ''
        continue
      }
    }

    if (c === '{') frame.braces += 1
    if (c === '}') {
      if (frame.braces === 0 && stack.length > 1) {
        out += keepStrings ? '}' : ' '
        i += 1
        stack.pop()
        continue
      }
      frame.braces -= 1
    }

    out += c
    if (/\S/.test(c)) {
      lastSig = c
      lastWord = /[\w$]/.test(c) ? lastWord + c : ''
    } else if (!/[\w$]/.test(c)) {
      lastWord = ''
    }
    i += 1
  }

  return out
}

/** 偏移 → 行号（1 起）。 */
function makeLineAt(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** 收集 `export` 声明。输入是去字符串视图 —— 声明不在字面量里。 */
function collectDeclarations(code) {
  const lineAt = makeLineAt(code)
  const decls = new Map()
  const uncertain = []

  const re = /(?<![\w$.])export\s+(?:declare\s+)?(?:abstract\s+)?(?:(async)\s+)?(function|class|const|let|var|interface|type|enum|namespace)\s+(\*?\s*[A-Za-z_$][\w$]*)/g
  for (const m of code.matchAll(re)) {
    const kind = m[2]
    const raw = m[3].replace('*', '').trim()
    const offset = m.index + m[0].lastIndexOf(raw)
    if (decls.has(raw)) continue
    decls.set(raw, { name: raw, kind, offset, line: lineAt(offset) })
    // 多声明符 `export const a = 1, b = 2` 只认得到第一个，剩下的不猜
    if (/^\s*,\s*[A-Za-z_$][\w$]*\s*(:|=|,)/.test(code.slice(offset + raw.length))) {
      uncertain.push({ name: raw, line: lineAt(offset), reason: '多声明符导出只解析出第一个名字，其余未计入' })
    }
  }

  for (const m of code.matchAll(/(?<![\w$.])export\s+(?:default\b)/g)) {
    uncertain.push({ name: null, line: lineAt(m.index), reason: '存在 export default，按约定不查' })
  }
  for (const m of code.matchAll(/(?<![\w$.])export\s*(?:declare\s+)?(?:async\s+)?(?:function\s*|class\s*|const\s*|let\s*|var\s*)?\{/g)) {
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 2)
    if (after.startsWith('{')) {
      uncertain.push({ name: null, line: lineAt(m.index), reason: '解构导出，无法静态列出名字' })
    }
  }

  return { decls, uncertain }
}

/** 收集 import / export-from 的说明符。输入是去注释视图 —— 说明符是字符串，不能抹。 */
function collectSpecifiers(code) {
  const lineAt = makeLineAt(code)
  const edges = []
  const forwards = []
  const dynamic = []

  // import 之后到下一个分号/换行起的新 import 之前，才算同一条语句
  for (const m of code.matchAll(/(?<![\w$.])import\b/g)) {
    const window = code.slice(m.index, m.index + 400)
    const stop = window.slice(1).search(/;|(?<![\w$.])import\b/)
    const stmt = stop === -1 ? window : window.slice(0, stop + 1)
    if (/^\s*import\s*['"]/.test(stmt)) {
      const lit = /^\s*import\s*(['"])([^'"]+)\1/.exec(stmt)
      if (lit) edges.push({ spec: lit[2], line: lineAt(m.index), kind: 'static' })
      continue
    }
    const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(stmt)
    if (from) edges.push({ spec: from[2], line: lineAt(m.index), kind: 'static' })
    else if (/\(\s*$/.test(stmt)) {
      // import ( 不是静态 import，交给下面的动态分支
    }
  }

  for (const m of code.matchAll(/(?<![\w$.])import\s*\(\s*([^()]*?)\s*\)/g)) {
    const arg = m[1].trim()
    const lit = /^(['"])([^'"]+)\1$/.exec(arg)
    if (lit) edges.push({ spec: lit[2], line: lineAt(m.index), kind: 'dynamic' })
    else dynamic.push({ raw: arg.slice(0, 60), line: lineAt(m.index) })
  }

  for (const m of code.matchAll(/(?<![\w$.])export\s*\*\s*from\s*(['"])([^'"]+)\1/g)) {
    forwards.push({ spec: m[2], line: lineAt(m.index), star: true })
  }
  for (const m of code.matchAll(/(?<![\w$.])export\s*(?:type\s*)?\{[^}]*\}\s*from\s*(['"])([^'"]+)\1/g)) {
    forwards.push({ spec: m[2], line: lineAt(m.index), star: false })
  }

  return { edges, forwards, dynamic }
}

/** 相对说明符 → 仓库内绝对路径。`./x.js` 要同时试 `.ts`（TS 的 ESM 写法）。 */
function resolveSpecifier(fromFile, spec) {  if (spec.startsWith('.')) {
    const base = resolvePath(dirname(fromFile), spec)
    const tries = [base]
    if (base.endsWith('.js')) tries.push(base.slice(0, -3) + '.ts')
    if (base.endsWith('.mjs')) tries.push(base.slice(0, -4) + '.mts')
    if (!/\.[cm]?[jt]sx?$/.test(base)) {
      tries.push(`${base}.ts`, join(base, 'index.ts'), `${base}.mjs`, join(base, 'index.mjs'))
    }
    for (const t of tries) {
      try {
        if (statSync(t).isFile()) return t
      } catch {
        /* 候选不存在，试下一个 */
      }
    }
    return null
  }
  const dp = /^@dp\/([^/]+)$/.exec(spec)
  if (dp) {
    const cand = join(root, 'packages', dp[1], 'src', 'index.ts')
    try {
      if (statSync(cand).isFile()) return cand
    } catch {
      /* 包不存在 */
    }
  }
  return null
}

// ---------------------------------------------------------------- 扫描

/**
 * package.json 声明的入口：bin / main / types / exports。
 *
 * 这些文件由 package manager 或 `dp` 命令行直接加载，仓内永远不会有 import 边 ——
 * 不豁免的话每个包的 bin 都会被稳定地报成死文件。
 */
function collectPackageEntries() {
  const entries = new Set()
  const addTarget = (pkgDir, value) => {
    if (typeof value !== 'string' || !value.startsWith('.')) return
    const abs = join(pkgDir, value.replace(/^\.\//, ''))
    // 字段指向编译产物，源码在同名 src 下
    const src = abs
      .replace(/([\\/])build([\\/])/, '$1src$1')
      .replace(/\.d\.ts$/, '.ts')
      .replace(/\.js$/, '.ts')
      .replace(/\.mjs$/, '.mts')
    for (const cand of [abs, src]) {
      if (candidates.has(cand)) entries.add(cand)
    }
  }
  const flattenExports = (v, out = []) => {
    if (typeof v === 'string') out.push(v)
    else if (v && typeof v === 'object') for (const x of Object.values(v)) flattenExports(x, out)
    return out
  }
  for (const pkg of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const pkgDir = join(root, 'packages', pkg.name)
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    for (const v of flattenExports(manifest.bin ?? [])) addTarget(pkgDir, v)
    for (const key of ['main', 'types', 'module', 'browser']) addTarget(pkgDir, manifest[key])
    for (const v of flattenExports(manifest.exports ?? [])) addTarget(pkgDir, v)
  }
  return entries
}

/**
 * 被检测的源码范围只有各包 src；scripts 与根级脚本只作为「引用方」参与计数。
 * 脚本本身由 package.json 的 npm scripts 调起、从不互相 import，放进来只会
 * 稳定地报出「无人 import」，是噪声而不是发现。
 */
const analyzed = walk(join(root, 'packages'))
  .filter((p) => p.includes(`${sep}src${sep}`))
const referrers = [...analyzed, ...walk(join(root, 'scripts')), ...walk(root).filter((p) => dirname(p) === root)]

/** 全部已知源码路径：package.json 的入口字段要拿它来把编译产物对回源文件。 */
const candidates = new Set([...analyzed, ...referrers])
const packageEntries = collectPackageEntries()

const load = (p) => {
  const raw = readFileSync(p, 'utf8')
  const bare = scan(raw, true)
  const { decls, uncertain } = collectDeclarations(scan(raw, false))
  const { edges, forwards, dynamic } = collectSpecifiers(bare)
  const rel = toRel(p)
  return {
    path: p,
    rel,
    code: scan(raw, false),
    isTest: isTestFile(rel),
    isEntry: isPkgEntry(rel),
    decls,
    uncertain,
    edges,
    forwards,
    dynamic,
  }
}

const scopeFiles = analyzed.map(load)
const allFiles = [...scopeFiles, ...referrers.filter((p) => !analyzed.includes(p)).map(load)]
const byPath = new Map(allFiles.map((f) => [f.path, f]))

// ---------------------------------------------------------------- B：文件级

const importers = new Map(allFiles.map((f) => [f.path, []]))
for (const f of allFiles) {
  // `export … from './x'` 同样会把 x 载入模块图（再导出也是引用），漏掉它会把
  // 纯转发型包（index 只做 export { } from）的每个文件都判成死文件
  for (const e of [...f.edges, ...f.forwards.map((w) => ({ spec: w.spec }))]) {
    const target = resolveSpecifier(f.path, e.spec)
    if (!target) continue
    if (importers.has(target)) importers.get(target).push(f)
  }
}

const deadFiles = scopeFiles.filter(
  (f) => !f.isEntry && !f.isTest && !packageEntries.has(f.path) && importers.get(f.path).length === 0,
)
const deadFileSet = new Set(deadFiles.map((f) => f.path))

// ---------------------------------------------------------------- A：符号级

/** `export * from './x'` 让 x 的导出全部变活 —— 必须顺着追，x 再转发 y 同样要追。 */
const starTargets = new Map(allFiles.map((f) => [f.path, new Set()]))
for (const f of allFiles) {
  for (const fw of f.forwards) {
    if (!fw.star) continue
    const t = resolveSpecifier(f.path, fw.spec)
    if (t) starTargets.get(f.path).add(t)
  }
}

const starReach = new Map(allFiles.map((f) => [f.path, new Set()]))
for (let round = 0; round <= allFiles.length; round += 1) {
  let dirty = false
  for (const f of allFiles) {
    for (const t of starTargets.get(f.path)) {
      if (starReach.get(f.path).has(t)) continue
      starReach.get(f.path).add(t)
      dirty = true
      for (const t2 of starReach.get(t)) starReach.get(f.path).add(t2)
    }
  }
  if (!dirty) break
}

const starredBy = new Map(allFiles.map((f) => [f.path, new Set()]))
for (const f of allFiles) {
  for (const t of starReach.get(f.path)) starredBy.get(t).add(f.path)
}

const suspicious = []
const confirmed = []

const countRefs = (file, name, skipOffset) => {
  const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g')
  let count = 0
  for (const m of file.code.matchAll(re)) {
    if (skipOffset != null && m.index >= skipOffset && m.index < skipOffset + name.length) continue
    count += 1
  }
  return count
}

for (const f of scopeFiles) {
  for (const u of f.uncertain) {
    suspicious.push({ kind: 'parse', file: f.rel, line: u.line, name: u.name, reason: u.reason })
  }
  for (const d of f.dynamic) {
    suspicious.push({
      kind: 'dynamic-import',
      file: f.rel,
      line: d.line,
      name: null,
      reason: `动态 import 的参数不是字面量（${d.raw}），无法静态判定其指向的文件是否存活`,
    })
  }
}

for (const f of scopeFiles) {
  for (const [name, decl] of f.decls) {
    let prodRefs = 0
    let testRefs = 0
    for (const g of allFiles) {
      if (g === f) continue
      const n = countRefs(g, name, null)
      if (n === 0) continue
      if (g.isTest) testRefs += n
      else prodRefs += n
    }
    // 声明所在文件内部的使用也算引用，声明处本身不算
    const selfRefs = countRefs(f, name, decl.offset)
    if (f.isTest) testRefs += selfRefs
    else prodRefs += selfRefs
    // 星号转发是本仓唯一的公开路径，也算引用
    for (const p of starredBy.get(f.path)) {
      if (p === f.path) continue
      if (byPath.get(p)?.isTest) testRefs += 1
      else prodRefs += 1
    }

    if (prodRefs > 0) continue

    const entry = { kind: 'dead-symbol', file: f.rel, line: decl.line, name, kindDecl: decl.kind }
    if (deadFileSet.has(f.path)) {
      suspicious.push({ ...entry, reason: '声明所在文件本身没有任何引用方，其存废随该文件一并判断' })
    } else if (f.isEntry) {
      suspicious.push({ ...entry, reason: '包入口的公共 API，仓内无引用不代表外部无引用' })
    } else if (testRefs > 0) {
      suspicious.push({ ...entry, reason: `仅被测试引用 ${testRefs} 处，测试之外无人使用` })
    } else {
      confirmed.push({ ...entry, reason: '全仓（含测试）零引用' })
    }
  }
}

for (const f of deadFiles) {
  confirmed.push({ kind: 'dead-file', file: f.rel, line: 1, name: null, reason: '没有任何 .ts / .mjs 文件 import 它' })
}

confirmed.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
suspicious.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

// ---------------------------------------------------------------- 输出

if (asJson) {
  process.stdout.write(`${JSON.stringify({ dead: confirmed, suspicious }, null, 2)}\n`)
} else {
  const lines = ['【确认的死代码】']
  if (confirmed.length === 0) lines.push('  （无）')
  for (const c of confirmed) {
    const what = c.kind === 'dead-file' ? '文件' : `符号 ${c.name}（${c.kindDecl}）`
    lines.push(`  ${c.file}:${c.line}  ${what} —— ${c.reason}`)
  }
  lines.push('')
  lines.push('【以下无法静态确认，需人工判断】')
  if (suspicious.length === 0) lines.push('  （无）')
  for (const s of suspicious) {
    const what = s.name ? `符号 ${s.name}` : s.kind === 'parse' ? '导出语句' : '动态 import'
    lines.push(`  ${s.file}:${s.line}  ${what} —— ${s.reason}`)
  }
  lines.push('')
  lines.push(`死代码 ${confirmed.length} 处 / 可疑 ${suspicious.length} 处`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (confirmed.length > 0) process.exitCode = 1
