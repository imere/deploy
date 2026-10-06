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

const root = fileURLToPath(new URL('..', import.meta.url))
const asJson = process.argv.includes('--json')
const showLayers = process.argv.includes('--layers')

/**
 * 层级表。
 *
 * 为什么只有这四层是点名的：架构要点给的顺序是
 * `schema`（类型/define*）→ `ports`（接口）→ `core`（编排 + 目标探测）→ 实现包 → `cli`，
 * 除这五个名字外再没有更细的层。其余包一律落在「实现包」层 —— 若由本脚本
 * 自行切出 `log` 更靠下、`transport` 更靠上之类的子层，判定依据就从「共同约定」
 * 变成了「写这个脚本的人当时的理解」，下次有人改脚本分层就会悄悄漂移。
 */
// 层序按**实际依赖方向**定，不按文档里的书写顺序：ports 不依赖任何包，它才是最底的一层。
// schema 反过来要用 ports 的 DpError / assertPortInRange / parseSshTarget 去校验配置，
// 所以 schema 在 ports 之上。把 schema 定成 L1 会让「schema 用 ports 的错误类型抛错」
// 这种正当依赖被判成反向依赖 —— 实测过，5 处违规里有 3 处是这个顺序错误造出来的。
const NAMED_LAYER = { ports: 1, schema: 2, core: 3, cli: 5 }
const IMPL_LAYER = 4
const LAYER_LABEL = {
  1: 'L1 ports（接口 / 错误 / 基础工具）',
  2: 'L2 schema（类型 / define*）',
  3: 'L3 core（编排 + 目标探测）',
  4: 'L4 实现包',
  5: 'L5 cli',
}

const packagesDir = join(root, 'packages')
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'coverage', '.git', '.tmp'])

const toPosix = (p) => p.split(sep).join('/')
const toRel = (p) => toPosix(relative(root, p))
const shortName = (pkg) => pkg.replace(/^@dp\//, '')
const layerOf = (pkg) => NAMED_LAYER[shortName(pkg)] ?? IMPL_LAYER
const isTestFile = (file) => file.endsWith('.test.ts')

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

/**
 * 两份视图：注释里的 `import x from 'y'` 与字符串里的同样不是依赖，
 * 但说明符本身活在字符串里，删掉就抽不出来。因此保留一份「注释抹平、字符串留下」
 * 的文本用于抽语句，再配一张「该偏移是否落在字符串内」的掩码剔除误命中。
 * 抹平而非删除，是为了让偏移与行号仍然对得上。
 */
function prepare(src) {
  const out = new Array(src.length)
  const inStr = new Uint8Array(src.length)
  let i = 0
  while (i < src.length) {
    const c = src[i]

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }

    if (c === '/' && src[i + 1] === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out[i] = ' '
      if (i + 1 < src.length) out[i + 1] = ' '
      i += 2
      continue
    }

    if (c === '"' || c === "'" || c === '`') {
      const quote = c
      out[i] = c
      inStr[i] = 1
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') {
          out[i] = src[i]
          inStr[i] = 1
          if (i + 1 < src.length) {
            out[i + 1] = src[i + 1] === '\n' ? '\n' : src[i + 1]
            inStr[i + 1] = 1
          }
          i += 2
          continue
        }
        if (src[i] === quote) {
          out[i] = src[i]
          inStr[i] = 1
          i += 1
          break
        }
        // 模板串可以跨行；普通引号里的换行说明是未闭合的扫尾，到此为止
        if (src[i] === '\n' && quote !== '`') break
        out[i] = src[i] === '\n' ? '\n' : src[i]
        inStr[i] = 1
        i += 1
      }
      continue
    }

    out[i] = c
    i += 1
  }
  return { text: out.join(''), inStr }
}

/**
 * import / re-export 语句。
 *
 * 为什么要求关键字顶行（`^[ \t]*` + m 标志）：`import` 出现在行中间的只剩
 * 字符串与正则两种可能，两者都已由掩码或位置排除，顶行约束能一次性挡掉
 * 这类误命中，比事后猜「这个 import 是不是真的」稳。
 *
 * 为什么子句里禁止再出现 import / export：语句跨行时非贪婪匹配会顺着换行
 * 吃到下一条语句，把 `export const a = 1` 和随后的 `import b from './c'`
 * 拼成一条假的 re-export 边。
 */
const NO_KEYWORD = String.raw`(?:(?!\bimport\b|\bexport\b)[^;'"])*?`
const RE_STATIC = new RegExp(String.raw`^[ \t]*import\b(${NO_KEYWORD})\s*from\s*(['"])([^'"]+)\2`, 'gm')
const RE_BARE = /^[ \t]*import\s*(['"])([^'"]+)\1/gm
const RE_DYNAMIC = /(?<![\w$.])import\s*\(\s*(['"])([^'"]+)\1\s*\)/g
const RE_REEXPORT = new RegExp(String.raw`^[ \t]*export\b(${NO_KEYWORD})\s*from\s*(['"])([^'"]+)\2`, 'gm')

/**
 * 类型专用判定。
 *
 * 为什么混合子句（`import { type A, B }`）算值依赖：B 会被真的求值并绑定，
 * 编译后这条边仍然存在 —— 只要有任何一个成员不是 type，就不能按类型边放行。
 */
function clauseIsTypeOnly(clause) {
  if (/^\s*type\b/.test(clause)) return true
  const open = clause.indexOf('{')
  const close = clause.lastIndexOf('}')
  if (open === -1 || close === -1) return false
  const members = clause
    .slice(open + 1, close)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (members.length === 0) return false
  return members.every((m) => /^type\s+[\w$]/.test(m))
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
  const parts = spec.split('/')
  // scope 里带斜杠（`@dp/ports`），包名得按两段取；否则裸名按一段取
  const pkg = (spec.startsWith('@') ? [parts.slice(0, 2).join('/')] : [parts[0]]).find((n) => dirByPkg.has(n))
  if (!pkg) return { pkg: null, file: null }
  const rest = spec.slice(pkg.length).replace(/^\//, '')
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

  for (const m of text.matchAll(RE_STATIC)) push(m[3], m.index, m[1])
  for (const m of text.matchAll(RE_BARE)) push(m[2], m.index, '')
  for (const m of text.matchAll(RE_DYNAMIC)) push(m[2], m.index, '')
  for (const m of text.matchAll(RE_REEXPORT)) push(m[3], m.index, m[1])
}

const crossPkg = edges.filter((e) => e.fromPkg !== e.toPkg)

// ---------------------------------------------------------------- A：跨层

/**
 * 判据：一个包只能 import **比它更低**的层。同层放行（理由见文件头）。
 * 反向且是值依赖 → 硬失败；反向但整条语句是 `import type` → 进 C。
 */
const reverseViolations = []
const typeOnlyReverse = []
// 测试文件里的反向依赖单独分桶：它**不构成运行时依赖**（测试不进产物），
// 而 core 的 slice 测试要用真实 Runner 与真实 target 跑集成，替身会丢掉真行为。
// 原顾虑是「留一个把反向依赖搬进测试就过关的口子」——但源码里的反向依赖仍然硬失败，
// 真要靠搬测试来绕，评审看得见；为这个可能性牺牲集成测试的真实性不划算。
const testOnlyReverse = []
const sameLayer = []
for (const e of crossPkg) {
  const from = layerOf(e.fromPkg)
  const to = layerOf(e.toPkg)
  const item = {
    from: e.fromPkg,
    to: e.toPkg,
    fromLayer: from,
    toLayer: to,
    file: toRel(e.fromFile),
    line: e.line,
    spec: e.spec,
    test: e.isTest,
  }
  if (to > from) (e.typeOnly ? typeOnlyReverse : e.isTest ? testOnlyReverse : reverseViolations).push(item)
  else if (to === from) sameLayer.push(item)
}

const sortEdges = (a, b) =>
  a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.file.localeCompare(b.file) || a.line - b.line
reverseViolations.sort(sortEdges)
typeOnlyReverse.sort(sortEdges)
sameLayer.sort(sortEdges)

// ---------------------------------------------------------------- B：环

/**
 * Tarjan 求强连通分量。
 *
 * 为什么用 SCC 而不是枚举所有简单环：环的数量在最坏情况下是指数级的，
 * 而「这几个节点互相可达」已经足以定位问题 —— 修好一个 SCC 需要的是
 * 知道**参与环的节点集合**，不是把每条排列都列出来。
 */
function tarjan(keys, adj) {
  const index = new Map()
  const low = new Map()
  const onStack = new Set()
  const stack = []
  const out = []
  let counter = 0

  const visit = (v) => {
    index.set(v, counter)
    low.set(v, counter)
    counter += 1
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v), low.get(w)))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v), index.get(w)))
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp = []
      let w
      do {
        w = stack.pop()
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      out.push(comp)
    }
  }

  for (const k of keys) if (!index.has(k)) visit(k)
  return out
}

/** 在 SCC 内找一条回到起点的路径 —— SCC 强连通，这样的路径必然存在。 */
function findCycle(start, members, adj) {
  const path = []
  const seen = new Set()
  const dfs = (v) => {
    path.push(v)
    seen.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!members.has(w)) continue
      if (w === start) return true
      if (seen.has(w)) continue
      if (dfs(w)) return true
    }
    path.pop()
    seen.delete(v)
    return false
  }
  return dfs(start) ? [...path, start] : null
}

/**
 * 先在**全图**上找 SCC，再在每个分量内部按**值边**重新求一次 SCC。
 *
 * 为什么要两步：只跑全图会把「A 值依赖 B、B 类型依赖 A」判成运行时环
 * （其实没有）；只跑值边又会漏掉纯类型环。两步的分工是 —— 全图负责
 * 「这些节点缠在一起」，值边负责「其中有没有真的会在运行时转不起来的圈」。
 */
function analyzeCycles(keys, adjAll, adjValue) {
  const hard = []
  const typeOnly = []
  for (const comp of tarjan(keys, adjAll)) {
    if (comp.length < 2) continue
    const members = new Set(comp)
    const inner = new Map(
      comp.map((k) => [k, new Set([...(adjValue.get(k) ?? [])].filter((x) => members.has(x)))]),
    )
    const valueCycles = tarjan([...members], inner).filter((c) => c.length > 1)
    if (valueCycles.length > 0) {
      for (const c of valueCycles) {
        const set = new Set(c)
        hard.push({ members: [...c].sort(), cycle: findCycle(c[0], set, adjValue) })
      }
    } else {
      typeOnly.push({ members: [...comp].sort(), cycle: findCycle(comp[0], members, adjAll) })
    }
  }
  const norm = (x) => x.members.join('|')
  hard.sort((a, b) => norm(a).localeCompare(norm(b)))
  typeOnly.sort((a, b) => norm(a).localeCompare(norm(b)))
  return { hard, typeOnly }
}

const makeAdj = (keys, pairs) => {
  const adj = new Map(keys.map((k) => [k, new Set()]))
  for (const { from, to } of pairs) {
    if (from === to) continue
    adj.get(from)?.add(to)
  }
  return adj
}

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

const fmtEdge = (e) =>
  `  ${e.from} → ${e.to}  ${LAYER_LABEL[e.fromLayer].slice(0, 2)} → ${LAYER_LABEL[e.toLayer].slice(0, 2)}` +
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
