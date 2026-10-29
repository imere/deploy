import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// 把注释抹成空格（保留换行），字符串原样保留：声明判定不吃注释，模块说明符靠字符串。
function stripComments(src) {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      for (let k = i; k < stop; k += 1) if (src[k] !== '\n') out[k] = ' '
      i = stop
      continue
    }
    i += 1
  }
  return out.join('')
}

const RE_EXPORT_DECL = /(?:^|[\s;}])export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|let|var)\s+([A-Za-z_$][\w$]*)/g
const RE_DECL = /(?:^|[\s;}])(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|let|var)\s+([A-Za-z_$][\w$]*)/g
const RE_EXPORT_ALL = /(?:^|\n)\s*export\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]([^'"]+)['"]/g
const RE_EXPORT_LIST = /(?:^|\n)\s*export\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g
const RE_LOCAL_LIST = /(?:^|\n)\s*export\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:;|(?=\n)|$)/g
const RE_IMPORT_NAMED = /(?:^|\n)\s*import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g

/** `./x.js` → ./x.ts；`@dp/y` → packages/y/src/index.ts。解析不到返回 null。 */
export function resolveSpecifier(packagesRoot, fromFile, spec) {
  if (spec.startsWith('.')) {
    const base = join(dirname(fromFile), spec.replace(/\.js$/, ''))
    for (const candidate of [base + '.ts', join(base, 'index.ts')]) {
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  const m = /^@dp\/([^/]+)$/.exec(spec)
  if (m) {
    const entry = join(packagesRoot, m[1], 'src', 'index.ts')
    return existsSync(entry) ? entry : null
  }
  return null
}

/** 一个文件里声明过的名字（含非导出；本地再导出要靠它判定真声明）。 */
function declaredNames(code) {
  const names = new Set()
  for (const m of code.matchAll(RE_DECL)) names.add(m[1])
  return names
}

/**
 * 一段源码对外暴露的名字 → 定义所在的文件。
 *
 * 判据与被替代的旧扫描器逐条对应：具名声明、具名再导出（含 as 改名）、
 * 本地再导出（顺着 import 追到真声明）、星号再导出（递归跟进）。
 */
function collectExports(packagesRoot, file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return []
  seen.add(file)
  const code = stripComments(readFileSync(file, 'utf8'))
  const decls = declaredNames(code)
  const out = []
  let m

  RE_EXPORT_DECL.lastIndex = 0
  while ((m = RE_EXPORT_DECL.exec(code)) !== null) {
    out.push({ name: m[1], want: m[1], file })
  }

  RE_EXPORT_LIST.lastIndex = 0
  while ((m = RE_EXPORT_LIST.exec(code)) !== null) {
    const target = resolveSpecifier(packagesRoot, file, m[2])
    if (!target) continue
    for (const piece of m[1].split(',')) {
      const t = piece.trim().replace(/^type\s+/, '')
      if (t === '') continue
      const parts = t.split(/\s+as\s+/)
      out.push({ name: (parts[1] ?? parts[0]).trim(), want: parts[0].trim(), file: target })
    }
  }

  // 本地再导出：名字往往是从别处 import 进来的，顺着 import 追到真声明所在的文件
  RE_LOCAL_LIST.lastIndex = 0
  const localNames = []
  while ((m = RE_LOCAL_LIST.exec(code)) !== null) {
    for (const piece of m[1].split(',')) {
      const t = piece.trim().replace(/^type\s+/, '')
      if (t === '') continue
      const parts = t.split(/\s+as\s+/)
      if (parts[0].trim() !== '') {
        localNames.push({ local: parts[0].trim(), exported: (parts[1] ?? parts[0]).trim() })
      }
    }
  }
  if (localNames.length > 0) {
    const origins = new Map()
    RE_IMPORT_NAMED.lastIndex = 0
    while ((m = RE_IMPORT_NAMED.exec(code)) !== null) {
      const target = resolveSpecifier(packagesRoot, file, m[2])
      if (!target) continue
      for (const piece of m[1].split(',')) {
        const t = piece.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (t !== '') origins.set(t, target)
      }
    }
    for (const { local, exported } of localNames) {
      const origin = origins.get(local)
      if (origin !== undefined) {
        for (const e of collectExports(packagesRoot, origin, seen)) {
          if (e.name === local) out.push({ name: exported, want: e.want, file: e.file })
        }
      } else if (decls.has(local)) {
        out.push({ name: exported, want: local, file })
      }
    }
  }

  // 先收齐再递归：/g 正则带 lastIndex，递归里再跑同一正则会互相踩
  RE_EXPORT_ALL.lastIndex = 0
  const stars = []
  while ((m = RE_EXPORT_ALL.exec(code)) !== null) {
    const target = resolveSpecifier(packagesRoot, file, m[1])
    if (target) stars.push(target)
  }
  for (const target of stars) {
    for (const e of collectExports(packagesRoot, target, seen)) out.push(e)
  }

  return out
}

/**
 * 全仓公共 API 面：从每个包的 src/index.ts 出发，barrel 可达的
 * 「定义文件 → 定义处的名字集合」。
 *
 * @param {string} packagesRoot packages 目录绝对路径
 * @returns {Map<string, Set<string>>} 定义文件（posix 相对路径）→ 名字集合
 */
export function publicApiByFile(packagesRoot) {
  const byFile = new Map()
  const add = (file, name) => {
    const posix = file.split('\\').join('/')
    if (!byFile.has(posix)) byFile.set(posix, new Set())
    byFile.get(posix).add(name)
  }
  const entries = readdirSync(packagesRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  for (const dir of entries) {
    const index = join(packagesRoot, dir, 'src', 'index.ts')
    if (!existsSync(index)) continue
    for (const entry of collectExports(packagesRoot, index)) {
      add(entry.file, entry.want)
    }
  }
  return byFile
}
