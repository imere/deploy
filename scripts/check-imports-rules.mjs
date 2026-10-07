/**
 * 分层与循环依赖门禁里可以独立验证的那一块：分层表、层序比较、import 语句识别、
 * 环检测，以及跨层分类。
 *
 * 单独成模块是为了让它能被 `node --test` 直接断言。判据一旦被改坏有两种坏法，都不会有
 * 别的信号：放宽到抓不住（门禁全绿但反向依赖已经进仓）或误伤（报出的 5 处「反向依赖」
 * 全是分层表自己写反造成的 —— 误报会驱动人去改本来正确的代码）。
 *
 * 只放**纯文本判定**：输入源码文本、边表、包名，输出层级、语句列表、环、分类分桶。
 * 不读文件、不扫目录 —— 文件系统那一侧留在 check-imports.mjs。
 */

/**
 * 层级表。
 *
 * 为什么只有这四层是点名的：共同约定给的顺序是
 * `schema`（类型/define*）→ `ports`（接口）→ `core`（编排 + 目标探测）→ 实现包 → `cli`，
 * 除这五个名字外再没有更细的层。其余包一律落在「实现包」层 —— 若由门禁
 * 自行切出 `log` 更靠下、`transport` 更靠上之类的子层，判定依据就从「共同约定」
 * 变成了「写这个脚本的人当时的理解」，下次有人改分层就会悄悄漂移。
 */
// 层序按**实际依赖方向**定，不按约定的书写顺序：ports 不依赖任何包，它才是最底的一层。
// schema 反过来要用 ports 的 DpError / assertPortInRange / parseSshTarget 去校验配置，
// 所以 schema 在 ports 之上。把 schema 定成 L1 会让「schema 用 ports 的错误类型抛错」
// 这种正当依赖被判成反向依赖 —— 实测过，5 处违规里有 3 处是这个顺序错误造出来的。
export const NAMED_LAYER = { ports: 1, schema: 2, core: 3, cli: 5 }
export const IMPL_LAYER = 4
export const LAYER_LABEL = {
  1: 'L1 ports（接口 / 错误 / 基础工具）',
  2: 'L2 schema（类型 / define*）',
  3: 'L3 core（编排 + 目标探测）',
  4: 'L4 实现包',
  5: 'L5 cli',
}

/** `@dp/xxx` → `xxx`。层序比较只认短名。 */
export const shortName = (pkg) => pkg.replace(/^@dp\//, '')

/**
 * 一个包落在哪一层。
 *
 * 数字越小越底层：**被依赖方向**是从高往低，所以 `layerOf(to) > layerOf(from)` 才是
 * 反向依赖。这条不等号是本门禁最容易整体翻转的地方（翻转后不是"少报"而是"全报"），
 * 端口是最底层这一点由测试单独钉住。
 */
export const layerOf = (pkg) => NAMED_LAYER[shortName(pkg)] ?? IMPL_LAYER

/** 测试文件判定只认后缀：测试与源码同目录，没有别的可靠标志。 */
export const isTestFile = (file) => file.endsWith('.test.ts')

/**
 * 两份视图：注释抹平、字符串留下，再配一张「该偏移是否落在字符串内」的掩码剔除误命中。
 *
 * 为什么抹平而非删除：要让偏移与行号仍然对得上，否则报出来的行号会指到别的地方。
 * 为什么字符串要留下：说明符本身活在字符串里，删掉就抽不出 import 边。
 */
export function prepare(src) {
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
        out[i] = src[i]
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
export function clauseIsTypeOnly(clause) {
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

/**
 * 抽出源码文本里的全部依赖边（尚未解析说明符）。
 *
 * 返回顺序固定为「静态 import → 副作用 import → 动态 import() → re-export」：
 * 分类与输出的排序只按 from/to/file/line，但并列项的相对次序会进最终输出，
 * 顺序变了就是行为变了。
 *
 * `inStr` 掩码在这里消费而不是留给调用方逐边筛：漏筛一条的后果是「把字符串里写的
 * specifier 当成真实依赖」，那是凭空造边。
 */
export function findStatements(text, inStr) {
  const found = []
  const push = (spec, offset, clause) => {
    if (inStr && inStr[offset]) return
    found.push({ spec, offset, clause: clause ?? '' })
  }
  for (const m of text.matchAll(RE_STATIC)) push(m[3], m.index, m[1])
  for (const m of text.matchAll(RE_BARE)) push(m[2], m.index, '')
  for (const m of text.matchAll(RE_DYNAMIC)) push(m[2], m.index, '')
  for (const m of text.matchAll(RE_REEXPORT)) push(m[3], m.index, m[1])
  return found
}

/**
 * 把裸包名拆成「包名 + 包内剩余路径」。
 *
 * 为什么 scope 要单独处理：`@dp/ports` 里包名本身带斜杠，按单段切会得到
 * `@dp`，于是任何仓内包都会被当成仓外依赖而静默消失（漏报比误报危险）。
 * 查不到包名时返回 null，交给调用方丢弃这条边。
 */
export function splitPackageSpec(spec, dirByPkg) {
  if (spec.startsWith('.')) return { pkg: null, rest: null }
  const parts = spec.split('/')
  // scope 里带斜杠（`@dp/ports`），包名得按两段取；否则裸名按一段取
  const pkg = (spec.startsWith('@') ? [parts.slice(0, 2).join('/')] : [parts[0]]).find((n) => dirByPkg.has(n))
  if (!pkg) return { pkg: null, rest: null }
  return { pkg, rest: spec.slice(pkg.length).replace(/^\//, '') }
}

/**
 * 把跨包边分进四桶：反向硬失败 / 类型专用 / 测试专用 / 同层。
 *
 * 判据：包只能 import **比它更低**的层。同层放行（实现包之间互引是结构性需求，
 * 拆子层等于由本脚本发明架构里没有的分层），只统计便于人复核。
 *
 * 优先级有顺序：类型专用先于测试专用。两者都只报告，但一条 `import type` 边即使来自
 * 测试也是类型边，先分错桶会让人按错理由去改。
 */
export function classifyCrossLayer(edges) {
  const reverse = []
  const typeOnlyReverse = []
  const testOnlyReverse = []
  const sameLayer = []
  for (const e of edges) {
    const fromLayer = layerOf(e.fromPkg)
    const toLayer = layerOf(e.toPkg)
    // 字段与键序是输出的一部分：--json 逐字符对照，这一层不能再自己拼
    const item = {
      from: e.fromPkg,
      to: e.toPkg,
      fromLayer,
      toLayer,
      file: e.file,
      line: e.line,
      spec: e.spec,
      test: e.isTest,
    }
    if (toLayer > fromLayer) {
      const bucket = e.typeOnly ? typeOnlyReverse : e.isTest ? testOnlyReverse : reverse
      bucket.push(item)
    } else if (toLayer === fromLayer) {
      sameLayer.push(item)
    }
  }
  return { reverse, typeOnlyReverse, testOnlyReverse, sameLayer }
}

/**
 * Tarjan 求强连通分量。
 *
 * 为什么用 SCC 而不是枚举所有简单环：环的数量在最坏情况下是指数级的，
 * 而「这几个节点互相可达」已经足以定位问题 —— 修好一个 SCC 需要的是
 * 知道**参与环的节点集合**，不是把每条排列都列出来。
 */
export function tarjan(keys, adj) {
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
export function findCycle(start, members, adj) {
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
export function analyzeCycles(keys, adjAll, adjValue) {
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

/** 由边表建邻接表。自环不算边：自己依赖自己不构成环。 */
export function makeAdj(keys, pairs) {
  const adj = new Map(keys.map((k) => [k, new Set()]))
  for (const { from, to } of pairs) {
    if (from === to) continue
    adj.get(from)?.add(to)
  }
  return adj
}