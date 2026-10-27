#!/usr/bin/env node
/**
 * 错误码硬编码门禁 —— `DP.*` 码只许引用 `@dp/ports` 的 `ERR` / `WARN`。
 *
 * 登记表在 `packages/ports/src/index.ts`，是唯一的定义处（那里的字面量是定义，跳过）。
 * 其余任何文件里出现码字面量都算违规：要么改成引用常量，要么先把码登记进表
 * （登记表与 `docs/failures.md` 的对应关系另有一道断言看着）。
 *
 * 用法：node scripts/check-error-codes.mjs [--json]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  codesInDoc,
  definitionRanges,
  formatCodeViolation,
  registryCodes,
  unregisteredCodeHits,
} from './check-error-codes-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const asJson = process.argv.includes('--json')

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'build' || e.name === 'node_modules' || e.name === '.tmp') continue
      walk(p, out)
    } else if (/\.(ts|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

const rel = (abs) => abs.slice(root.length).replace(/\\/g, '/').replace(/^\//, '')

const PORTS_INDEX = join(root, 'packages', 'ports', 'src', 'index.ts')
const portsSrc = readFileSync(PORTS_INDEX, 'utf8')
const registry = registryCodes(portsSrc)
const defs = definitionRanges(portsSrc)
const documented = codesInDoc(readFileSync(join(root, 'docs', 'failures.md'), 'utf8'))

const files = [...walk(join(root, 'packages')), ...walk(join(root, 'tests')), ...walk(join(root, 'scripts'))].filter(
  (f) => !f.endsWith('.d.ts'),
)

const violations = []
let scanned = 0
for (const abs of files) {
  const file = rel(abs)
  if (!existsSync(abs) || statSync(abs).isDirectory()) continue
  const src = readFileSync(abs, 'utf8')
  scanned += 1
  const skip = file === 'packages/ports/src/index.ts' ? defs : []
  for (const hit of unregisteredCodeHits(src, registry, skip, documented)) {
    violations.push({ file, ...hit })
  }
}

if (asJson) {
  process.stdout.write(`${JSON.stringify({ scanned, violations }, null, 2)}\n`)
} else {
  const lines = ['【错误码硬编码】']
  if (violations.length === 0) {
    lines.push(`  （无）${scanned} 个文件里没有未登记的码字面量（登记表 ${registry.size} 个码）`)
  } else {
    for (const v of violations) lines.push(`  ${formatCodeViolation(v)}`)
  }
  lines.push('')
  lines.push(`硬编码 ${violations.length} 处 —— 码只许引用 @dp/ports 的 ERR / WARN`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (violations.length > 0) process.exitCode = 1
