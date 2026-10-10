import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { declaredDeps, formatViolation, undeclaredImports } from './check-deps-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const PKGS = join(root, 'packages')
const asJson = process.argv.includes('--json')

/** 递归列出目录下所有 .ts 文件，返回相对该包 src 的路径。 */
function walkSrc(dir, base, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'build') continue
      walkSrc(p, base, out)
    } else if (e.name.endsWith('.ts')) {
      out.push([p.slice(base.length + 1).split(sep).join('/'), p])
    }
  }
  return out
}

const pkgDirs = readdirSync(PKGS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

const violations = []
for (const dir of pkgDirs) {
  const pkgJsonPath = join(PKGS, dir, 'package.json')
  let pkgJson
  try {
    pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
  } catch {
    continue
  }
  const srcDir = join(PKGS, dir, 'src')
  try {
    statSync(srcDir)
  } catch {
    continue
  }
  const files = new Map()
  for (const [rel, abs] of walkSrc(srcDir, srcDir)) {
    files.set(rel, readFileSync(abs, 'utf8'))
  }
  const declared = declaredDeps(pkgJson)
  violations.push(...undeclaredImports(dir, pkgJson.name ?? `@dp/${dir}`, files, declared))
}

violations.sort((a, b) => a.file.localeCompare(b.file) || a.dep.localeCompare(b.dep))

if (asJson) {
  process.stdout.write(`${JSON.stringify({ violations }, null, 2)}\n`)
} else {
  const lines = ['【未声明的跨包引用】']
  if (violations.length === 0) lines.push('  （无）')
  for (const v of violations) {
    const pkgName = `@dp/${v.file.split('/')[0]}`
    lines.push(`  ${formatViolation(v, pkgName)}`)
  }
  lines.push('')
  lines.push(`未声明 ${violations.length} 处 —— 本地靠 junction 能解析，pnpm isolated 布局下会 TS2307`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (violations.length > 0) process.exitCode = 1
