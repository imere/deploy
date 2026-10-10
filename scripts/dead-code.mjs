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
