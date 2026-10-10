import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  IMPL_LAYER,
  LAYER_LABEL,
  analyzeCycles,
  classifyCrossLayer,
  clauseIsTypeOnly,
  findStatements,
  isTestFile,
  layerOf,
  makeAdj,
  prepare,
  splitPackageSpec,
} from './check-imports-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const asJson = process.argv.includes('--json')
const showLayers = process.argv.includes('--layers')

const packagesDir = join(root, 'packages')
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.tmp'])

const toPosix = (p) => p.split(sep).join('/')
const toRel = (p) => toPosix(relative(root, p))

/**
 * 包名以 package.json 的声明为准，目录名只作为兜底。
 */
const pkgByDir = new Map()
const dirByPkg = new Map()
for (const e of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!e.isDirectory() || e.name.startsWith('.')) continue
  const dir = join(packagesDir, e.name)
  let name = `@dp/${e.name}`
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (typeof manifest.name === 'string' && manifest.name) name = manifest.name
  } catch {
    /* 没有 package.json 就退回目录名 */
  }
  pkgByDir.set(e.name, name)
  dirByPkg.set(name, e.name)
}

const packageOfFile = (file) => {
  const first = relative(packagesDir, file).split(sep)[0]
  return pkgByDir.get(first) ?? null
}

function walk(dir, out = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p)
  }
  return out
}


/** 说明符 → 仓库内文件。`./x.js` 要同时试 `.ts`（本仓 TS 的 ESM 写法）。 */
function resolveRelative(fromFile, spec) {
  const base = resolvePath(dirname(fromFile), spec)
  const tries = [base]
  if (base.endsWith('.js')) tries.push(`${base.slice(0, -3)}.ts`)
  if (base.endsWith('.mjs')) tries.push(`${base.slice(0, -4)}.mts`)
  if (!/\.[cm]?[jt]sx?$/.test(base)) {
    tries.push(`${base}.ts`, join(base, 'index.ts'), `${base}.mts`, join(base, 'index.mts'))
  }
  for (const t of tries) {
    try {
      if (statSync(t).isFile()) return t
    } catch {
      /* 候选不存在，试下一个 */
    }
  }
  return null
}

/** 裸包名 → 包入口文件（`@dp/x`、`@dp/x/sub`）。null 表示仓外依赖。 */
function resolvePackage(spec) {
  // 包名怎么切是纯判定（在 splitPackageSpec 里），这里只负责去盘上确认文件存在
  const { pkg, rest } = splitPackageSpec(spec, dirByPkg)
  if (!pkg) return { pkg: null, file: null }
  const dir = join(packagesDir, dirByPkg.get(pkg))
  const tries = [join(dir, 'src', 'index.ts')]
  if (rest) {
    tries.unshift(join(dir, 'src', `${rest}.ts`), join(dir, 'src', rest, 'index.ts'))
    if (rest.endsWith('.js')) tries.unshift(join(dir, 'src', `${rest.slice(0, -3)}.ts`))
  }
  for (const t of tries) {
    try {
      if (statSync(t).isFile()) return { pkg, file: t }
    } catch {
      /* 候选不存在 */
    }
  }
  return { pkg, file: null }
}

// ---------------------------------------------------------------- 扫描

const srcFiles = walk(packagesDir).filter((p) => p.includes(`${sep}src${sep}`))

const edges = []
for (const file of srcFiles) {
  const { text, inStr } = prepare(readFileSync(file, 'utf8'))
  const lineStarts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') lineStarts.push(i + 1)
  const lineAt = (offset) => {
    let lo = 0
    let hi = lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lineStarts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }

  const fromPkg = packageOfFile(file)
  if (!fromPkg) continue

  const push = (spec, offset, clause) => {
    if (inStr[offset]) return
    let resolved
    if (spec.startsWith('.')) {
      const f = resolveRelative(file, spec)
      if (!f) return
      resolved = { pkg: packageOfFile(f), file: f }
    } else {
      resolved = resolvePackage(spec)
    }
    if (!resolved.pkg) return
    edges.push({
      fromPkg,
      toPkg: resolved.pkg,
      fromFile: file,
      toFile: resolved.file,
      line: lineAt(offset),
      spec,
      typeOnly: clauseIsTypeOnly(clause ?? ''),
      isTest: isTestFile(file),
    })
  }

  for (const s of findStatements(text, inStr)) push(s.spec, s.offset, s.clause)
}

const crossPkg = edges.filter((e) => e.fromPkg !== e.toPkg)

// ---------------------------------------------------------------- A：跨层

/**
 * 判据：一个包只能 import **比它更低**的层。同层放行（理由见文件头）。
 */
const { reverse: reverseViolations, typeOnlyReverse, testOnlyReverse, sameLayer } = classifyCrossLayer(
  crossPkg.map((e) => ({ ...e, file: toRel(e.fromFile) })),
)

const sortEdges = (a, b) =>
  a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.file.localeCompare(b.file) || a.line - b.line
reverseViolations.sort(sortEdges)
typeOnlyReverse.sort(sortEdges)
sameLayer.sort(sortEdges)

// ---------------------------------------------------------------- B：环


const pkgKeys = [...dirByPkg.keys()].sort()
const pkgPairs = crossPkg.map((e) => ({ from: e.fromPkg, to: e.toPkg }))
const pkgAdjAll = makeAdj(pkgKeys, pkgPairs)
const pkgAdjValue = makeAdj(
  pkgKeys,
  crossPkg.filter((e) => !e.typeOnly).map((e) => ({ from: e.fromPkg, to: e.toPkg })),
)
const pkgCycles = analyzeCycles(pkgKeys, pkgAdjAll, pkgAdjValue)

// 文件级：包含包内边。同包内的文件环同样是环 —— 模块初始化顺序不看包名。
const fileKeys = srcFiles.map(toRel)
const filePairs = edges
  .filter((e) => e.toFile)
  .map((e) => ({ from: toRel(e.fromFile), to: toRel(e.toFile) }))
const fileAdjAll = makeAdj(fileKeys, filePairs)
const fileAdjValue = makeAdj(
  fileKeys,
  edges
    .filter((e) => e.toFile && !e.typeOnly)
    .map((e) => ({ from: toRel(e.fromFile), to: toRel(e.toFile) })),
)
const fileCycles = analyzeCycles(fileKeys, fileAdjAll, fileAdjValue)

// ---------------------------------------------------------------- 分层表

const layers = pkgKeys
  .map((pkg) => {
    const layer = layerOf(pkg)
    const outs = [...new Set(crossPkg.filter((e) => e.fromPkg === pkg).map((e) => e.toPkg))].sort(
      (a, b) => layerOf(a) - layerOf(b) || a.localeCompare(b),
    )
    return {
      pkg,
      layer,
      label: LAYER_LABEL[layer],
      named: layer !== IMPL_LAYER,
      dependsOn: outs.map((p) => ({ pkg: p, layer: layerOf(p) })),
    }
  })
  .sort((a, b) => a.layer - b.layer || a.pkg.localeCompare(b.pkg))

const summary = {
  reverse: reverseViolations.length,
  cycles: pkgCycles.hard.length + fileCycles.hard.length,
  cyclesPackage: pkgCycles.hard.length,
  cyclesFile: fileCycles.hard.length,
  typeOnlyReverse: typeOnlyReverse.length,
  typeOnlyCycles: pkgCycles.typeOnly.length + fileCycles.typeOnly.length,
  testOnlyReverse: testOnlyReverse.length,
  sameLayer: sameLayer.length,
}
testOnlyReverse.sort(sortEdges)

// ---------------------------------------------------------------- 输出

// 层号没有对应标签时不许崩：崩出来的报错落在这一行的 `.slice` 上，
const layerLabel = (n) => LAYER_LABEL[n] ?? `层${n}`

const fmtEdge = (e) =>
  `  ${e.from} → ${e.to}  ${layerLabel(e.fromLayer).slice(0, 2)} → ${layerLabel(e.toLayer).slice(0, 2)}` +
  ` —— ${e.file}:${e.line}${e.test ? '（测试）' : ''}  ${e.spec}`

if (asJson) {
  process.stdout.write(
    `${JSON.stringify(
      {
        layers,
        reverse: reverseViolations,
        cycles: {
          package: pkgCycles.hard,
          file: fileCycles.hard,
        },
        typeOnly: {
          reverse: typeOnlyReverse,
          cycles: { package: pkgCycles.typeOnly, file: fileCycles.typeOnly },
        },
        sameLayer,
        summary,
      },
      null,
      2,
    )}\n`,
  )
} else {
  const lines = []

  if (showLayers) {
    lines.push('【分层判定】')
    for (const l of layers) {
      const deps = l.dependsOn.length
        ? l.dependsOn.map((d) => `${d.pkg}(${LAYER_LABEL[d.layer].slice(0, 2)})`).join(' ')
        : '（无跨包依赖）'
      lines.push(`  ${LAYER_LABEL[l.layer].slice(0, 2)}  ${l.pkg.padEnd(20)} ${l.label}`)
      lines.push(`      出边：${deps}`)
    }
    lines.push(
      `  未点名的包一律归入 ${LAYER_LABEL[IMPL_LAYER].slice(0, 2)}：架构要点只点名了 schema / ports / core / cli 四层，`,
    )
    lines.push('  自行切分更细的子层会让判定依据变成脚本作者当时的理解，而不是那份共同约定。')
    lines.push('')
  }

  lines.push('【A 跨层反向依赖 —— 硬失败】')
  if (reverseViolations.length === 0) lines.push('  （无）')
  for (const e of reverseViolations) lines.push(fmtEdge(e))
  lines.push('')

  lines.push('【B 循环依赖 —— 硬失败】')
  if (pkgCycles.hard.length === 0 && fileCycles.hard.length === 0) {
    lines.push('  （无）')
  } else {
    lines.push(`  包级 ${pkgCycles.hard.length} 处`)
    for (const c of pkgCycles.hard) {
      lines.push(`    ${c.cycle ? c.cycle.join(' → ') : c.members.join(' ↔ ')}`)
    }
    lines.push(`  文件级 ${fileCycles.hard.length} 处`)
    for (const c of fileCycles.hard) {
      lines.push(`    ${c.cycle ? c.cycle.join(' → ') : c.members.join(' ↔ ')}`)
    }
  }
  lines.push('')

  lines.push('【C 类型专用 —— 仅报告，不判失败】')
  if (typeOnlyReverse.length === 0 && pkgCycles.typeOnly.length === 0 && fileCycles.typeOnly.length === 0) {
    lines.push('  （无）')
  } else {
    lines.push(`  反向引用 ${typeOnlyReverse.length} 处`)
    for (const e of typeOnlyReverse) lines.push(fmtEdge(e))
    lines.push(`  纯类型环 ${pkgCycles.typeOnly.length + fileCycles.typeOnly.length} 处`)
    for (const c of pkgCycles.typeOnly) {
      lines.push(`    [包级] ${c.cycle ? c.cycle.join(' → ') : c.members.join(' ↔ ')}`)
    }
    for (const c of fileCycles.typeOnly) {
      lines.push(`    [文件级] ${c.cycle ? c.cycle.join(' → ') : c.members.join(' ↔ ')}`)
    }
  }
  lines.push('')

  lines.push('【D 测试专用 —— 仅报告，不判失败】')
  if (testOnlyReverse.length === 0) {
    lines.push('  （无）')
  } else {
    lines.push(`  反向引用 ${testOnlyReverse.length} 处（测试不进产物，构成不了运行时依赖）`)
    for (const e of testOnlyReverse) lines.push(fmtEdge(e))
  }
  lines.push('')

  lines.push('【汇总】')
  lines.push(
    `  反向依赖 ${summary.reverse} 处 / 循环依赖 ${summary.cycles} 处（包级 ${summary.cyclesPackage}，文件级 ${summary.cyclesFile}）` +
      ` / 类型专用反向引用 ${summary.typeOnlyReverse} 处 / 纯类型环 ${summary.typeOnlyCycles} 处` +
      ` / 测试专用反向引用 ${summary.testOnlyReverse} 处`,
  )
  lines.push(
    `  同层引用 ${summary.sameLayer} 处（允许：实现包之间互引是结构性需求，拆子层等于由本脚本发明分层）`,
  )
  lines.push(
    summary.reverse + summary.cycles > 0
      ? '  结论：失败（A 或 B 命中）'
      : '  结论：通过（C / D 不影响退出码）',
  )
  process.stdout.write(`${lines.join('\n')}\n`)
}

if (summary.reverse + summary.cycles > 0) process.exitCode = 1
