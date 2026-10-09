/**
 * 覆盖率阈值门禁：解析 `build/coverage/lcov.info`，按包统计行覆盖率并按门槛判定。
 *
 * 为什么只认 `packages/<pkg>/build/**`：测试跑的是 `tsc -b` 的产物而不是源码，
 * 把 build 之外的同名文件算进来会让同一个文件被数两遍、数字虚高；反过来
 * 把源码目录算进来则是拿没被执行的东西稀释分母。
 *
 * 为什么 lcov 缺失时失败而不是当 0% 或 100%：0% 会把门禁变成一次稳定的红，
 * 100% 会变成一次稳定的绿 —— 两者都不是测出来的，是编出来的。没数据就报没数据。
 *
 * 为什么「盘上有产物、lcov 里却没记录」要判未达标：`node --test` 只给被加载过的
 * 文件出记录，一个产物连记录都没有，意味着没有任何测试碰到它 —— 比「测了但没覆盖」
 * 更该拦，而放过它会让包在缺文件的情况下照样显示 100%。
 *
 * 为什么「编译后没有任何可执行语句」的产物反过来不判缺口：类型在 verbatimModuleSyntax
 * 下被整体擦除，一个只剩 `import type` / `export interface` 的源文件编出来是
 * `export {};` 加一行 sourceMappingURL —— 它连一行执行体都没有，为它写测试既不可能
 * 也没意义，把它算进缺记录却会让受门禁包永远修不红。但它也不被静默丢弃：这类产物
 * 单独列一份账（`typeOnlyArtifacts`），一旦有人往里塞了真代码，同一次判定会立刻把它
 * 翻回缺口 —— 规则每次都按盘上产物重算，不缓存结论。
 *
 * 分层：参数解析（`parseArgs`）、lcov 解析（`parseLcov`）、产物分类
 * （`hasExecutableStatements` / `classifyArtifacts`）、门槛判定（`evaluateCoverage`）
 * 都是纯函数，IO 只留在入口 `main` —— 门禁脚本自己的判定逻辑因此可被 `node --test`
 * 直接断言，不必去构造整棵仓库树。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('..', import.meta.url))
export const LCOV_REL = 'build/coverage/lcov.info'
export const LCOV_PATH = join(root, 'build', 'coverage', 'lcov.info')

/** 门槛只覆盖这三个纯逻辑包：它们的行为能被断言完全钉住，数字可以直接当判据；其余包的数字受集成环境影响，靠契约测试兜底，不追。 */
export const GATED = { schema: 100, core: 100, template: 100 }

/** lcov 的 SF 在 Windows 上是反斜杠路径，统一成正斜杠再匹配，否则一个包都认不出来。 */
export const toPosix = (p) => p.trim().split('\\').join('/')

/** 手写解析：只取 SF / LF / LH / DA / end_of_record，引入 lcov 解析库不值得多一份依赖。 */
export function parseLcov(text) {
  const records = []
  let cur = null
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      cur = { file: toPosix(line.slice(3)), lf: 0, lh: 0, missed: [] }
      continue
    }
    if (line.trim() === 'end_of_record') {
      if (cur) records.push(cur)
      cur = null
      continue
    }
    if (!cur) continue
    if (line.startsWith('LF:')) cur.lf = Number(line.slice(3))
    else if (line.startsWith('LH:')) cur.lh = Number(line.slice(3))
    else if (line.startsWith('DA:')) {
      const [n, hits] = line.slice(3).split(',')
      // DA 的命中数是判定「哪几行没跑到」的唯一来源，LF/LH 只给总量
      if (Number(hits) === 0) cur.missed.push(Number(n))
    }
  }
  // 末尾缺 end_of_record 也别把最后一条丢了
  if (cur) records.push(cur)
  return records
}

export const pkgOf = (file) => /^packages\/([^/]+)\/build\//.exec(file)?.[1] ?? null

/**
 * 测试产物是脚手架，不是被测对象：它自己不被任何东西覆盖，把它算进分母等于
 * 「多写测试就掉覆盖率」。两侧必须同口径 —— 盘上扫描与 lcov 记录用同一个判据，
 * 只在一侧排除的话，门禁的松紧会随覆盖率怎么采集而漂移（glob 换种展开方式
 * 就会撞出来），那时同一份源码在本地绿、在 runner 上红。
 */
export const isTestArtifact = (file) => file.endsWith('.test.js')

// ---------------------------------------------------------------- 产物分类

/** 空导出标记：`export {};` / `export {}`。它只是声明「这是个 ES 模块」，不产生任何执行动作。 */
const EMPTY_EXPORT = /^export\s*\{\s*\}\s*;?/

/** 跳过字符串字面量，返回结束后的下标；-1 表示没闭合（判不出来，交给调用方保守处理）。 */
function skipString(text, open, quote) {
  let i = open + 1
  while (i < text.length) {
    const c = text[i]
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === quote) return i + 1
    if (c === '\n') return -1 // 字符串字面量不跨行，走到换行就是没闭合
    i += 1
  }
  return -1
}

/**
 * 产物里是否还有可执行语句。只看产物本身 —— 源码路径不是这个判定的输入域。
 *
 * 做法是「反过来数」：把注释与字符串字面量整体跳过，剩下的 token 里除分号与空导出标记
 * 外只要还有东西，就判为有可执行行。于是这几种编译输出形态都被容忍：
 *   `export {};` + `//# sourceMappingURL=…`   类型擦除后的空模块
 *   `"use strict";` + `export {};`             指令序言（各包的编译输出形态略有差异）
 *   纯注释或空文件
 * 而任何认不出的形状（未闭合的注释或字符串、模板串、`import {} from '…'` 这类仍会
 * 触发副作用的导入）一律判为**有**可执行行 —— 判不出来时倾向当有，宁可多报一次缺口，
 * 也不让真代码从缺记录里溜过去。
 */
export function hasExecutableStatements(text) {
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === '\uFEFF' || /\s/.test(c)) {
      i += 1
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? text.length : nl + 1
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return true
      i = end + 2
      continue
    }
    if (c === '"' || c === "'") {
      const end = skipString(text, i, c)
      if (end === -1) return true
      i = end
      continue
    }
    // 模板串在类型擦除后的产物里不该出现；插值里是代码，跳过它等于放过真代码，所以直接当有
    if (c === '`') return true
    if (c === ';') {
      i += 1
      continue
    }
    const empty = EMPTY_EXPORT.exec(text.slice(i))
    if (empty) {
      i += empty[0].length
      continue
    }
    return true
  }
  return false
}

/** 读不出来（不存在、被占用、返回的不是字符串）一律当「有可执行行」处理，判据交给缺记录那一侧。 */
const readSafe = (readText, p) => {
  try {
    const t = readText(p)
    return typeof t === 'string' ? t : null
  } catch {
    return null
  }
}

/**
 * 把盘上产物分成两类：`typeOnly` 不参与覆盖判定，`noRecord` 才是真缺口。
 * 判定顺序是「先看有没有执行体，再看 lcov 有没有记录」：一个连执行体都没有的文件
 * 无论有没有记录都不是缺口，而有执行体又没记录的比「测了没覆盖」更该拦。
 */
export function classifyArtifacts(paths, { hasRecord, readText }) {
  const typeOnly = []
  const noRecord = []
  for (const p of paths) {
    const text = readSafe(readText, p)
    if (text !== null && !hasExecutableStatements(text)) {
      typeOnly.push(p)
      continue
    }
    if (!hasRecord(p)) noRecord.push(p)
  }
  return { typeOnly: typeOnly.sort(), noRecord: noRecord.sort() }
}

// ---------------------------------------------------------------- 门槛判定

const rate = (hit, total) => (total > 0 ? (hit / total) * 100 : null)

/**
 * 门禁的全部判定。IO 由调用方注入（`readText`），因此可以在只有几个字符串的
 * 夹具上跑完整条链路。
 */
export function evaluateCoverage({ lcovText, onDisk, readText, thresholds = GATED, gated = GATED }) {
  const seen = new Set()
  const outOfScope = []
  const testArtifacts = []
  const stats = new Map()
  const bucket = (name) => {
    let s = stats.get(name)
    if (!s) {
      s = { name, hit: 0, total: 0, files: [], noRecord: [] }
      stats.set(name, s)
    }
    return s
  }

  for (const r of parseLcov(lcovText)) {
    const pkg = pkgOf(r.file)
    if (pkg === null) {
      outOfScope.push(r.file)
      continue
    }
    if (isTestArtifact(r.file)) {
      testArtifacts.push(r.file)
      continue
    }
    seen.add(r.file)
    const s = bucket(pkg)
    s.hit += r.lh
    s.total += r.lf
    s.files.push(r)
  }

  const inScope = onDisk.filter((p) => pkgOf(p) !== null)
  const { typeOnly, noRecord } = classifyArtifacts(inScope, { hasRecord: (p) => seen.has(p), readText })
  for (const f of noRecord) bucket(pkgOf(f)).noRecord.push(f)

  // 门槛里写了个不存在的包名也要出现在表里：静默忽略等于让拼错的名字悄悄通过门禁
  const names = [
    ...Object.keys(gated),
    ...[...new Set([...stats.keys(), ...Object.keys(thresholds)])].filter((n) => !(n in gated)).sort(),
  ]

  const rows = names.map((name) => {
    const s = stats.get(name) ?? { name, hit: 0, total: 0, files: [], noRecord: [] }
    const thr = thresholds[name] ?? null
    const pct = rate(s.hit, s.total)
    let pass = true
    let verdict = '仅报告，不判失败'
    if (thr != null) {
      const short = pct == null ? 0 : thr - pct
      if (pct == null) {
        pass = false
        verdict = '未达标（无可执行行记录）'
      } else if (s.noRecord.length > 0) {
        pass = false
        verdict = `未达标（${s.noRecord.length} 个产物在 lcov 里无记录）`
      } else if (short > 1e-9) {
        pass = false
        verdict = `未达标（差 ${s.total - s.hit} 行）`
      } else {
        verdict = '达标'
      }
    }
    return { ...s, pct, threshold: thr, gated: thr != null, pass, verdict }
  })

  const gatedRows = rows.filter((r) => r.gated)
  const failed = gatedRows.filter((r) => !r.pass)
  const totalHit = rows.reduce((a, r) => a + r.hit, 0)
  const totalAll = rows.reduce((a, r) => a + r.total, 0)

  return { rows, gatedRows, failed, outOfScope, typeOnly, noRecord, totalHit, totalAll, testArtifacts }
}

// ---------------------------------------------------------------- 参数

/** 参数用错是与门禁结论无关的一类失败：退出码 2 与 0/1 分开，消费方只靠退出码就能区分「写错了」和「没过」。 */
export class UsageError extends Error {
  constructor(text) {
    super(text)
    this.name = 'UsageError'
    this.text = text
  }
}

const USAGE = '用法：node scripts/check-coverage.mjs [--json] [--threshold <包名>=<0-100>]'

/** 解析 argv。门槛用错、未知参数一律抛 UsageError，退出码由调用方给。 */
export function parseArgs(argv) {
  const thresholds = { ...GATED }
  /** --threshold 的值不是「未知参数」的候选，认过的下标要记下来，否则校验会把值当成游离参数。 */
  const consumed = new Set()

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    let spec
    if (arg === '--threshold') {
      spec = argv[i + 1]
      consumed.add(i)
      consumed.add(i + 1)
      i += 1
    } else if (arg.startsWith('--threshold=')) {
      spec = arg.slice('--threshold='.length)
      // 等号写法也得记下标：它同样是一个「已认过的参数」，漏记会让下面的游离参数校验
      // 把它当未知参数，等号写法就永远走不到生效那一步
      consumed.add(i)
    } else {
      continue
    }
    const m = /^([A-Za-z0-9._-]+)=(\d+(?:\.\d+)?)$/.exec(spec ?? '')
    if (!m || Number(m[2]) > 100) {
      throw new UsageError(`门槛无法解析：${arg} ${spec ?? '(缺值)'}\n用法：--threshold <包名>=<0-100>`)
    }
    thresholds[m[1]] = Number(m[2])
  }

  // 门槛先于未知参数报，与遍历顺序一致：同一个 argv 不该同时给出两个理由
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--json' || consumed.has(i)) continue
    throw new UsageError(`未知参数：${argv[i]}\n${USAGE}`)
  }

  return { asJson: argv.includes('--json'), thresholds }
}

// ---------------------------------------------------------------- 输出

/** 缺口清单：无记录的排最前（等于完全没被碰过），其余按覆盖率升序。 */
function gaps(row, limit = 10) {
  const list = [
    ...row.noRecord.map((file) => ({ file, hit: 0, total: 0, missed: [], pct: null })),
    ...row.files
      .filter((f) => f.lh < f.lf)
      .map((f) => ({ file: f.file, hit: f.lh, total: f.lf, missed: f.missed, pct: rate(f.lh, f.lf) })),
  ]
  list.sort((a, b) => (a.pct ?? -1) - (b.pct ?? -1) || a.file.localeCompare(b.file))
  return list.slice(0, limit)
}

const fmtPct = (p) => (p == null ? '    n/a' : `${p.toFixed(2)}%`.padStart(7))
const fmtLines = (nums) => {
  const head = nums.slice(0, 12).join(', ')
  return nums.length > 12 ? `${head}, …（另 ${nums.length - 12} 行）` : head
}

const rowsJson = (rows) =>
  rows.map((r) => ({
    name: r.name,
    hit: r.hit,
    total: r.total,
    pct: r.pct == null ? null : Number(r.pct.toFixed(2)),
    threshold: r.threshold,
    gated: r.gated,
    pass: r.pass,
    verdict: r.verdict,
    gaps: gaps(r, Number.MAX_SAFE_INTEGER).map((g) => ({
      file: g.file,
      hit: g.hit,
      total: g.total,
      pct: g.pct == null ? null : Number(g.pct.toFixed(2)),
      missedLines: g.missed,
    })),
  }))

function renderJson(result, { lcovMtime }) {
  process.stdout.write(
    `${JSON.stringify(
      {
        lcov: {
          path: LCOV_REL,
          mtime: lcovMtime,
          ignoredOutOfScope: result.outOfScope.length,
          missingRecords: result.noRecord,
          typeOnlyArtifacts: result.typeOnly,
        },
        packages: rowsJson(result.rows),
        summary: {
          packages: result.rows.length,
          gated: result.gatedRows.length,
          passed: result.gatedRows.length - result.failed.length,
          failed: result.failed.length,
          totalPct: result.totalAll > 0 ? Number(((result.totalHit / result.totalAll) * 100).toFixed(2)) : null,
          totalHit: result.totalHit,
          totalAll: result.totalAll,
        },
        exitCode: result.failed.length > 0 ? 1 : 0,
      },
      null,
      2,
    )}\n`,
  )
}

function renderText(result, { lcovMtime }) {
  const lines = []
  lines.push(`覆盖率门禁  lcov: ${LCOV_REL}  文件 mtime: ${lcovMtime}（本脚本只读现成文件，不跑测试）`)
  lines.push('')
  lines.push('  包名            覆盖率    命中/总数        门槛   结论')
  for (const r of result.rows) {
    lines.push(
      `  ${r.name.padEnd(14)} ${fmtPct(r.pct)}  (${String(r.hit).padStart(6)}/${String(r.total).padEnd(6)})  ` +
        `${(r.threshold == null ? '—' : `${r.threshold}%`).padStart(6)}   ${r.verdict}`,
    )
  }
  lines.push('')
  lines.push(
    `汇总：${result.rows.length} 个包，受门禁 ${result.gatedRows.length} 个（达标 ${result.gatedRows.length - result.failed.length} / 未达标 ${result.failed.length}）；` +
      `总行覆盖率 ${fmtPct(rate(result.totalHit, result.totalAll)).trim()} (${result.totalHit}/${result.totalAll})`,
  )

  if (result.outOfScope.length > 0) {
    lines.push(`已忽略 ${result.outOfScope.length} 个不在 packages/*/build 下的条目（算进来会虚高）`)
  }
  if (result.noRecord.length > 0) {
    lines.push('')
    lines.push(
      `lcov 缺记录的盘上产物 ${result.noRecord.length} 个（说明这份 lcov 早于当前产物，或这些文件从未被测试加载）：`,
    )
    for (const f of result.noRecord.slice(0, 10)) lines.push(`  ${f}`)
    if (result.noRecord.length > 10) lines.push(`  …… 另 ${result.noRecord.length - 10} 个`)
  }
  if (result.typeOnly.length > 0) {
    lines.push('')
    lines.push(`纯类型产物 ${result.typeOnly.length} 个（编译后没有任何可执行语句，不参与覆盖判定）：`)
    for (const f of result.typeOnly.slice(0, 10)) lines.push(`  ${f}`)
    if (result.typeOnly.length > 10) lines.push(`  …… 另 ${result.typeOnly.length - 10} 个`)
  }

  if (result.failed.length > 0) {
    lines.push('')
    lines.push('未覆盖文件（按覆盖率升序，每包最多 10 个）：')
    for (const r of result.failed) {
      const g = gaps(r)
      lines.push(
        `  ${r.name}（还差 ${r.total - r.hit} 行${r.noRecord.length ? `，另有 ${r.noRecord.length} 个文件无记录` : ''}）`,
      )
      if (g.length === 0) {
        lines.push('    （lcov 未给出该包任何行数据）')
        continue
      }
      for (const f of g) {
        const head =
          f.pct == null
            ? `    ${f.file}  无记录（没有任何测试加载它）`
            : `    ${f.file}  ${fmtPct(f.pct).trim()} (${f.hit}/${f.total})  未覆盖 ${f.total - f.hit} 行`
        lines.push(f.missed.length > 0 ? `${head}：${fmtLines(f.missed)}` : head)
      }
    }
  }

  lines.push('')
  lines.push(
    result.failed.length > 0 ? `结论：未通过（${result.failed.map((r) => r.name).join(' / ')}）` : '结论：通过',
  )
  process.stdout.write(`${lines.join('\n')}\n`)
}

// ---------------------------------------------------------------- 入口

/** 盘上产物：用来发现「有产物但 lcov 里没有记录」的文件。测试产物本身是脚手架，不算被测对象。 */
function walkBuild(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkBuild(p, out)
    else if (e.isFile() && e.name.endsWith('.js') && !isTestArtifact(e.name)) {
      out.push(toPosix(relative(root, p).split(sep).join('/')))
    }
  }
  return out
}

function collectOnDisk() {
  const onDisk = []
  for (const d of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    onDisk.push(...walkBuild(join(root, 'packages', d.name, 'build')))
  }
  return onDisk
}

function main() {
  let asJson
  let thresholds
  try {
    ;({ asJson, thresholds } = parseArgs(process.argv.slice(2)))
  } catch (err) {
    if (!(err instanceof UsageError)) throw err
    process.stderr.write(`${err.text}\n`)
    process.exit(2)
  }

  let lcovText
  let lcovMtime = null
  try {
    lcovText = readFileSync(LCOV_PATH, 'utf8')
    lcovMtime = statSync(LCOV_PATH).mtime.toISOString()
  } catch {
    process.stderr.write(
      `读不到 ${LCOV_REL}：先跑 \`pnpm test\` 生成覆盖率（它把 lcov 重定向到这个路径）。\n` +
        `本脚本不对「没测过」编造数字 —— 既不当 0% 也不当 100%。\n`,
    )
    process.exit(1)
  }

  const result = evaluateCoverage({
    lcovText,
    onDisk: collectOnDisk(),
    readText: (p) => readFileSync(join(root, p), 'utf8'),
    thresholds,
  })

  if (asJson) renderJson(result, { lcovMtime })
  else renderText(result, { lcovMtime })

  if (result.failed.length > 0) process.exitCode = 1
}

/** 入口守卫：被测试 import 时只给纯函数，不跑 IO。Windows 上路径比较要忽略大小写，否则脚本会静默什么都不输出。 */
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
if (process.argv[1] && samePath(resolvePath(process.argv[1]), fileURLToPath(import.meta.url))) main()
