/**
 * 用 junction 链接 workspace 包到 node_modules/@dp/*。
 *
 * 为什么需要：
 *   本机未开启 Windows 开发者模式 → 创建 symlink 报 EPERM（junction 则可用）。
 *   pnpm 12.6.0 在本机不会回退到 junction，isolated 布局的顶层链接会**静默缺失**，
 *   于是 `import '@dp/ports'` 解析不到。详见 docs/troubleshooting.md。
 *
 * 幂等：链接已存在且指向正确目标时跳过。
 * 开启开发者模式后可删除本脚本与 package.json 里的 postinstall。
 */
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
