import { join, resolve as resolvePath, dirname } from 'node:path'

/**
 * 遮罩源码文本，保留可被静态判定的骨架。`keepStrings` 决定字面量内容是留是抹。
 *
 * @param {string} src 源码文本
 * @param {boolean} keepStrings true = 抹注释留字符串，false = 字符串一起抹（保留行结构）
 * @returns {string} 遮罩后的文本，长度与行数与输入一致
 */
export function scan(src, keepStrings) {
  let out = ''
  let i = 0
  const stack = [{ type: 'code', braces: 0 }]
  let lastSig = ''
  let lastWord = ''

  /** 除号还是正则起始：靠前一个有效字符判断，看不准就当除号（少剥一层，偏向漏报）。 */
  const regexAllowed = () => {
    if (lastSig === '') return true
    if ('(,=:[!&|?{};+-*%<>~^'.includes(lastSig)) return true
    return [
      'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
      'do', 'else', 'yield', 'await', 'instanceof',
    ].includes(lastWord)
  }

  const literal = (c) => {
    if (keepStrings) out += c
    else out += c === '\n' ? '\n' : ' '
  }

  while (i < src.length) {
    const frame = stack[stack.length - 1]
    const c = src[i]

    if (frame.type === 'tpl') {
      if (c === '\\') {
        out += keepStrings ? src.slice(i, i + 2) : (src[i + 1] === '\n' ? ' \n' : '  ')
        i += 2
        continue
      }
      if (c === '`') {
        out += keepStrings ? '`' : ' '
        i += 1
        stack.pop()
        lastSig = '`'
        lastWord = ''
        continue
      }
      if (c === '$' && src[i + 1] === '{') {
        out += '${'
        i += 2
        stack.push({ type: 'code', braces: 0 })
        continue
      }
      literal(c)
      i += 1
      continue
    }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i += 1
      }
      continue
    }

    if (c === '/' && src[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i += 1
      }
      out += '  '
      i += 2
      continue
    }

    if (c === '"' || c === "'") {
      literal(c)
      i += 1
      while (i < src.length) {
        if (src[i] === '\\') {
          out += keepStrings ? src.slice(i, i + 2) : (src[i + 1] === '\n' ? ' \n' : '  ')
          i += 2
          continue
        }
        if (src[i] === c) {
          literal(c)
          i += 1
          break
        }
        if (src[i] === '\n') break
        literal(src[i])
        i += 1
      }
      lastSig = '"'
      lastWord = ''
      continue
    }

    if (c === '`') {
      literal('`')
      i += 1
      stack.push({ type: 'tpl' })
      lastSig = '`'
      lastWord = ''
      continue
    }

    if (c === '/' && regexAllowed()) {
      let j = i + 1
      let inClass = false
      let ok = false
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        else if (src[j] === '/' && !inClass) {
          ok = true
          break
        }
        j += 1
      }
      if (ok) {
        const tail = /^[a-z]*/.exec(src.slice(j + 1))?.[0] ?? ''
        out += keepStrings ? src.slice(i, j + 1 + tail.length) : ' '.repeat(j - i + 1 + tail.length)
        i = j + 1 + tail.length
        lastSig = '/'
        lastWord = ''
        continue
      }
    }

    if (c === '{') frame.braces += 1
    if (c === '}') {
      if (frame.braces === 0 && stack.length > 1) {
        out += keepStrings ? '}' : ' '
        i += 1
        stack.pop()
        continue
      }
      frame.braces -= 1
    }

    out += c
    if (/\S/.test(c)) {
      lastSig = c
      lastWord = /[\w$]/.test(c) ? lastWord + c : ''
    } else if (!/[\w$]/.test(c)) {
      lastWord = ''
    }
    i += 1
  }

  return out
}

/**
 * 造偏移 → 行号的换算函数（1 起）。
 *
 * @param {string} text 文本
 * @returns {(offset: number) => number} 换算函数
 */
export function makeLineAt(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1)
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/**
 * 收集 `export` 声明。输入必须是抹字符串视图 —— 声明不会出现在字面量里。
 *
 * @param {string} code 抹掉注释与字符串后的代码骨架
 * @returns {{decls: Map<string, {name: string, kind: string, offset: number, line: number}>, uncertain: {name: string|null, line: number, reason: string}[]}}
 */
export function collectDeclarations(code) {
  const lineAt = makeLineAt(code)
  const decls = new Map()
  const uncertain = []

  const re = /(?<![\w$.])export\s+(?:declare\s+)?(?:abstract\s+)?(?:(async)\s+)?(function|class|const|let|var|interface|type|enum|namespace)\s+(\*?\s*[A-Za-z_$][\w$]*)/g
  for (const m of code.matchAll(re)) {
    const kind = m[2]
    const raw = m[3].replace('*', '').trim()
    const offset = m.index + m[0].lastIndexOf(raw)
    if (decls.has(raw)) continue
    decls.set(raw, { name: raw, kind, offset, line: lineAt(offset) })
    // 多声明符 `export const a = 1, b = 2` 只认得到第一个，剩下的不猜
    if (/^\s*,\s*[A-Za-z_$][\w$]*\s*(:|=|,)/.test(code.slice(offset + raw.length))) {
      uncertain.push({ name: raw, line: lineAt(offset), reason: '多声明符导出只解析出第一个名字，其余未计入' })
    }
  }

  for (const m of code.matchAll(/(?<![\w$.])export\s+(?:default\b)/g)) {
    uncertain.push({ name: null, line: lineAt(m.index), reason: '存在 export default，按约定不查' })
  }
  for (const m of code.matchAll(/(?<![\w$.])export\s*(?:declare\s+)?(?:async\s+)?(?:function\s*|class\s*|const\s*|let\s*|var\s*)?\{/g)) {
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 2)
    if (after.startsWith('{')) {
      uncertain.push({ name: null, line: lineAt(m.index), reason: '解构导出，无法静态列出名字' })
    }
  }

  return { decls, uncertain }
}

/**
 * 收集 import / export-from 说明符。输入必须是留字符串视图 —— 说明符本身就是字符串。
 *
 * @param {string} code 抹掉注释、保留字符串的代码骨架
 * @returns {{edges: {spec: string, line: number, kind: string}[], forwards: {spec: string, line: number, star: boolean}[], dynamic: {raw: string, line: number}[]}}
 */
export function collectSpecifiers(code) {
  const lineAt = makeLineAt(code)
  const edges = []
  const forwards = []
  const dynamic = []

  // import 之后到下一个分号/换行起的新 import 之前，才算同一条语句
  for (const m of code.matchAll(/(?<![\w$.])import\b/g)) {
    const window = code.slice(m.index, m.index + 400)
    const stop = window.slice(1).search(/;|(?<![\w$.])import\b/)
    const stmt = stop === -1 ? window : window.slice(0, stop + 1)
    if (/^\s*import\s*['"]/.test(stmt)) {
      const lit = /^\s*import\s*(['"])([^'"]+)\1/.exec(stmt)
      if (lit) edges.push({ spec: lit[2], line: lineAt(m.index), kind: 'static' })
      continue
    }
    const from = /\bfrom\s*(['"])([^'"]+)\1/.exec(stmt)
    if (from) edges.push({ spec: from[2], line: lineAt(m.index), kind: 'static' })
    else if (/\(\s*$/.test(stmt)) {
      // import ( 不是静态 import，交给下面的动态分支
    }
  }

  for (const m of code.matchAll(/(?<![\w$.])import\s*\(\s*([^()]*?)\s*\)/g)) {
    const arg = m[1].trim()
    const lit = /^(['"])([^'"]+)\1$/.exec(arg)
    if (lit) edges.push({ spec: lit[2], line: lineAt(m.index), kind: 'dynamic' })
    else dynamic.push({ raw: arg.slice(0, 60), line: lineAt(m.index) })
  }

  for (const m of code.matchAll(/(?<![\w$.])export\s*\*\s*from\s*(['"])([^'"]+)\1/g)) {
    forwards.push({ spec: m[2], line: lineAt(m.index), star: true })
  }
  for (const m of code.matchAll(/(?<![\w$.])export\s*(?:type\s*)?\{[^}]*\}\s*from\s*(['"])([^'"]+)\1/g)) {
    forwards.push({ spec: m[2], line: lineAt(m.index), star: false })
  }

  return { edges, forwards, dynamic }
}

/** 测试文件：`node --test` 按文件名发现执行，不靠 import，结构上必然无仓内引用方。 */
export function isTestFile(rel) {
  return rel.endsWith('.test.ts')
}

/** 包入口：对外 API 表面，仓内无引用不等于外部无引用。 */
export function isPkgEntry(rel) {
  return /(^|[\\/])src[\\/]index\.ts$/.test(rel)
}

/**
 * 相对说明符与 `@dp/*` 包说明符各应按什么顺序试。
 *
 * @param {string} root 仓库根绝对路径
 * @param {string} fromFile 引用方文件绝对路径
 * @param {string} spec import 说明符原文
 * @returns {string[]} 按优先级排好的候选绝对路径
 */
export function specifierCandidates(root, fromFile, spec) {
  if (spec.startsWith('.')) {
    const base = resolvePath(dirname(fromFile), spec)
    const tries = [base]
    if (base.endsWith('.js')) tries.push(base.slice(0, -3) + '.ts')
    if (base.endsWith('.mjs')) tries.push(base.slice(0, -4) + '.mts')
    if (!/\.[cm]?[jt]sx?$/.test(base)) {
      tries.push(`${base}.ts`, join(base, 'index.ts'), `${base}.mjs`, join(base, 'index.mjs'))
    }
    return tries
  }
  const dp = /^@dp\/([^/]+)$/.exec(spec)
  if (dp) return [join(root, 'packages', dp[1], 'src', 'index.ts')]
  return []
}

/**
 * 数一个名字在代码骨架里出现多少次。
 *
 * @param {string} code 抹掉注释与字符串后的代码骨架
 * @param {string} name 标识符名
 * @param {number|null} [skipOffset] 要跳过的偏移，通常是声明起点
 * @returns {number} 出现次数
 */
export function countRefs(code, name, skipOffset) {
  const re = new RegExp(`(?<![\\w$])${name}(?![\\w$])`, 'g')
  let count = 0
  for (const m of code.matchAll(re)) {
    if (skipOffset != null && m.index >= skipOffset && m.index < skipOffset + name.length) continue
    count += 1
  }
  return count
}

/**
 * 星号转发的可达性闭包，迭代到不动点。
 *
 * @param {string[]} paths 全部已知文件路径
 * @param {Map<string, Set<string>>} starTargets 一跳转发目标
 * @returns {Map<string, Set<string>>} 每个文件能经星号转发抵达的文件集合
 */
export function starReach(paths, starTargets) {
  const reach = new Map(paths.map((p) => [p, new Set()]))
  for (let round = 0; round <= paths.length; round += 1) {
    let dirty = false
    for (const p of paths) {
      for (const t of starTargets.get(p) ?? []) {
        if (reach.get(p).has(t)) continue
        reach.get(p).add(t)
        dirty = true
        for (const t2 of reach.get(t)) reach.get(p).add(t2)
      }
    }
    if (!dirty) break
  }
  return reach
}