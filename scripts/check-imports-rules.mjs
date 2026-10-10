
/**
 * 层级表。
 */
// 层序按**实际依赖方向**定，不按约定的书写顺序：ports 不依赖任何包，它才是最底的一层。
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
 */
export const layerOf = (pkg) => NAMED_LAYER[shortName(pkg)] ?? IMPL_LAYER

/** 测试文件判定只认后缀：测试与源码同目录，没有别的可靠标志。 */
export const isTestFile = (file) => file.endsWith('.test.ts')

/**
 * 两份视图：注释抹平、字符串留下，再配一张「该偏移是否落在字符串内」的掩码剔除误命中。
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
 */
const NO_KEYWORD = String.raw`(?:(?!\bimport\b|\bexport\b)[^;'"])*?`
const RE_STATIC = new RegExp(String.raw`^[ \t]*import\b(${NO_KEYWORD})\s*from\s*(['"])([^'"]+)\2`, 'gm')
const RE_BARE = /^[ \t]*import\s*(['"])([^'"]+)\1/gm
const RE_DYNAMIC = /(?<![\w$.])import\s*\(\s*(['"])([^'"]+)\1\s*\)/g
const RE_REEXPORT = new RegExp(String.raw`^[ \t]*export\b(${NO_KEYWORD})\s*from\s*(['"])([^'"]+)\2`, 'gm')

/**
 * 类型专用判定。
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