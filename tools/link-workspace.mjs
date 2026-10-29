/**
 * 补 pnpm 建不出来的顶层链接。
 *
 * 有些环境下 pnpm 的软链会被静默写成 0 字节普通文件，isolated 布局于是少了
 * `node_modules/<pkg>` 这一层 —— 包其实完整躺在 `.pnpm` 里，但解析时看不见，
 * 报出来的是「找不到模块」，看不出真正原因。这里用 junction 把它们补上：
 * junction 在这类环境里可用，而 symlink 不行。
 *
 * 只补**确实缺失**的链接：已有的一律不动，好环境里这个脚本是空操作。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const nm = join(root, 'node_modules')

/**
 * 把链接补成 junction。已存在且指向正确就跳过；存在但不是链接就删掉重建
 * —— 不删的后患是「看起来有、实际是空文件」，比没有更难查。
 */
function ensureJunction(target, linkPath) {
  if (existsSync(linkPath)) {
    try {
      if (readlinkSync(linkPath).replace(/\//g, sep) === target.replace(/\//g, sep)) return false
    } catch {
      // 不是链接（或读不出目标）
    }
    rmSync(linkPath, { recursive: true, force: true })
  }
  symlinkSync(target, linkPath, 'junction')
  return true
}

let linked = 0
let failed = 0

// workspace 包：packages/<name> → node_modules/@dp/<name>
const scopeDir = join(nm, '@dp')
mkdirSync(scopeDir, { recursive: true })
for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  try {
    if (ensureJunction(join(root, 'packages', entry.name), join(scopeDir, entry.name))) linked += 1
  } catch (err) {
    console.error(`[link-workspace] 无法链接 @dp/${entry.name}: ${err.code ?? err.message}`)
    failed += 1
  }
}

// 根的直接依赖：.pnpm/<name>@<version>/node_modules/<name> → node_modules/<name>
const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const direct = [...Object.keys(rootPkg.dependencies ?? {}), ...Object.keys(rootPkg.devDependencies ?? {})]
const pnpmDir = join(nm, '.pnpm')
if (direct.length > 0 && existsSync(pnpmDir)) {
  for (const name of direct) {
    if (existsSync(join(nm, name))) continue
    const prefix = `${name.replace('/', '+')}@`
    const hit = readdirSync(pnpmDir).find((e) => e.startsWith(prefix))
    if (hit === undefined) continue
    const target = join(pnpmDir, hit, 'node_modules', name)
    if (!existsSync(target)) continue
    try {
      if (ensureJunction(target, join(nm, name))) linked += 1
    } catch (err) {
      console.error(`[link-workspace] 无法链接 ${name}: ${err.code ?? err.message}`)
      failed += 1
    }
  }
}

if (linked > 0) console.log(`[link-workspace] 补了 ${linked} 个顶层链接`)
if (failed > 0) process.exitCode = 1
