/**
 * 发布产物 smoke 门禁：验证各包的 build 产物能被别人真正 import 起来。
 *
 * 为什么要有它：源码能编译、单测能过，都不能证明发出去的包能用。真正会炸的是
 * 「路径写错 / exports 漏了子路径 / 构建把开发机路径编进去了 / 依赖没声明」这一类，
 * 而它们在源码侧与单测侧全都看不见 —— 单测跑的是仓库内的相对路径，
 * 真实消费方走的是包名解析。这是唯一能覆盖那条路径的检查。
 *
 * 判死与只报的分工在扫描段：import / 导出面 / 凭据判死，绝对路径只报 ——
 * 不是漏了判据，是那一类的判据在静态上不成立（理由写在那里，不在文件头）。
 *
 * 不做重建：只读现成产物。构建归 `pnpm build`，smoke 只回答「产物能不能用」。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'packages')

const IMPORT_TIMEOUT_MS = 20_000
const TOTAL_TIMEOUT_MS = 180_000

/**
 * 本机绝对路径。产物里出现它**通常**意味着构建把开发机环境编进去了 ——
 * 「通常」两个字是有代价的，代价见下面扫描段的说明：这一类只报不判。
 *
 * 前置断言 (?<![A-Za-z0-9_]) 是必须的：没有它 `https://` 里的 `s:/` 会被当成
 * 盘符路径，于是每个带 URL 的产物都误报 —— 误报的检查等于没有检查。
 */
const ABS_PATH_PATTERNS = [
  { kind: 'win-drive', re: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/g },
  { kind: 'unix-home', re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//g },
]

/** 高置信凭据前缀。只认前缀 + 足够长的尾巴，避免把散文里的这些词当命中。 */
const SECRET_PATTERNS = [
  { kind: 'github-pat', re: /github_pat_[A-Za-z0-9_]{16,}/g },
  { kind: 'github-classic', re: /ghp_[A-Za-z0-9]{20,}/g },
  { kind: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
]

const args = new Set(process.argv.slice(2))
const jsonMode = args.has('--json')

const out = []
const emit = (line) => {
  out.push(line)
  if (!jsonMode) console.log(line)
}

// ── 总超时兜底 ──────────────────────────────────────────────────────────────
// 单个 import 超时只解决「这次 import 挂住」。若某个顶层副作用让**整个事件循环**
// 停摆（同步死循环、无出口的 await），上面的竞态也会跟着失效，只能靠这个闸。
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
 * 从 manifest 解出入口，优先级 exports > main。
 *
 * 为什么优先 exports：exports 才是解析期真正生效的那份，main 只在无 exports 时兜底。
 * 硬编码 `build/index.js` 等于把「入口叫什么」在两处各写一遍 —— 改名时 smoke
 * 还在测一个已经不存在的文件，或者反过来漏测新入口。
 */
function resolveEntry(manifest) {
  const exp = manifest.exports
  if (typeof exp === 'string') return exp
  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    const dot = exp['.']
    if (typeof dot === 'string') return dot
    if (dot && typeof dot === 'object') {
      if (typeof dot.default === 'string') return dot.default
      if (typeof dot.import === 'string') return dot.import
    }
  }
  if (typeof manifest.main === 'string') return manifest.main
  return null
}

function describeError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : null
  const msg = err instanceof Error ? err.message : String(err)
  return code ? `${code}: ${msg}` : msg
}

/**
 * import 加超时。挂住的动态 import 无法真正取消（没有 API），
 * 所以这里只是「不再等它」，最终兜底是顶层的总超时闸。
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
  // 能在不 import 的情况下抓住的时刻 —— import 失败时报的是解析错，不是「你写错了 exports」。
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
  // 所以单独判，而不是让「import 成功」顺带把它算过。
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
// 两类扫描、两种判据。凭据是硬判据，绝对路径不是 —— 不是因为它不重要，
// 而是因为判据本身在静态上不成立。
const isTestArtifact = (file) => file.endsWith('.test.js')

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

    // 测试产物不是发布产物。它们的字符串字面量里天然躺着脱敏 token 与示例路径
    // （凭据脱敏要的就是「长得像真 token 的假 token」），判它等于判夹具本身有罪。
    if (isTestArtifact(file)) continue
    secretScannedFiles += 1

    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      for (const { kind, re } of SECRET_PATTERNS) {
        re.lastIndex = 0
        for (const m of line.matchAll(re)) {
          secretHits.push({ kind: 'secret', pattern: kind, file: rel, line: i + 1, detail: m[0] })
        }
      }
      for (const { kind, re } of ABS_PATH_PATTERNS) {
        re.lastIndex = 0
        for (const m of line.matchAll(re)) {
          absPathHits.push({ kind: 'abs-path', pattern: kind, file: rel, line: i + 1, detail: m[0] })
        }
      }
    }
  }
}

// 凭据回灌到包维度：包「失败」必须对应会判死的东西。绝对路径不回灌 ——
// 让只报信号的一类参与失败判定，会出现「包红了但没有任何可执行的修法」。
const pkgOf = (rel) => rel.split(/[\\/]/)[1]
for (const hit of secretHits) {
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
  // 下一个人只会以为它坏了，然后去放宽真正的判据。
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
// 只设 exitCode 的话进程会吊在句柄上 —— 门禁挂起比门禁失败更难查。
// 用 unref 的零延时而不是直接 process.exit()：直接退出会截断管道上的 stdout。
// 事件循环还活着 → 定时器照常触发 → 强制退；已经空了 → 进程自然退出并带上 exitCode。
setTimeout(() => process.exit(code), 0).unref()
