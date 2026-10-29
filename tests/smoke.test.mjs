/**
 * 构建产物冒烟（node --test）。
 *
 * 替代原手写 smoke 脚本的两类判死检查：
 * 1. 每个包 manifest 声明的入口能被动态 import，且可枚举导出非空 —— 入口活着但
 *    什么都没导出是最阴的坏：import 不报错，功能全丢，其余测试全绿也救不回来。
 * 2. 凭据不进产物 —— 由 gitleaks 扫 dist/ 承担（verify:gates 里独立一步，默认规则集）。
 *
 * 原「绝对路径报告」不保留：它只报不判，静态扫描分不清「识别用的模式串」与
 * 「编进去的真实路径」，一份没人能对它做动作的报告没有存在价值。
 *
 * 入口清单从各包 manifest 的 main / exports 解析 —— 与运行时消费方的解析口径一致，
 * 声明了但解析不出入口、或入口文件不存在，都直接红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const IMPORT_TIMEOUT_MS = 20_000

/** manifest 声明的入口解析不出、入口文件在盘上不存在，都是冒烟红，不是 skip */
function resolveEntry(pkgDir) {
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  if (typeof manifest.main === 'string' && manifest.main !== '') return manifest.main
  const exp = manifest.exports
  if (typeof exp === 'string' && exp !== '') return exp
  if (exp && typeof exp === 'object') {
    const dot = exp['.']
    if (typeof dot === 'string') return dot
    if (dot && typeof dot === 'object' && typeof dot.default === 'string') return dot.default
  }
  return null
}

const packageDirs = readdirSync('packages', { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()

for (const name of packageDirs) {
  const pkgDir = join('packages', name)
  const entry = resolveEntry(pkgDir)

  test(`${name}: manifest 声明可解析的入口`, () => {
    assert.notEqual(entry, null, 'main 与 exports 都解析不出入口文件')
  })

  if (entry === null) continue

  test(`${name}: 入口可加载且导出非空  ${entry}`, { timeout: IMPORT_TIMEOUT_MS }, async () => {
    const entryAbs = join(pkgDir, entry)
    assert.equal(existsSync(entryAbs), true, 'manifest 声明的入口文件不存在')
    const mod = await import(pathToFileURL(entryAbs).href)
    const keys = Object.keys(mod).sort()
    assert.ok(
      keys.length > 0,
      '模块可枚举导出为空（入口能加载但对外什么都没给）—— 声明与实现脱节',
    )
  })
}
