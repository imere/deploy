/**
 * 变异测试 harness：往构建产物里注入一个变异 → 跑该包测试 → 判定「杀死（变红）」还是
 * 「存活（仍绿）」。**存活 = 这段实现被改坏了测试却没反应 = 假测试的藏身处。**
 *
 * 为什么所有写都被隔离到 .tmp/mutate：
 *   曾经手工做变异，六个变异注入后产物没还原，最后靠删掉 build + 全量重建才救回来。
 *   这里用结构而不是靠小心来防这件事：
 *     1. 目标包的 packages/<pkg>/build 被**只读复制**成 .tmp/mutate/packages/<pkg>/build
 *        （连 package.json 与 src 一起），副本目录结构保持一致；
 *     2. @dp/* 交叉引用用 junction 指回副本 —— 否则 `import '@dp/x'` 会解析到真产物，
 *        变异悄悄失效，然后被记成「存活」（一种纯属噪声的假信号）；
 *     3. 一切落盘都过 writeInside()：先确认路径在 .tmp/mutate 下，再顺着链接问一次
 *        落点的真身，所以「写进 packages 的 build」在这份代码里不是纪律问题而是不可达分支；
 *     4. 跑之前和之后对 packages 各包的 build 做文件数+字节数快照，不一致就是红线被踩；
 *     5. try/finally + 信号处理器兜住中断，临时目录一定删。
 *
 * 为什么每个变异都要先 `node --check`：改崩语法会让测试以 import 失败变红，
 * 那不是「测试抓到了」，是被误判成杀死。语法不成立的一律不计入统计。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath, relative, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { classifyOutcome, matchExemption, pkgOfArtifactPath, unusedExemptions, validateExemptions } from './mutate-rules.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const PKGS_ROOT = join(root, 'packages')
const TMP = join(root, '.tmp', 'mutate')
const TMP_PKGS = join(TMP, 'packages')
const CHECK_DIR = join(TMP, '.check')
const EXEMPT_FILE = join(root, 'scripts', 'mutate-exempt.json')

const TEST_TIMEOUT_MS = 120_000
const CHECK_TIMEOUT_MS = 15_000
const DEFAULT_MAX = 30
const DEFAULT_FAIL_OVER = 20

const out = (s) => process.stdout.write(`${s}\n`)
const err = (s) => process.stderr.write(`${s}\n`)

/** Windows 路径大小写不敏感，判定包含关系时必须同一形式。 */
const inside = (p, base) => {
  const r = resolvePath(p).toLowerCase()
  const b = resolvePath(base).toLowerCase()
  return r === b || r.startsWith(b.endsWith(sep) ? b : b + sep)
}

const linkPaths = []

/** 沿路径往上找第一个存在的祖先并还原成真路径（新文件还没有本体，只能问祖先）。 */
function realpathOfExisting(abs) {
  try {
    return realpathSync(abs)
  } catch {
    const parent = dirname(abs)
    return parent === abs ? abs : realpathOfExisting(parent)
  }
}

function writeInside(abs, data) {
  if (!inside(abs, TMP)) throw new Error(`拒绝写入临时目录之外的路径：${abs}`)
  // 路径落在临时根内 ≠ 落点是副本：临时根里放的是指向真目录的 junction（docs、非目标包），
  // 顺着它写出去照样污染仓库。再跑一次 realpath 问清「落点的真身在哪」才放行。
  const real = realpathOfExisting(abs)
  if (!inside(real, TMP)) throw new Error(`拒绝穿过链接写入临时目录之外：${abs}（真身 ${real}）`)
  writeFileSync(abs, data)
}

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = { pkg: null, max: DEFAULT_MAX, json: false, failOver: DEFAULT_FAIL_OVER, exempt: true }
  const value = (i, name) => {
    const v = argv[i + 1]
    if (v === undefined) throw new Error(`缺少 ${name} 的参数值`)
    return v
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--package') { opts.pkg = value(i, a); i += 1; continue }
    if (a === '--max') {
      const n = Number(value(i, a))
      if (!Number.isInteger(n) || n < 0) throw new Error('--max 需要非负整数')
      opts.max = n
      i += 1
      continue
    }
    if (a === '--json') { opts.json = true; continue }
    // 不看豁免清单地跑一遍：清单是对代码的判断，不是对被豁免者的免检证件。
    // 想复核「某处的杀不死」到底成不成立时用它，得到的是没减过的原始数字。
    if (a === '--no-exempt') { opts.exempt = false; continue }
    if (a === '--fail-over') {
      const n = Number(value(i, a))
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('--fail-over 需要 0~100 的百分数')
      opts.failOver = n
      i += 1
      continue
    }
    throw new Error(`未知参数：${a}（可用：--package / --max / --json / --fail-over / --no-exempt）`)
  }
  return opts
}

// ---------------------------------------------------------------- 文件系统

function walkFiles(dir, outList = []) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return outList
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walkFiles(p, outList)
    else if (e.isFile()) outList.push(p)
  }
  return outList
}

function listPackages() {
  let pkgs = []
  try {
    pkgs = readdirSync(PKGS_ROOT, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
  return pkgs.filter((n) => existsSync(join(PKGS_ROOT, n, 'build'))).sort()
}

/** 真产物的指纹：只要「有没有多/少文件」或「任何一个文件字节数变了」就说明被污染。 */
function fingerprint(scope) {
  const map = new Map()
  for (const pkg of scope) {
    for (const f of walkFiles(join(PKGS_ROOT, pkg, 'build'))) {
      try {
        map.set(f, statSync(f).size)
      } catch {
        map.set(f, -1)
      }
    }
  }
  return map
}

const measure = (map) => {
  let bytes = 0
  for (const size of map.values()) bytes += size
  return { files: map.size, bytes }
}

function diffFingerprint(before, after) {
  const added = []
  const removed = []
  const changed = []
  for (const [p, size] of after) {
    if (!before.has(p)) added.push(p)
    else if (before.get(p) !== size) changed.push(p)
  }
  for (const p of before.keys()) if (!after.has(p)) removed.push(p)
  return { added, removed, changed }
}

function linkDir(target, link) {
  // 未开开发者模式的 Windows 上 symlink 报 EPERM，junction 可用（scripts/link-workspace.mjs 同因）
  try {
    symlinkSync(target, link, 'junction')
  } catch {
    symlinkSync(target, link, 'dir')
  }
  linkPaths.push(link)
}

/**
 * 副本与 junction 的分工（这条决定了跑一次的开销）：
 *   - 目标包：真正复制 build（只留 .js —— .map/.d.ts 不参与执行，带上它们会让临时文件数翻三倍，
 *     而删一个临时文件的成本远高于复制它）+ src（ssh 的 hygiene 用例要回头读源码）+ package.json；
 *   - 非目标包、以及仓库根的其余条目：用 junction 指到真目录，只读、零复制。
 *     它们之所以能安全地指回真物，是因为 writeInside 会把「落点真身」问清楚再放行。
 *
 * 少了根条目的镜像，ports 那条 `new URL('../../../docs/failures.md', import.meta.url)`
 * 就会指空，基线变红 —— 基线红的时候任何变异判定都没有意义。
 */
const COPY_FILTER = (p) => !/\.(map|d\.ts)$/.test(p)

function prepareWorkspace(pkgs, targets) {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP_PKGS, { recursive: true })
  for (const pkg of pkgs) {
    const src = join(PKGS_ROOT, pkg)
    const dst = join(TMP_PKGS, pkg)
    if (!targets.has(pkg)) {
      linkDir(src, dst)
      continue
    }
    cpSync(join(src, 'build'), join(dst, 'build'), { recursive: true, filter: COPY_FILTER })
    cpSync(join(src, 'package.json'), join(dst, 'package.json'))
    if (existsSync(join(src, 'src'))) cpSync(join(src, 'src'), join(dst, 'src'), { recursive: true })
  }
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'packages' || e.name === 'node_modules') continue
    linkDir(join(root, e.name), join(TMP, e.name))
  }
  const scope = join(TMP_PKGS, 'node_modules', '@dp')
  mkdirSync(scope, { recursive: true })
  for (const pkg of pkgs) linkDir(join(TMP_PKGS, pkg), join(scope, pkg))
}

function cleanupTmp() {
  // 先显式摘链接再删树：junction 不是普通目录，提前 unlink 能避免任何误递归的可能
  for (const link of linkPaths.splice(0)) {
    try {
      rmSync(link, { force: true })
    } catch {
      /* 已不存在 */
    }
  }
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch (e) {
    err(`[mutate] 清理 .tmp/mutate 失败：${e.message}`)
  }
}

// ---------------------------------------------------------------- 子进程（一律带 timeout）

function runNode(args, timeoutMs) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    // 子进程的 stdin 必须关掉：一是铁律 0（永不等人类输入），二是在受限环境里
    // 建这条管道会因为权限报 EBUSY，让整个 harness 开不了工
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  })
}

const tailOf = (text, n = 12) => {
  const lines = (text ?? '').split('\n').filter((l) => l.trim() !== '')
  return lines.slice(-n).join('\n')
}

function runPackageTests(pkg) {
  const files = walkFiles(join(TMP_PKGS, pkg, 'build')).filter((p) => p.endsWith('.test.js')).sort()
  if (files.length === 0) return { ok: null, reason: '没有测试文件', detail: '' }
  const r = runNode(['--test', '--test-reporter=dot', ...files], TEST_TIMEOUT_MS)
  if (r.error?.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout', detail: '' }
  if (r.error) return { ok: false, reason: r.error.code ?? 'spawn-error', detail: r.error.message }
  const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`
  return { ok: r.status === 0, reason: r.status === 0 ? '' : 'failed', detail: tailOf(combined) }
}

/** 改崩语法的变异必须剔除：那种「变红」是 import 炸了，不是被测试抓住。 */
function parsesAsEsm(src) {
  mkdirSync(CHECK_DIR, { recursive: true })
  const probe = join(CHECK_DIR, 'probe.mjs')
  writeInside(probe, src)
  try {
    const r = runNode(['--check', probe], CHECK_TIMEOUT_MS)
    return r.status === 0
  } finally {
    rmSync(probe, { force: true })
  }
}

// ---------------------------------------------------------------- 变异算子

/**
 * 等长遮盖字符串/模板字面量与行注释。
 *
 * 为什么不能直接对原行做替换：改字符串内容不改变行为，会被记成「测试没抓到」，
 * 而它根本不是实现的一部分 —— 那是本 harness 最想要避免的噪声来源。
 */
function maskLiterals(line) {
  let res = ''
  let i = 0
  let mode = 'code'
  while (i < line.length) {
    const c = line[i]
    if (mode === 'code') {
      if (c === '/' && line[i + 1] === '/') break
      if (c === "'" || c === '"' || c === '`') {
        mode = c
        res += ' '
        i += 1
        continue
      }
      res += c
      i += 1
      continue
    }
    if (c === '\\') {
      res += '  '
      i += 2
      continue
    }
    if ((mode === "'" && c === "'") || (mode === '"' && c === '"') || (mode === '`' && c === '`')) mode = 'code'
    res += ' '
    i += 1
  }
  return res.length === line.length ? res.padEnd(line.length, ' ') : line
}

const lineStarts = (src) => {
  const starts = [0]
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') starts.push(i + 1)
  return starts
}

/**
 * 单文件候选点。每处是独立的一次变异（每次只改一处，改完还原），
 * 所以同一行可以产出多个候选，但它们从不同时生效。
 */
function collectCandidates(pkg, file, rel) {
  const src = readFileSync(file, 'utf8')
  const starts = lineStarts(src)
  const lines = src.split('\n')
  const cands = []
  const add = (kind, label, start, end, text, line) => {
    cands.push({ pkg, file, rel, kind, label, start, end, text, line })
  }

  const nextMeaningful = (i) => {
    for (let k = i + 1; k < lines.length; k += 1) {
      const t = lines[k].trim()
      if (t !== '') return t
    }
    return ''
  }

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const mask = maskLiterals(raw)
    const trimmed = mask.trim()
    if (trimmed === '' || /^(\/\/|\*|\/\*)/.test(trimmed)) continue
    // 纯 import / 再导出行上没有行为，变异它们只会产出一堆永不被加载的假候选
    if (/^(import\b|export\s*\{|export\s*\*)/.test(trimmed)) continue
    const at = (m) => starts[i] + m.index
    const first = (re) => re.exec(mask)

    // 早返回守卫删除 —— 最能揪出假测试的一类：少一道校验，行为明显变了还可能全绿
    const singleGuard = /^\s*if\s*\(.*\)\s*(throw\b[^;]*;|\{\s*throw\b[^;]*;\s*\})\s*$/.exec(mask)
    const blockOpen = /^\s*if\s*\(.*\)\s*\{\s*$/.exec(mask)
    if (singleGuard || blockOpen) {
      const closes = nextMeaningful(i).startsWith('else')
      if (!closes) {
        if (singleGuard) {
          add('删守卫', '删掉 `if (...) throw ...`', starts[i], starts[i] + raw.length, '', i + 1)
        } else {
          const body = /^\s*throw\b[^;]*;\s*$/.exec(maskLiterals(lines[i + 1] ?? ''))
          if (body && (lines[i + 2] ?? '').trim() === '}') {
            add('删守卫', '删掉 `if (...) { throw ... }`', starts[i], starts[i + 2] + lines[i + 2].length, '', i + 1)
          }
        }
      }
    }

    const neg = first(/\bif\s*\(\s*!/)
    if (neg) {
      const bang = neg.index + neg[0].length - 1
      add('取反', '`if (!x)` → `if (x)`', at({ index: bang }), at({ index: bang }) + 1, '', i + 1)
    }

    const eq = first(/ === /) ?? first(/ !== /)
    if (eq) {
      const after = eq[0].includes('!==') ? ' === ' : ' !== '
      add('布尔翻转', `\`${eq[0].trim()}\` → \`${after.trim()}\``, at(eq), at(eq) + eq[0].length, after, i + 1)
    }

    const logic = first(/ && /) ?? first(/ \|\| /)
    if (logic) {
      const after = logic[0].includes('&&') ? ' || ' : ' && '
      add('布尔翻转', `\`${logic[0].trim()}\` → \`${after.trim()}\``, at(logic), at(logic) + logic[0].length, after, i + 1)
    }

    const slice = first(/(?<![\w$.])slice\(\s*0\s*,\s*-1\s*\)/)
    if (slice) {
      add('边界改动', '`slice(0, -1)` → `slice(0)`', at(slice), at(slice) + slice[0].length, 'slice(0)', i + 1)
    }

    const lt = first(/(?<![<>=!])<(?![<=])/)
    if (lt) add('边界改动', '`<` → `<=`', at(lt), at(lt) + 1, '<=', i + 1)

    const plus = first(/\+\s*1(?![.\d])/)
    if (plus) {
      const after = plus[0].replace('+', '-')
      add('边界改动', `\`${plus[0]}\` → \`${after}\``, at(plus), at(plus) + plus[0].length, after, i + 1)
    }
  }
  return cands
}

const applyMutation = (src, m) => `${src.slice(0, m.start)}${m.text}${src.slice(m.end)}`

// ---------------------------------------------------------------- 豁免清单

/**
 * 读入 `scripts/mutate-exempt.json`（等价变异名单）。
 *
 * 格式不对时**整体停手**而不是跳过：跳过意味着那一批等价变异重新回到存活分子里，
 * 每周报告会一直顶在阈值边缘，而看报告的人并不知道清单压根没读进去 ——
 * 那比清单写错更难发现。
 *
 * @param {boolean} enabled `--no-exempt` 会给 false
 * @returns {object[] | null} 校验通过的条目；格式不对或未启用时为空数组；不可用返回 null
 */
function loadExemptions(enabled) {
  if (!enabled || !existsSync(EXEMPT_FILE)) return []
  let parsed
  try {
    parsed = JSON.parse(readFileSync(EXEMPT_FILE, 'utf8'))
  } catch (e) {
    err(`[mutate] 豁免清单不是合法 JSON：${EXEMPT_FILE}（${e.message}）`)
    return null
  }
  const v = validateExemptions(parsed)
  if (!v.ok) {
    for (const p of v.problems) err(`[mutate] 豁免清单：${p}`)
    return null
  }
  return v.entries
}

// ---------------------------------------------------------------- 主流程

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (e) {
    err(`[mutate] ${e.message}`)
    return { exitCode: 2 }
  }

  const allPkgs = listPackages()
  if (allPkgs.length === 0) {
    err('[mutate] packages/*/build 不存在，先构建再跑本脚本')
    return { exitCode: 2 }
  }
  if (opts.pkg && !allPkgs.includes(opts.pkg)) {
    err(`[mutate] 未知包 ${opts.pkg}（可选：${allPkgs.join(', ')}）`)
    return { exitCode: 2 }
  }

  const exemptions = loadExemptions(opts.exempt)
  // null = 清单读不出来或格式不对，此时 loadExemptions 已经把原因打出来了。不停手的话
  // 那一批等价变异会静默回到存活分子里，报告看起来「变差了」而原因没人知道。
  if (exemptions === null) return { exitCode: 2 }

  const targets = opts.pkg ? [opts.pkg] : allPkgs
  const before = fingerprint(allPkgs)
  const beforeMeasure = measure(before)
  let exitCode = 0
  const survivors = []
  const invalid = []
  const exempted = [] // 命中豁免且仍绿：登记时的判断今天依然成立
  const stale = [] // 命中豁免却被杀：清单的理由已经过期
  const usedKeys = new Set()
  let killed = 0

  prepareWorkspace(allPkgs, new Set(targets))
  try {
    const baseline = new Map()
    for (const pkg of targets) baseline.set(pkg, runPackageTests(pkg))

    const usable = []
    for (const pkg of targets) {
      const b = baseline.get(pkg)
      if (b.ok === true) {
        usable.push(pkg)
        continue
      }
      err(`[mutate] ${pkg} 基线不通过（${b.reason}），跳过 —— 基线是红的就没法判定变异`)
      if (b.detail) err(b.detail.split('\n').map((l) => `        ${l}`).join('\n'))
      exitCode = 1
    }

    const queues = usable.map((pkg) => {
      const buildDir = join(TMP_PKGS, pkg, 'build')
      const files = walkFiles(buildDir).filter((p) => p.endsWith('.js') && !p.endsWith('.test.js')).sort()
      const cands = []
      for (const f of files) {
        // 报告里给的是**真产物**的相对路径（副本结构与它一致，行号可以直接照着去看）
        cands.push(...collectCandidates(pkg, f, relative(TMP, f).split(sep).join('/')))
      }
      return { pkg, cands }
    })

    const pool = queues.reduce((n, q) => n + q.cands.length, 0)
    const plan = []
    while (plan.length < opts.max) {
      let moved = false
      for (const q of queues) {
        if (plan.length >= opts.max) break
        const c = q.cands.shift()
        if (!c) continue
        plan.push(c)
        moved = true
      }
      if (!moved) break
    }
    if (plan.length === 0) {
      out('无可变异点（也许目标包全是测试文件或没有可用行数）')
      return { exitCode }
    }

    if (!opts.json) {
      out(`候选变异 ${pool} 处，本轮跑 ${plan.length} 个（上限 ${opts.max}）；包：${targets.join(', ')}`)
      out('')
    }

    const pristine = new Map()
    const timedOutPkgs = new Set()
    for (const m of plan) {
      if (timedOutPkgs.has(m.pkg)) {
        invalid.push({ ...m, note: '同包测试已超时一次，跳过以免反复干等' })
        continue
      }
      if (!pristine.has(m.file)) pristine.set(m.file, readFileSync(m.file, 'utf8'))
      const original = pristine.get(m.file)
      const mutated = applyMutation(original, m)
      if (mutated === original || m.text === original.slice(m.start, m.end)) {
        invalid.push({ ...m, note: '变异没有真正改变内容' })
        continue
      }
      if (!parsesAsEsm(mutated)) {
        invalid.push({ ...m, note: '改完语法不成立，判定为无效变异' })
        continue
      }
      writeInside(m.file, mutated)
      let res
      try {
        res = runPackageTests(m.pkg)
      } finally {
        // 无论测试跑成什么样都要还原副本 —— 逐个还原让「残留变异」从一开始就不存在
        writeInside(m.file, original)
      }
      // `file` 是给 matchExemption 看的（清单记的是产物相对路径），`rel`/`kind`
      // 是给报告看的 —— 两边都从同一个 m 取，不会再出现「清单写对了却一次都没匹配上」
      const mutation = { file: m.rel, pkg: m.pkg, rel: m.rel, line: m.line, kind: m.kind, label: m.label }
      const ex = matchExemption(exemptions, mutation)
      if (ex) usedKeys.add(ex.key)
      const verdict = classifyOutcome(res, ex)
      if (verdict.bucket === 'survived') {
        survivors.push(m)
        if (!opts.json) out(`  [存活] ${m.rel}:${m.line}  ${m.kind} ${m.label}`)
      } else if (verdict.bucket === 'exempted') {
        // 登记在案的等价变异：登记时的判断是「改了也看不出来」，今天也确实没人看出来
        exempted.push({ ...mutation, reason: ex.reason })
        if (!opts.json) out(`  [豁免] ${m.rel}:${m.line}  ${m.kind} ${m.label}`)
      } else {
        killed += 1
        if (verdict.stale) stale.push(mutation)
        if (res.reason === 'timeout') timedOutPkgs.add(m.pkg)
        if (!opts.json) {
          const note = verdict.stale
            ? '（登记为杀不死，如今却被杀 → 清单过期）'
            : res.reason === 'timeout'
              ? '（测试超时）'
              : ''
          out(`  [杀死] ${m.rel}:${m.line}  ${m.kind} ${m.label}${note}`)
        }
      }
    }

    const decided = killed + survivors.length
    const rate = decided === 0 ? 0 : (survivors.length / decided) * 100
    // 「清单里的条目一次都没命中」与「命中了却被杀」要说成两件事：前者多半是产物行号变了，
    // 后者是清单在替一处已经被守住的代码说话。同一处若两种情形都成立，只报后者 —— 它更紧迫。
    //
    // 只对本轮参与的**那些包**清单条目做「没用上」的统计：清单是全仓共享的，跑 core 时
    // 属于 schema 的那几条自然匹配不到，报出来会让人以为它们失效了。
    const staleKeys = new Set(stale.map((m) => `${m.rel}:${m.line} ${m.label}`))
    const relevant = exemptions.filter((e) => targets.includes(pkgOfArtifactPath(e.file)))
    const idle = unusedExemptions(relevant, usedKeys).filter((e) => !staleKeys.has(`${e.file}:${e.line} ${e.label}`))

    if (opts.json) {
      // 豁免 / 过期 / 落空与存活一起输出：只给存活数字的报告会被读成「测试写得好」，
      // 而真实原因可能是清单在替一处已经守不住的代码说话。
      out(JSON.stringify({
        summary: {
          total: decided,
          killed,
          survived: survivors.length,
          rate: Number(rate.toFixed(1)),
          failOver: opts.failOver,
          candidates: pool,
          planned: plan.length,
          exempted: exempted.length,
          stale: stale.length,
          idle: idle.length,
        },
        survivors: survivors.map((m) => ({ file: m.rel, line: m.line, kind: m.kind, label: m.label })),
        invalid: invalid.map((m) => ({ file: m.rel, line: m.line, kind: m.kind, label: m.label, note: m.note })),
        exempted: exempted.map((m) => ({ file: m.rel, line: m.line, label: m.label })),
        stale: stale.map((m) => ({ file: m.rel, line: m.line, label: m.label })),
        idle: idle.map((e) => ({ file: e.file, line: e.line, label: e.label })),
      }, null, 2))
    } else {
      out('')
      out('存活变异（测试仍绿 —— 这些正是假测试的藏身处）：')
      if (survivors.length === 0) out('  （无）')
      for (const m of survivors) out(`  ${m.rel}:${m.line}  ${m.kind} ${m.label} —— 测试仍绿`)
      if (invalid.length > 0) {
        out('')
        out(`未计入 ${invalid.length} 个（变异没生效 / 语法不成立，不代表测试有问题）：`)
        for (const m of invalid) out(`  ${m.rel}:${m.line}  ${m.kind} ${m.label} —— ${m.note}`)
      }
      // 豁免 / 过期 / 落空这三件事必须出现在同一份报告里：它们解释的是「为什么这个数字
      // 是这样」，缺了它们的人会把「少了两个存活」当成测试写得好。
      if (exempted.length > 0) {
        out('')
        out(`豁免 ${exempted.length} 个（登记在案的等价变异 —— 改了行为完全相同，见 scripts/mutate-exempt.json 的理由）：`)
        for (const m of exempted) out(`  ${m.rel}:${m.line}  ${m.kind} ${m.label}`)
      }
      if (stale.length > 0) {
        out('')
        out(`清单过期 ${stale.length} 处：登记时说杀不死，这一轮却被杀了 —— 更新或删掉 scripts/mutate-exempt.json 里对应条目：`)
        for (const m of stale) out(`  ${m.rel}:${m.line}  ${m.kind} ${m.label}`)
      }
      if (idle.length > 0) {
        out('')
        out(`清单里有 ${idle.length} 条一次都没匹配上（多半是产物行号变了，该处已回到统计里）：`)
        for (const e of idle) out(`  ${e.file}:${e.line} ${e.label}`)
      }
      out('')
      out(`变异 ${decided} 个：杀死 ${killed} / 存活 ${survivors.length}（存活率 ${rate.toFixed(1)}%）`)
      out(`另有 ${invalid.length} 个无效变异未计入`)
    }

    if (rate > opts.failOver) exitCode = 1
    // 清单过期也算红：条目留着不会让存活率失真（它仍计为杀死），但会让清单慢慢烂掉 ——
    // 下一次有人照着清单去判断「这处本来就该豁免」时，读到的就是过期结论。周跑一次，
    // 删条目的成本远低于排查一份没人维护的清单。
    if (stale.length > 0) exitCode = 1
    return { exitCode }
  } finally {
    cleanupTmp()
    const cleaned = !existsSync(TMP)
    const after = fingerprint(allPkgs)
    const d = diffFingerprint(before, after)
    const afterMeasure = measure(after)
    const dirty = d.added.length + d.removed.length + d.changed.length
    const label = (p) => relative(root, p).split(sep).join('/')
    // JSON 模式下 stdout 要保持机器可读，所以这两条证据改走 stderr，但绝不省略
    const evidence = opts.json ? err : out
    if (!opts.json) evidence('')
    evidence(`临时目录已清理：${cleaned}（.tmp/mutate）`)
    evidence(`产物自检：packages 各包 build ${beforeMeasure.files} 个文件 / ${beforeMeasure.bytes} 字节 → ${afterMeasure.files} 个文件 / ${afterMeasure.bytes} 字节`)
    if (dirty > 0) {
      err('[mutate] 红线被踩：packages/*/build 在本次运行前后不一致')
      for (const p of d.added) err(`  + ${label(p)}`)
      for (const p of d.removed) err(`  - ${label(p)}`)
      for (const p of d.changed) err(`  ~ ${label(p)}`)
      exitCode = 1
    }
    process.exitCode = exitCode
  }
}

process.on('SIGINT', () => {
  cleanupTmp()
  process.exit(130)
})
process.on('SIGTERM', () => {
  cleanupTmp()
  process.exit(143)
})

main()
