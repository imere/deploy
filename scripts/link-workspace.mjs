import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'packages')
const scopeDir = join(root, 'node_modules', '@dp')

const names = readdirSync(packagesDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)

mkdirSync(scopeDir, { recursive: true })

let linked = 0
for (const name of names) {
  const target = join(packagesDir, name)
  const linkPath = join(scopeDir, name)

  if (existsSync(linkPath)) {
    try {
      const current = readlinkSync(linkPath)
      if (current.replace(/\//g, '\\') === target.replace(/\//g, '\\')) continue
    } catch {
      // 不是链接（或读不出目标），删掉重建
    }
    rmSync(linkPath, { recursive: true, force: true })
  }

  try {
    symlinkSync(target, linkPath, 'junction')
    linked += 1
  } catch (err) {
    console.error(`[link-workspace] 无法链接 ${name}: ${err.code ?? err.message}`)
    process.exitCode = 1
  }
}

if (linked > 0) console.log(`[link-workspace] 已链接 ${linked} 个 workspace 包`)
