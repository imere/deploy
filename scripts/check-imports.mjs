/**
 * 分层与循环依赖门禁。
 *
 * 为什么要有它：架构要点里「严禁循环依赖与跨层反向依赖」过去只能靠自觉，
 * 自觉的意思是**没有人会在改代码那天重新读一遍分层**，于是破例会被复制成惯例。
 * 这里把它变成一条可执行的判据：破例仍然可以发生，但必须在 CI 里被看见、被点名。
 *
 * 三档结论，与死代码门禁同构：
 *   A 跨层反向依赖（值 import）      硬失败 —— 运行时真的把上层拉进了下层
 *   B 循环依赖（包级 / 文件级）       硬失败 —— 环内的模块无法按依赖顺序单独初始化
 *   C 类型专用（import type / export type）  仅报告 —— 编译后不留痕迹，
 *     不构成运行时依赖，但会让分层图看起来是破的，得让人看见再自行判断
 *
 * 为什么同层允许：现状里实现包之间互引是**结构性的**而不是疏漏 ——
 * transport 要用 ssh 的信道、target-* 要用 template 渲染，把它们拆成子层
 * 等于由本脚本的作者发明一套架构要点里没有的分层。同层互引只统计、不判失败，
 * 逐包列出便于人复核这一判断还成不成立。
 *
 * 测试文件**照扫但只报告**（D 类）：本仓的测试与源码同目录，测试里 `@dp/local`
 * 与源码里的 `@dp/local` 在构建图上没区别，所以不排除它们 —— 但**不判失败**。
 * 理由：测试不进产物，构成不了运行时依赖；而 core 的 slice 测试要用真实 Runner
 * 与真实 target 跑集成，改成替身会丢掉真行为。源码里的反向依赖仍然硬失败，
 * 真要靠搬进测试来绕，评审看得见。
 *
 * 为什么不上 TypeScript 编译器：本仓有它，但把一个纯静态门禁变成秒级启动
 * 不值得 —— 这里需要的只是「哪一行 import 了哪个包」，正则足够，且不会
 * 因为一次构建失败就失去门禁能力（恰好是出问题时最需要它的时刻）。
 *
 * 说明符解析必须覆盖相对路径：本仓大量使用 `../core/index.js` 这类写法，
 * 只认 `@dp/` 前缀会让相当一部分真实依赖从图上消失 —— 漏报比误报危险，
 * 因为门禁一旦出现「扫不出来」的路径，那条路径就会被优先使用。
 */
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
 * 为什么不硬编码包名列表：新增一个实现包时，门禁应该在**它第一次建立依赖**
 * 那天就生效，而不是等有人想起来回来改脚本 —— 硬编码列表的失败模式恰好是
 * 静默漏掉新包（新包不在表里 → 不参与判定 → 反向依赖永远扫不到）。
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
 * 反向且是值依赖 → 硬失败；反向但整条语句是 `import type` → 进 C。
 *
 * 测试文件里的反向依赖单独分桶：它**不构成运行时依赖**（测试不进产物），
 * 而 core 的 slice 测试要用真实 Runner 与真实 target 跑集成，替身会丢掉真行为。
 * 原顾虑是「留一个把反向依赖搬进测试就过关的口子」——但源码里的反向依赖仍然硬失败，
 * 真要靠搬测试来绕，评审看得见；为这个可能性牺牲集成测试的真实性不划算。
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
// 看的人只会看到 TypeError，真正的「层号不在已定义层里」被完全盖住。
// 退回打印层号本身 —— 报告里出现一个裸数字，比一次崩溃好定位得多。
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
