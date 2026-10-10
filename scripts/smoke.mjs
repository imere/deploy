import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { describeError, isGateFailure, pkgOf, resolveEntry, scanArtifact } from './smoke-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'packages')

const IMPORT_TIMEOUT_MS = 20_000
const TOTAL_TIMEOUT_MS = 180_000

const args = new Set(process.argv.slice(2))
const jsonMode = args.has('--json')

const out = []
const emit = (line) => {
  out.push(line)
  if (!jsonMode) console.log(line)
}

// ── 总超时兜底 ──────────────────────────────────────────────────────────────
const watchdog = setTimeout(() => {
  process.stderr.write(
    `smoke: 总超时 ${TOTAL_TIMEOUT_MS}ms —— 某个产物的顶层副作用挂住了。` +
      `这不是「慢」，不要靠加超时重试来掩盖\n`,
  )
  process.exit(1)
}, TOTAL_TIMEOUT_MS)

// ── 工具 ────────────────────────────────────────────────────────────────────
function listPackageDirs() {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

function listJsFiles(dir) {
  const found = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) found.push(...listJsFiles(p))
    else if (e.isFile() && e.name.endsWith('.js')) found.push(p)
  }
  return found
}

/**
 * import 加超时。挂住的动态 import 无法真正取消（没有 API），所以这里只是「不再等它」，最终兜底是顶层的总超时闸。
 */
async function importWithTimeout(spec, ms) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`import 超过 ${ms}ms 未返回`)), ms)
  })
  try {
    return await Promise.race([import(spec), timeout])
  } finally {
    clearTimeout(timer)
  }
}

// ── 检查 1–3：import + 导出面 ────────────────────────────────────────────────
const packageResults = []
for (const name of listPackageDirs()) {
  const pkgDir = join(packagesDir, name)
  const manifestPath = join(pkgDir, 'package.json')
  const record = { name, entry: null, exports: [], problems: [] }

  if (!existsSync(manifestPath)) {
    record.problems.push({ kind: 'manifest', file: relative(root, manifestPath), reason: 'package.json 不存在' })
    packageResults.push(record)
    emit(`✘ ${name}  ${relative(root, manifestPath)}: package.json 不存在`)
    continue
  }

  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (err) {
    const reason = describeError(err)
    record.problems.push({ kind: 'manifest', file: relative(root, manifestPath), reason })
    packageResults.push(record)
    emit(`✘ ${name}  ${relative(root, manifestPath)}: package.json 解析失败: ${reason}`)
    continue
  }

  const entry = resolveEntry(manifest)
  if (entry === null) {
    const reason = 'main 与 exports 都无法解析出入口文件'
    record.problems.push({ kind: 'entry', file: `packages/${name}/package.json`, reason })
    packageResults.push(record)
    emit(`✘ ${name}  packages/${name}/package.json: ${reason}`)
    continue
  }
  record.entry = entry

  // 入口声明与实际文件必须对得上。这是「exports 指向一个不存在的文件」的唯一
  const entryAbs = resolve(pkgDir, entry)
  if (!existsSync(entryAbs)) {
    const rel = relative(root, entryAbs)
    record.problems.push({ kind: 'entry', file: rel, reason: 'manifest 声明的入口文件不存在' })
    packageResults.push(record)
    emit(`✘ ${name}  ${rel}: manifest 声明的入口文件不存在（exports/main 与实际产物不一致）`)
    continue
  }

  let mod
  try {
    mod = await importWithTimeout(pathToFileURL(entryAbs).href, IMPORT_TIMEOUT_MS)
  } catch (err) {
    const reason = describeError(err)
    record.problems.push({ kind: 'import', file: relative(root, entryAbs), reason })
    packageResults.push(record)
    emit(`✘ ${name}  ${relative(root, entryAbs)}: ${reason}`)
    continue
  }

  const keys = Object.keys(mod).sort()
  record.exports = keys

  // 入口活着但什么也没导出：import 不报错，功能全丢。这是最阴的一种坏，
  if (keys.length === 0) {
    const rel = relative(root, entryAbs)
    record.problems.push({ kind: 'empty-exports', file: rel, reason: '模块对象可枚举导出为空' })
    packageResults.push(record)
    emit(`✘ ${name}  ${rel}: 模块可枚举导出为空（入口能加载但对外什么都没给）`)
    continue
  }

  packageResults.push(record)
  emit(`✔ ${name}  import ${entry}  导出(${keys.length}): ${keys.join(', ')}`)
}

// ── 检查 4–5：产物内容扫描 ──────────────────────────────────────────────────
const secretHits = [] // 命中即失败
const absPathHits = [] // 只报告，永不影响判失败
const unreadable = [] // 只报告（与改动前一致：不参与判失败）
let scannedFiles = 0
let secretScannedFiles = 0

for (const name of listPackageDirs()) {
  for (const file of listJsFiles(join(packagesDir, name, 'build'))) {
    scannedFiles += 1
    const rel = relative(root, file)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (err) {
      unreadable.push({ file: rel, detail: describeError(err) })
      continue
    }

    const scan = scanArtifact({ file, text })
    if (scan.skipped) continue
    secretScannedFiles += 1
    secretHits.push(...scan.secretHits)
    absPathHits.push(...scan.absPathHits)
  }
}

// 命中回灌到包维度：包「失败」必须对应会判死的东西。绝对路径不回灌 ——
const gateFailures = [...secretHits, ...absPathHits].filter((hit) => isGateFailure(hit) === 'fail')
for (const hit of gateFailures) {
  const owner = packageResults.find((p) => p.name === pkgOf(hit.file))
  if (owner) owner.problems.push(hit)
}

for (const hit of secretHits) {
  emit(`✘ 产物扫描  ${hit.file}:${hit.line}  疑似凭据 — ${hit.detail}`)
}
for (const f of unreadable) {
  emit(`· 产物扫描  ${f.file}  产物不可读 — ${f.detail}`)
}

const failed = packageResults.filter((p) => p.problems.length > 0)
const passed = packageResults.length - failed.length
const summary = `smoke: ${passed} 个包通过 / ${failed.length} 个失败`

if (jsonMode) {
  console.log(
    JSON.stringify(
      {
        scannedFiles,
        secretScannedFiles,
        packages: packageResults.map((p) => ({
          name: p.name,
          entry: p.entry,
          exports: p.exports,
          problems: p.problems,
        })),
        secretHits,
        absPathHits,
        unreadable,
        summary: { passed, failed: failed.length, absPathReported: absPathHits.length },
      },
      null,
      2,
    ),
  )
} else {
  emit(`[扫描] ${packageResults.length} 个包 / ${scannedFiles} 个 js 产物`)
  emit(
    `[扫描] 凭据：扫 ${secretScannedFiles} 个非测试产物（测试产物不参与），` +
      `${secretHits.length} 处命中${secretHits.length ? '（命中即失败）' : ''}`,
  )
  // 报告类命中单独成段并写明为什么它不判失败：一条不判失败的检查不解释理由，
  if (absPathHits.length) {
    emit(
      `[报告] 绝对路径 ${absPathHits.length} 处 —— 只报不判。判据在这里不成立：` +
        '识别与拒绝 Windows 绝对路径是本仓一批模块的职责（模板的字符闸门、源路径校验、能力探测），' +
        '它们的模式串本身就含盘符，静态扫描分不清「模式串」与「编进去的开发机路径」。',
    )
    for (const hit of absPathHits) {
      emit(`  · ${hit.file}:${hit.line}  ${hit.pattern} — ${hit.detail}`)
    }
  } else {
    emit('[报告] 绝对路径：0 处')
  }
  emit(summary)
}

clearTimeout(watchdog)

const code = failed.length > 0 ? 1 : 0
process.exitCode = code
// 显式退出：产物 import 后可能留下句柄（socket、定时器、stdin 监听），
setTimeout(() => process.exit(code), 0).unref()
