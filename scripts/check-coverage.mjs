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
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const LCOV_REL = 'build/coverage/lcov.info'
const LCOV_PATH = join(root, 'build', 'coverage', 'lcov.info')

/** 门槛的唯一来源是 README 的质量门禁表：纯逻辑包 100%，其余包靠契约测试与集成、不追数字。 */
const GATED = { schema: 100, core: 100, template: 100 }

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')

/** --threshold 的值不是「未知参数」的候选，认过的下标要记下来，否则校验会把值当成游离参数。 */
const consumed = new Set()

const thresholds = { ...GATED }
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  let spec = null
  if (arg === '--threshold') {
    spec = argv[i + 1]
    consumed.add(i)
    consumed.add(i + 1)
    i += 1
  } else if (arg.startsWith('--threshold=')) {
    spec = arg.slice('--threshold='.length)
  } else {
    continue
  }
  const m = /^([A-Za-z0-9._-]+)=(\d+(?:\.\d+)?)$/.exec(spec ?? '')
  if (!m || Number(m[2]) > 100) {
    process.stderr.write(`门槛无法解析：${arg} ${spec ?? '(缺值)'}\n用法：--threshold <包名>=<0-100>\n`)
    process.exit(2)
  }
  thresholds[m[1]] = Number(m[2])
}

const usage = () => {
  process.stderr.write(`用法：node scripts/check-coverage.mjs [--json] [--threshold <包名>=<0-100>]\n`)
}

argv.forEach((arg, i) => {
  if (arg === '--json' || consumed.has(i)) return
  process.stderr.write(`未知参数：${arg}\n`)
  usage()
  process.exit(2)
})

// ---------------------------------------------------------------- 输入

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

/** lcov 的 SF 在 Windows 上是反斜杠路径，统一成正斜杠再匹配，否则一个包都认不出来。 */
const toPosix = (p) => p.trim().split('\\').join('/')

/** 手写解析：只取 SF / LF / LH / DA / end_of_record，引入 lcov 解析库不值得多一份依赖。 */
function parseLcov(text) {
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

const pkgOf = (file) => /^packages\/([^/]+)\/build\//.exec(file)?.[1] ?? null

const counted = []
const outOfScope = []
for (const r of parseLcov(lcovText)) {
  if (pkgOf(r.file)) counted.push(r)
  else outOfScope.push(r.file)
}

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
    else if (e.isFile() && e.name.endsWith('.js') && !e.name.endsWith('.test.js')) {
      out.push(toPosix(relative(root, p).split(sep).join('/')))
    }
  }
  return out
}

const onDisk = []
const packagesDir = join(root, 'packages')
for (const d of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue
  onDisk.push(...walkBuild(join(packagesDir, d.name, 'build')))
}
const inScopeOnDisk = onDisk.filter((p) => pkgOf(p) !== null)
const seen = new Set(counted.map((r) => r.file))
const noRecord = inScopeOnDisk.filter((p) => !seen.has(p)).sort()

// ---------------------------------------------------------------- 聚合

const rate = (hit, total) => (total > 0 ? (hit / total) * 100 : null)

const stats = new Map()
const bucket = (name) => {
  let s = stats.get(name)
  if (!s) {
    s = { name, hit: 0, total: 0, files: [], noRecord: [] }
    stats.set(name, s)
  }
  return s
}

for (const r of counted) {
  const s = bucket(pkgOf(r.file))
  s.hit += r.lh
  s.total += r.lf
  s.files.push(r)
}
for (const f of noRecord) bucket(pkgOf(f)).noRecord.push(f)

// 门槛里写了个不存在的包名也要出现在表里：静默忽略等于让拼错的名字悄悄通过门禁
const names = [
  ...Object.keys(GATED),
  ...[...new Set([...stats.keys(), ...Object.keys(thresholds)])].filter((n) => !(n in GATED)).sort(),
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

// ---------------------------------------------------------------- 输出

const rowsJson = rows.map((r) => ({
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

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        lcov: { path: LCOV_REL, mtime: lcovMtime, ignoredOutOfScope: outOfScope.length, missingRecords: noRecord },
        packages: rowsJson,
        summary: {
          packages: rows.length,
          gated: gatedRows.length,
          passed: gatedRows.length - failed.length,
          failed: failed.length,
          totalPct: totalAll > 0 ? Number(((totalHit / totalAll) * 100).toFixed(2)) : null,
          totalHit,
          totalAll,
        },
        exitCode: failed.length > 0 ? 1 : 0,
      },
      null,
      2,
    )}\n`,
  )
} else {
  const lines = []
  lines.push(`覆盖率门禁  lcov: ${LCOV_REL}  文件 mtime: ${lcovMtime}（本脚本只读现成文件，不跑测试）`)
  lines.push('')
  lines.push('  包名            覆盖率    命中/总数        门槛   结论')
  for (const r of rows) {
    lines.push(
      `  ${r.name.padEnd(14)} ${fmtPct(r.pct)}  (${String(r.hit).padStart(6)}/${String(r.total).padEnd(6)})  ` +
        `${(r.threshold == null ? '—' : `${r.threshold}%`).padStart(6)}   ${r.verdict}`,
    )
  }
  lines.push('')
  lines.push(
    `汇总：${rows.length} 个包，受门禁 ${gatedRows.length} 个（达标 ${gatedRows.length - failed.length} / 未达标 ${failed.length}）；` +
      `总行覆盖率 ${fmtPct(rate(totalHit, totalAll)).trim()} (${totalHit}/${totalAll})`,
  )

  if (outOfScope.length > 0) {
    lines.push(`已忽略 ${outOfScope.length} 个不在 packages/*/build 下的条目（算进来会虚高）`)
  }
  if (noRecord.length > 0) {
    lines.push('')
    lines.push(`lcov 缺记录的盘上产物 ${noRecord.length} 个（说明这份 lcov 早于当前产物，或这些文件从未被测试加载）：`)
    for (const f of noRecord.slice(0, 10)) lines.push(`  ${f}`)
    if (noRecord.length > 10) lines.push(`  …… 另 ${noRecord.length - 10} 个`)
  }

  if (failed.length > 0) {
    lines.push('')
    lines.push('未覆盖文件（按覆盖率升序，每包最多 10 个）：')
    for (const r of failed) {
      const g = gaps(r)
      lines.push(`  ${r.name}（还差 ${r.total - r.hit} 行${r.noRecord.length ? `，另有 ${r.noRecord.length} 个文件无记录` : ''}）`)
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
  lines.push(failed.length > 0 ? `结论：未通过（${failed.map((r) => r.name).join(' / ')}）` : '结论：通过')
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (failed.length > 0) process.exitCode = 1
