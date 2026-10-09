#!/usr/bin/env node
/**
 * 门禁自检：往每个门禁脚本的**副本**里注入一次它理应抓到的违规，确认它真的变红。
 *
 * 为什么断言退出码而不是 stdout 文本：文本格式会随实现变，退出码才是这套门禁对外的
 * 契约（各有缺口就非 0）。文本只用来在结论异常时给人看现场。
 *
 * 为什么每组都先跑对照组：门禁本来就红的时候，「注入后也红」什么也证明不了。
 * 少了对照这一列，「抓到了」与「它一直红」分不开。
 *
 * 为什么全部跑在 `.tmp/gate-mut/` 的副本上：变异一旦落在真实源码或真实产物上，
 * 被它污染的窗口里，任何并发的构建或测试读到的都是半截状态，
 * 而且还原失败时毁的是真仓而不是一份可以随手丢掉的副本。
 * 六个门禁的根目录都由 `import.meta.url` 推导（`new URL('..', …)`），
 * 所以「把仓布局复制一份、把门禁脚本放进副本的 scripts/ 下」就能让它们读副本，
 * 不用改门禁脚本里的任何一个字。
 *
 * 断言的是「该红没红」，不是「源码有多干净」：抓到了只证明这一处改动被拦住，
 * 证明不了判据没有别的盲区。
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const MUT = join(repoRoot, '.tmp', 'gate-mut')
const RUN_TIMEOUT_MS = 300_000

const log = (...a) => console.log(...a)

/* ---------------------------------------------------------------- 副本 */

function copyTree(from, to) {
  if (!existsSync(from)) return false
  mkdirSync(join(to, '..'), { recursive: true })
  cpSync(from, to, { recursive: true, dereference: true })
  return true
}

/**
 * node_modules 只给产物 import 用（走包名解析），所以做一个指回真仓的 junction。
 * 不用复制：pnpm 的 isolated 布局是一堆硬链接，复制既慢又大。
 * 清理时先 unlink 掉这个 junction 再删目录 —— 对着 junction 递归删有删穿到真仓的风险。
 */
function linkNodeModules() {
  const target = join(repoRoot, 'node_modules')
  const link = join(MUT, 'node_modules')
  if (!existsSync(target)) {
    log('  ! node_modules 不存在：产物 import 的那几项将无对照（smoke 的对照组会红）')
    return
  }
  // 上一次自检没能删掉这个链接（删除有批量配额）时直接沿用：它指向的目标没变，
  // 重建反而会 EEXIST 把整轮带崩。
  if (existsSync(link) && lstatSync(link).isSymbolicLink()) {
    log('  · node_modules 链接已存在，沿用上一次留下的')
    return
  }
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  if (!lstatSync(link).isSymbolicLink()) {
    throw new Error('node_modules 链接没建成 junction —— 拒绝继续，避免清理时误删真仓')
  }
}

/**
 * 清空副本目录。整目录递归删可能被运行时拦下（本仓有安全删除垫片，批量删除要确认，
 * 而确认就是弹窗 —— 自动化里等于挂住）。拦下就退回逐项删：单个 unlink/rmdir 不构成批量。
 * 残留几个文件不会让结论失真：下面每一步都是把输入整份覆盖写，唯一的额外风险是
 * 「上一次的变异没还原」，而每一次变异自己都会校验还原结果。
 */
function clearDir() {
  if (!existsSync(MUT)) return
  try {
    rmSync(MUT, { recursive: true, force: true })
    return
  } catch {
    /*
     * 整目录删被运行时拦下时**不要**退化成逐项删：删除动作本身有批量配额，
     * 逐项删会把配额耗光，之后连 junction 与新建文件的还原都做不了，
     * 一次变异失败就会把整个自检带崩。留着目录继续即可 ——
     * 下面每一步都把输入整份覆盖写，唯一能污染结论的是「上次的变异没还原」，
     * 而每一次变异自己都会校验还原结果。
     */
    log('  ! 整目录清理被拦下（删除动作有批量配额），改为在原处覆盖写')
  }
}

function prepareMirror() {
  clearDir()
  mkdirSync(MUT, { recursive: true })
  const pkgs = join(repoRoot, 'packages')
  let copied = 0
  for (const e of readdirSync(pkgs, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    copyTree(join(pkgs, e.name, 'package.json'), join(MUT, 'packages', e.name, 'package.json'))
    copyTree(join(pkgs, e.name, 'src'), join(MUT, 'packages', e.name, 'src'))
    copyTree(join(pkgs, e.name, 'build'), join(MUT, 'packages', e.name, 'build'))
    copied += 1
  }
  copyTree(join(repoRoot, 'scripts'), join(MUT, 'scripts'))
  copyTree(join(repoRoot, 'build', 'coverage', 'lcov.info'), join(MUT, 'build', 'coverage', 'lcov.info'))
  linkNodeModules()
  log(`副本就绪：.tmp/gate-mut/  ${copied} 个包（package.json + src + build）+ scripts/ + build/coverage/lcov.info`)
  return copied
}

/* ---------------------------------------------------------------- 跑门禁 */

const runCache = new Map()
function runGate(script, args = []) {
  const file = join(MUT, 'scripts', script)
  const r = spawnSync(process.execPath, [file, ...args], {
    cwd: MUT,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error) return { code: null, error: r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  return { code: r.status, error: null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/** 同一个门禁的对照组只跑一次，后面几组变异复用它。 */
function controlRun(script, args = []) {
  const key = `${script} ${args.join(' ')}`
  if (!runCache.has(key)) runCache.set(key, runGate(script, args))
  return runCache.get(key)
}

const tail = (s, n = 40) =>
  s
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
    .slice(-n)
    .join('\n      ')

/* ---------------------------------------------------------------- 变异 */

/** 读原文 → 变换 → 写回 → 跑 → 还原。变换返回 null 表示没命中，视为自检失败而不是「绿」。 */
function runMutation({ gate, gateArgs = [], file, describe, transform }) {
  const abs = join(MUT, file)
  // 目标本来不存在 = 「新建一个违规文件」，还原时删掉
  const before = existsSync(abs) ? readFileSync(abs, 'utf8') : null
  const raw = transform(before ?? '')
  if (raw === null || raw === undefined) {
    return { describe, miss: `变异未命中：${file}` }
  }
  // 变换要么返回文本，要么返回 { text, detail }：细节只用来给人看，不参与判定
  const isBoxed = typeof raw === 'object'
  const mutated = isBoxed ? raw.text : raw
  const detail = isBoxed ? raw.detail : ''
  if (before !== null && mutated === before) {
    return { describe, miss: `变异等同于原文（锚点没找到）：${file}` }
  }

  const control = controlRun(gate, gateArgs)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, mutated)
  let after
  let restoreFailure = null
  try {
    after = runGate(gate, gateArgs)
  } finally {
    if (before === null) unlinkSync(abs)
    else writeFileSync(abs, before)
    const now = existsSync(abs) ? readFileSync(abs, 'utf8') : null
    if (now !== before) restoreFailure = new Error(`还原失败：${file} —— 副本已被污染，后续组别的对照不再可信`)
  }
  // 在 finally 里 throw 会把 runGate 自己的失败顶掉：那等于把「门禁为什么红」换成
  // 「还原失败」，真正该看的诊断反而没了。还原失败同样是致命的，但排在后面抛。
  if (restoreFailure !== null) throw restoreFailure
  return { describe, control, after, detail }
}

/* ---------------------------------------------- 六个门禁的变异形态 */

/**
 * 死代码：往一个确定被 import 的非入口源文件里加一个全仓没人引用的导出。
 *
 * 一次只试一个文件是不够的：扫描器有自己的遮罩（注释 / 字符串 / 模板插值 / 正则），
 * 某个文件的中途一旦让遮罩失配，**文件尾部**的声明就整体看不见 ——
 * 那种情况下死代码门禁对该文件是全盲的。所以按「入口引用到的非入口源文件」取若干个
 * 目标逐个试，命中数本身就是「门禁在多大范围内有效」的证据。
 */
const M_DEAD_NAME = 'zzGateMutUnreferencedExport'

/**
 * 目标：一个**只被具名 import、没有被 barrel 星号转出**的源文件。
 *
 * 这个条件是必须的，不是讲究：入口对某文件写了 `export * from './x.js'` 时，
 * 该文件的每一个导出都是对外 API 的一部分，往里加一个没人引用的导出并不违规 ——
 * 门禁把它判成活的完全正确，判红才是误报。文件本身被谁 import 只决定它「活着」，
 * 星号转出决定它的每个符号「对外可见」，两者要分开看。
 */
function pickDeadCodeTargets(limit = 3) {
  const out = []
  const pkgs = readdirSync(join(MUT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  for (const p of pkgs) {
    const srcDir = join(MUT, 'packages', p, 'src')
    if (!existsSync(srcDir)) continue
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'))
    const texts = new Map(files.map((f) => [f, readFileSync(join(srcDir, f), 'utf8')]))
    const indexText = texts.get('index.ts') ?? ''
    const starSpecs = new Set(
      [...indexText.matchAll(/export\s+\*\s+from\s+'\.\/([^']+)'/g)].map((m) => m[1].replace(/\.js$/, '')),
    )
    // 谁被谁 import：说明这些文件是活的
    const imported = new Set()
    for (const t of texts.values()) {
      for (const m of t.matchAll(/from\s+'\.\/([^']+)'/g)) imported.add(m[1].replace(/\.js$/, ''))
    }
    for (const f of files) {
      if (f === 'index.ts' || f.endsWith('.test.ts') || f.endsWith('.d.ts')) continue
      const rel = f.replace(/\.ts$/, '')
      if (!imported.has(rel) || starSpecs.has(rel)) continue
      out.push(`packages/${p}/src/${f}`)
      if (out.length >= limit) return out
    }
  }
  if (out.length === 0) throw new Error('找不到「只被具名 import、没被星号转出」的源文件作为死代码变异目标')
  return out
}

const mutDeadCode = (file) => ({
  gate: 'dead-code.mjs',
  file,
  describe: `在 ${file} 追加一个全仓零引用的导出 ${M_DEAD_NAME}（该文件被别的模块具名 import、没有 export * 转出，所以这个符号真的没人用）`,
  transform: (src) => {
    if (src.includes(M_DEAD_NAME)) return null
    return (
      `${src}\n/** 门禁自检注入：这个导出没有任何引用方，判定应当落在「确认的死代码」里。 */\n` +
      `export function ${M_DEAD_NAME}(): string {\n  return 'unused'\n}\n`
    )
  },
})

/**
 * 分层：最底的一层反向依赖 cli，是硬失败。
 *
 * 追加到**已存在**的入口文件而不是新建文件：删除动作在本仓有批量配额，新建文件的
 * 还原要靠 unlink —— 一旦配额被别处耗光，还原就会抛错并把整个自检带崩，
 * 而入口文件本来就能承载这条 import（这个门禁不给入口文件开豁免）。
 */
const mutImports = () => {
  const candidates = ['packages/ports/src/index.ts', 'packages/core/src/index.ts', 'packages/template/src/index.ts']
  const file = candidates.find((c) => existsSync(join(MUT, c)))
  if (!file) throw new Error('找不到可承载反向 import 的入口文件')
  return {
    gate: 'check-imports.mjs',
    gateArgs: ['--json'],
    file,
    describe: `在 ${file} 追加一条 import 指向 cli：cli 在层级表里是最上层，被更低的层引用属于反向跨层依赖（硬失败）`,
    transform: (src) => {
      if (src.includes('zzGateMutEdge')) return null
      return `${src}\n// 门禁自检注入：更低的层去引用最上层，这是反向跨层依赖\nimport { zzGateMutEdge } from '@dp/cli'\n`
    },
  }
}

/** JSDoc：往公共入口塞一个没有任何注释的导出。 */
function pickPkgWithIndex() {
  const dirs = readdirSync(join(MUT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  for (const d of dirs) if (existsSync(join(MUT, 'packages', d, 'src', 'index.ts'))) return d
  throw new Error('找不到有 src/index.ts 的包')
}

const mutJsdoc = () => {
  const pkg = pickPkgWithIndex()
  const file = `packages/${pkg}/src/index.ts`
  const name = 'zzGateMutUndocumented'
  return {
    gate: 'check-jsdoc.mjs',
    file,
    describe: `在 ${file} 追加一个无 JSDoc 的导出 ${name}（公共入口上的符号缺注释 = 门禁该抓的缺口）`,
    transform: (src) => {
      if (src.includes(name)) return null
      return `${src}\nexport function ${name}(input: string): string {\n  return input\n}\n`
    },
  }
}

/**
 * 依赖声明：往一个**不依赖 local 的包**里塞一条 `import from '@dp/local'`。
 *
 * 这一组验的是「本机绿、CI 红」那一类：未声明的依赖在本机靠 junction 能解析，
 * 只有 pnpm 的 isolated 布局会拒绝它。所以必须由门禁在本机就抓住。
 */
const mutDeps = () => {
  const file = 'packages/core/src/detect.ts'
  if (!existsSync(join(MUT, file))) throw new Error(`找不到 ${file}`)
  return {
    gate: 'check-deps.mjs',
    file,
    describe: `在 ${file} 追加一条 import 指向 @dp/local（core 的 package.json 没声明它）：本机靠 junction 能解析，isolated 布局下是 TS2307`,
    transform: (src) => {
      if (src.includes('zzGateMutDep')) return null
      return `${src}\n// 门禁自检注入：未声明的跨包依赖\nimport type { zzGateMutDep } from '@dp/local'\n`
    },
  }
}

/** 假测试：零断言用例 + 形同虚设的 throws（都没有第二参 = 没校验错误）。 */
function pickTestFile() {
  const pkgs = readdirSync(join(MUT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  for (const p of pkgs) {
    const srcDir = join(MUT, 'packages', p, 'src')
    if (!existsSync(srcDir)) continue
    for (const f of readdirSync(srcDir).sort()) {
      if (f.endsWith('.test.ts')) return `packages/${p}/src/${f}`
    }
  }
  throw new Error('找不到 .test.ts')
}

const mutTests = () => {
  const file = pickTestFile()
  return {
    gate: 'check-tests.mjs',
    file,
    describe: `在 ${file} 追加两个「假测试」：零断言用例 + 只有单参的 assert.throws（都没校验错误类型）`,
    transform: (src) => {
      if (src.includes('zzGateMut')) return null
      return (
        `${src}\n\n// 门禁自检注入：下面两个用例什么都不验证，实现改成永远不抛也能全绿。\n` +
        `test('zzGateMut 零断言', () => {\n  const value = 1\n  void value\n})\n\n` +
        `test('zzGateMut throws 无校验函数', () => {\n  assert.throws(() => {\n    throw new Error('boom')\n  })\n})\n`
      )
    },
  }
}

/** 覆盖率：两个独立的硬判据各做一次 —— 命中数调小、整条记录删掉。 */
const GATED = ['schema', 'core', 'template']

function lcovSegments(text) {
  return text.split('end_of_record')
}

function gatedRecordIndex(segs, gated) {
  for (let i = 0; i < segs.length; i += 1) {
    const m = /^[\s\S]*?SF:(.+)/m.exec(segs[i])
    if (!m) continue
    const sf = m[1].trim().replace(/\\/g, '/')
    if (gated.some((g) => sf.startsWith(`packages/${g}/build/`))) return i
  }
  return -1
}

const mutCoverageHit = () => {
  const file = 'build/coverage/lcov.info'
  return {
    gate: 'check-coverage.mjs',
    file,
    describe: `把 lcov 里第一个受门槛包产物的 LH 减 1（门槛 100%，掉 1 行即未达标）`,
    transform: (src) => {
      const segs = lcovSegments(src)
      const i = gatedRecordIndex(segs, GATED)
      if (i === -1) return null
      const sf = /SF:(.+)/.exec(segs[i])[1].trim().replace(/\\/g, '/')
      const lh = /^LH:(\d+)\r?$/m.exec(segs[i])
      if (!lh || Number(lh[1]) <= 0) return null
      const segs2 = [...segs]
      segs2[i] = segs[i].replace(/^LH:(\d+)(\r?)$/m, (_m, n, c) => `LH:${Number(n) - 1}${c}`)
      return { text: segs2.join('end_of_record'), detail: `${sf}  LH ${lh[1]} → ${Number(lh[1]) - 1}` }
    },
  }
}

const mutCoverageNoRecord = () => {
  const file = 'build/coverage/lcov.info'
  return {
    gate: 'check-coverage.mjs',
    file,
    describe: '把 lcov 里第一个受门槛包产物的整条记录删掉（盘上有产物、lcov 里查无此文件 = 没有任何测试碰过它）',
    transform: (src) => {
      const segs = lcovSegments(src)
      const i = gatedRecordIndex(segs, GATED)
      if (i === -1) return null
      const sf = /SF:(.+)/.exec(segs[i])[1].trim().replace(/\\/g, '/')
      const segs2 = [...segs]
      segs2[i] = ''
      return { text: segs2.join('end_of_record'), detail: `删除记录 ${sf}` }
    },
  }
}

/** 产物 smoke：给一个包的入口产物塞语法错误，import 必须失败。 */
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

function pickSmallestEntry() {
  const pkgs = readdirSync(join(MUT, 'packages'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
  let best = null
  for (const p of pkgs) {
    const manifestPath = join(MUT, 'packages', p, 'package.json')
    if (!existsSync(manifestPath)) continue
    let manifest
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }
    const entry = resolveEntry(manifest)
    if (typeof entry !== 'string') continue
    const abs = join(MUT, 'packages', p, entry)
    if (!existsSync(abs)) continue
    const size = readFileSync(abs, 'utf8').length
    if (!best || size < best.size) best = { file: `packages/${p}/${entry}`.split('\\').join('/'), size }
  }
  if (!best) throw new Error('找不到任何包的入口产物')
  return best.file
}

const mutSmoke = () => {
  const file = pickSmallestEntry()
  return {
    gate: 'smoke.mjs',
    file,
    describe: `在 ${file}（最小的包入口产物）末尾追加一段语法错误，该包 import 必须失败`,
    transform: (src) => {
      if (src.includes('zzGateMut')) return null
      return `${src}\n// 门禁自检注入：形参表不闭合，import 必须在这里 SyntaxError\nfunction zzGateMutBroken( {\n`
    },
  }
}

/* ---------------------------------------------------------------- 跑 */

/**
 * 清理。junction 先单独 unlink：目录里留着它又递归删，等于把真仓的 node_modules 交给
 * 一个递归删除。删不掉就警告 —— 残留几个临时文件远好过把自检变成一次误删。
 */
function cleanup() {
  const link = join(MUT, 'node_modules')
  try {
    if (existsSync(link) && lstatSync(link).isSymbolicLink()) unlinkSync(link)
  } catch (err) {
    log(`  ! node_modules 链接没删掉，跳过目录清理以免误删：${err.message}`)
    return
  }
  try {
    rmSync(MUT, { recursive: true, force: true })
  } catch (err) {
    log(`  ! 清理 .tmp/gate-mut/ 失败（不影响结论）：${err.message}`)
  }
}

function collectMutations() {
  return [
    ...pickDeadCodeTargets().map(mutDeadCode),
    mutImports(),
    mutDeps(),
    mutJsdoc(),
    mutTests(),
    mutCoverageHit(),
    mutCoverageNoRecord(),
    mutSmoke(),
  ]
}

let passed = 0
let total
const blind = []
const broken = []
const missed = []
const envBlocked = []

try {
  prepareMirror()
  const MUTATIONS = collectMutations()
  total = MUTATIONS.length

  log('')
  log('门禁注入自检  （对照退出码必须为 0；注入后必须非 0）')
  log('')
  for (const m of MUTATIONS) {
    const r = runMutation(m)
    log(`门禁 ${m.gate}`)
    log(`  变异手法  ${r.describe}`)
    if (r.miss) {
      log('  对照退出码  ——')
      log('  注入后退出码 ——')
      log('  结论      自检失败：' + r.miss)
      log('')
      missed.push(`${m.gate}: ${r.miss}`)
      continue
    }
    // 派不起子进程时**不许判成「该红没红」**：那是环境结论，不是门禁结论，
    // 混在一起会驱动人去改一个本来就对的门禁。但也不能当绿放行 ——
    // 自检没跑成就是没跑成，让人看见。
    if (r.control.error || r.after.error) {
      const why = r.control.error ?? r.after.error
      log('  对照退出码  ——')
      log('  注入后退出码 ——')
      log(`  结论      自检未生效：环境无法派生子进程（${why.code ?? why.message}）`)
      log('')
      envBlocked.push(`${m.gate} —— ${why.code ?? why.message}`)
      continue
    }
    const ok = r.control.code === 0 && r.after.code !== 0
    const verdict = !ok
      ? r.control.code !== 0
        ? '对照组不绿 —— 无法判断（副本状态与真实门禁不一致）'
        : '该红没红'
      : 'PASS 抓到了'
    log(`  对照退出码  ${r.control.code}`)
    log(`  注入后退出码 ${r.after.code}`)
    log(`  结论      ${verdict}`)
    if (r.detail) log(`  命中细节  ${r.detail}`)
    if (!ok) {
      log(`  现场（注入后）\n      ${tail(r.after.stdout || r.after.stderr) || '(无输出)'}`)
      ;(r.control.code === 0 ? blind : broken).push(`${m.gate} —— ${r.describe}`)
    } else {
      passed += 1
    }
    log('')
  }
} finally {
  cleanup()
}

log(
  `汇总：${total} 组注入，通过 ${passed}，该红没红 ${blind.length}` +
    (broken.length ? `，对照组不绿 ${broken.length}` : '') +
    (missed.length ? `，变异未命中 ${missed.length}` : '') +
    (envBlocked.length ? `，环境未生效 ${envBlocked.length}` : ''),
)
if (blind.length) {
  log('该红没红的门禁：')
  for (const b of blind) log(`  - ${b}`)
}
if (broken.length) {
  log('对照组就不绿的（副本与真实门禁状态不一致，需先解释清楚）：')
  for (const b of broken) log(`  - ${b}`)
}
if (missed.length) {
  log('变异未命中（自检本身失效，不是门禁的结论）：')
  for (const m of missed) log(`  - ${m}`)
}
if (envBlocked.length) {
  log('环境无法派生子进程，这几组自检没跑起来（门禁本身没错，换能派子进程的环境重跑）：')
  for (const b of envBlocked) log(`  - ${b}`)
}
process.exitCode = blind.length + broken.length + missed.length + envBlocked.length > 0 ? 1 : 0
