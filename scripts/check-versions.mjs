#!/usr/bin/env node
/**
 * 版本号一致性门禁 —— 根与 packages/* 下的包必须是同一个版本号。
 *
 * 用法：node scripts/check-versions.mjs [--json]
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { formatVersionViolation, versionMismatches } from './check-versions-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const asJson = process.argv.includes('--json')

const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const baseline = rootPkg.version ?? ''

const entries = []
for (const e of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!e.isDirectory()) continue
  const pkgPath = join(root, 'packages', e.name, 'package.json')
  if (!existsSync(pkgPath)) continue
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  entries.push({ name: pkg.name ?? `@dp/${e.name}`, version: pkg.version ?? '' })
}

const violations = versionMismatches(entries, baseline)

if (asJson) {
  process.stdout.write(`${JSON.stringify({ baseline, violations }, null, 2)}\n`)
} else {
  const lines = ['【版本号一致性】']
  if (violations.length === 0) {
    lines.push(`  （无）根与 ${entries.length} 个包同版本：${baseline}`)
  } else {
    for (const v of violations) lines.push(`  ${formatVersionViolation(v)}`)
  }
  lines.push('')
  lines.push(`不一致 ${violations.length} 处 —— 单仓同版本，改版本号要一起改`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (violations.length > 0) process.exitCode = 1
