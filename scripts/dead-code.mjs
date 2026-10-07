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
import { join, relative, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  collectDeclarations,
  collectSpecifiers,
  countRefs,
  isPkgEntry,
  isTestFile,
  scan,
  specifierCandidates,
  starReach,
} from './dead-code-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const asJson = process.argv.includes('--json')

/** 建产物与依赖目录：里面的 .d.ts 是编译输出，不是源码。 */
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.tmp'])

const toRel = (p) => relative(root, p).split('\\').join('/')

/** 候选顺序由纯规则给出，这里只判命中 —— 文件系统不参与规则本身。 */
function resolveSpecifier(fromFile, spec) {
  for (const t of specifierCandidates(root, fromFile, spec)) {
    try {
      if (statSync(t).isFile()) return t
    } catch {
      /* 候选不存在，试下一个 */
    }
  }
  return null
}

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

const reach = starReach(allFiles.map((f) => f.path), starTargets)

const starredBy = new Map(allFiles.map((f) => [f.path, new Set()]))
for (const f of allFiles) {
  for (const t of reach.get(f.path)) starredBy.get(t).add(f.path)
}

const suspicious = []
const confirmed = []

/** 引用计数走 code 视图，声明处那次不算引用。 */
const countIn = (file, name, skipOffset) => countRefs(file.code, name, skipOffset)

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
      const n = countIn(g, name, null)
      if (n === 0) continue
      if (g.isTest) testRefs += n
      else prodRefs += n
    }
    // 声明所在文件内部的使用也算引用，声明处本身不算
    const selfRefs = countIn(f, name, decl.offset)
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
