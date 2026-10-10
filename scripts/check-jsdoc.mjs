import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CJK,
  checkMembers,
  docBefore,
  lineOf,
  looksRestated,
  matchParamDocs,
  parseDoc,
  resolveSpecifier,
  scanDeclarations,
} from './check-jsdoc-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'packages')

// 遮罩、括号配平、形参切分、注释块定位、块解析、复述启发式都在 rules 模块里：

// index.ts 导出解析

const cache = new Map()
function loadFile(file) {
  if (!cache.has(file)) cache.set(file, scanDeclarations(readFileSync(file, 'utf8'), file))
  return cache.get(file)
}

const RE_EXPORT_ALL = /(?:^|\n)\s*export\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]([^'"]+)['"]/g
const RE_EXPORT_LIST = /(?:^|\n)\s*export\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g
// 末尾不能只认 `;` 与字符串结尾：没有 m 标志时 `$` 只匹配全文末尾，
const RE_LOCAL_LIST = /(?:^|\n)\s*export\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:;|(?=\n)|$)/g
// 本地再导出的名字往往是从别处 import 进来的，要顺着 import 才能追到真声明所在的文件
const RE_IMPORT_NAMED = /(?:^|\n)\s*import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g
const RE_EXPORT_DECL = /(?:^|\n)\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|let|var)\s+([A-Za-z_$][\w$]*)/g

/** 收集一个文件对外暴露的名字 → 定义所在文件。跟随 `export *` 与具名再导出。 */
function collectExports(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return []
  seen.add(file)
  const { codeOnly, decls } = loadFile(file)
  const out = []

  RE_EXPORT_DECL.lastIndex = 0
  let m
  while ((m = RE_EXPORT_DECL.exec(codeOnly)) !== null) {
    if (decls.has(m[1])) out.push({ name: m[1], file })
  }

  RE_EXPORT_LIST.lastIndex = 0
  while ((m = RE_EXPORT_LIST.exec(codeOnly)) !== null) {
    const target = resolveSpecifier(file, m[2], existsSync)
    if (!target) continue
    for (const piece of m[1].split(',')) {
      const t = piece.trim()
      if (t === '') continue
      const parts = t.replace(/^type\s+/, '').split(/\s+as\s+/)
      const local = parts[0].trim()
      const exported = (parts[1] ?? parts[0]).trim()
      out.push({ name: exported, want: local, file: target })
    }
  }

  // 本地再导出（`export { a }` / `export type { T }`，不带 from）：名字可能就声明在本文件，
  RE_LOCAL_LIST.lastIndex = 0
  const localNames = []
  while ((m = RE_LOCAL_LIST.exec(codeOnly)) !== null) {
    for (const piece of m[1].split(',')) {
      const t = piece.trim().replace(/^type\s+/, '')
      if (t === '') continue
      const parts = t.split(/\s+as\s+/)
      const local = parts[0].trim()
      if (local !== '') localNames.push({ local, exported: (parts[1] ?? parts[0]).trim() })
    }
  }
  if (localNames.length > 0) {
    const origins = new Map()
    RE_IMPORT_NAMED.lastIndex = 0
    while ((m = RE_IMPORT_NAMED.exec(codeOnly)) !== null) {
      const target = resolveSpecifier(file, m[2], existsSync)
      if (!target) continue
      for (const piece of m[1].split(',')) {
        const t = piece.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (t !== '') origins.set(t, target)
      }
    }
    for (const { local, exported } of localNames) {
      const origin = origins.get(local)
      if (origin !== undefined) {
        for (const e of collectExports(origin, seen)) {
          if ((e.want ?? e.name) === local) out.push({ name: exported, want: e.want ?? e.name, file: e.file })
        }
      } else if (decls.has(local)) {
        out.push({ name: exported, want: local, file })
      }
    }
  }

  // 先把匹配收齐再递归：RE_* 是模块级 /g 正则，递归进入子文件会把它自己的
  RE_EXPORT_ALL.lastIndex = 0
  const starTargets = []
  while ((m = RE_EXPORT_ALL.exec(codeOnly)) !== null) {
    const target = resolveSpecifier(file, m[1], existsSync)
    if (target) starTargets.push(target)
  }
  for (const target of starTargets) {
    for (const e of collectExports(target, seen)) out.push(e)
  }

  return out
}

/** 把 { name, want, file } 落到真实声明上；同包内再翻一层（barrel → impl）。 */
function locate(entry, depth = 0) {
  const { decls } = loadFile(entry.file)
  const key = entry.want ?? entry.name
  if (decls.has(key)) return decls.get(key)
  if (depth > 2) return null
  // seen 必须从空集合起：collectExports 开头就是 `seen.has(file) → 返回空`，
  for (const e of collectExports(entry.file, new Set())) {
    if (e.name !== key) continue
    const hit = locate({ ...e, want: e.want ?? e.name }, depth + 1)
    if (hit) return hit
  }
  return null
}

// 校验

const findings = []
const restated = []
let checked = 0

function add(decl, symbol, problem) {
  findings.push({
    file: relative(root, decl.file).replace(/\\/g, '/'),
    line: lineOf(decl.src, decl.pos),
    symbol,
    problem,
  })
}

function checkDecl(decl, exportedName) {
  checked += 1
  const label = exportedName
  const doc = docBefore(decl.src, decl.declStart)
  if (!doc) {
    add(decl, label, '缺 JSDoc 块')
    return
  }
  const parsed = parseDoc(doc.text)
  if (parsed.summary === '') {
    add(decl, label, 'JSDoc 无描述')
  } else if (!CJK.test(parsed.summary)) {
    add(decl, label, '描述非中文')
  } else if (looksRestated(exportedName, parsed.summary)) {
    restated.push({ file: relative(root, decl.file).replace(/\\/g, '/'), line: lineOf(decl.src, decl.pos), symbol: label, summary: parsed.summary.split('\n')[0] })
  }

  const isFn = decl.kind === 'function' || decl.params !== null
  if (isFn) {
    const { missing, extra, empty } = matchParamDocs(decl.params, parsed)
    for (const name of missing) add(decl, label, `形参 ${name} 没有 @param`)
    for (const name of extra) add(decl, label, `@param ${name} 不是实际形参`)
    for (const name of empty) add(decl, label, `@param ${name} 缺说明`)
    if (parsed.returns === null && !decl.returnsVoid) {
      add(decl, label, '缺 @returns')
    }
    if (parsed.returns !== null && decl.returnsVoid) {
      restated.push({ file: relative(root, decl.file).replace(/\\/g, '/'), line: lineOf(decl.src, decl.pos), symbol: label, summary: '返回 void 的函数不必写 @returns，可删掉' })
    }
  }

  for (const f of checkMembers(decl, label)) add(decl, f.symbol, f.problem)
}

// 主流程

const packageDirs = existsSync(packagesDir)
  ? readdirSync(packagesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : []

for (const pkg of packageDirs) {
  const index = join(packagesDir, pkg, 'src', 'index.ts')
  if (!existsSync(index)) continue
  const exported = collectExports(index)
  const done = new Set()
  for (const entry of exported) {
    if (done.has(entry.name)) continue
    done.add(entry.name)
    const decl = locate(entry)
    if (!decl) {
      findings.push({ file: relative(root, entry.file).replace(/\\/g, '/'), line: 1, symbol: entry.name, problem: '导出找不到定义' })
      continue
    }
    checkDecl(decl, entry.name)
  }
}

findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
restated.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    checked,
    missing: findings.length,
    restated: restated.length,
    findings,
    restatedHints: restated,
  }, null, 2))
} else {
  for (const f of findings) console.log(`${f.file}:${f.line} ${f.symbol} —— ${f.problem}`)
  for (const r of restated) console.log(`${r.file}:${r.line} ${r.symbol} —— 疑似复述（不判失败）：${r.summary}`)
  console.log(`\n检查 ${checked} 个公共 API 符号：缺 JSDoc ${findings.length} 处 / 疑似复述 ${restated.length} 处`)
}

if (findings.length > 0) process.exitCode = 1
