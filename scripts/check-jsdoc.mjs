/**
 * 公共 API 的 JSDoc 门禁。
 *
 * 为什么只扫每个包的 `src/index.ts` 导出的东西：全量扫 296 个源文件会一次冒出
 * 几百条，接上门禁就永远是红的 —— 没人会去修一个永远红的检查，它会退化成背景噪声，
 * 比没有检查更糟。收口到公共 API，缺口是有限且能真正补完的集合。
 *
 * 为什么不用 TypeScript 编译器 API：它确实在仓里，但拖进来后门禁会跟着 tsconfig、
 * 项目引用、编译缓存一起变慢变脆 —— 一个检查注释的脚本不该依赖「能编译过」。
 * 本文件只需要：JSDoc 块、声明名、形参名、interface 成员。这四样用遮罩后的
 * 正则 + 括号配平就够，不需要完整 AST。
 *
 * 启发式（疑似复述）**不参与退出码**：把描述判成「复述」是猜，写得好的注释
 * （如「拆 user@host:port。不补默认端口 —— …」）在词面上和函数名有重叠是常态。
 * 误报会让门禁失去可信度，所以它只提示。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const packagesDir = join(root, 'packages')

// ============================================================
// 源码遮罩：把注释与字符串内容换成等长空格（保留换行）
// ============================================================

const PREV_SIGNIFICANT = /[([{,;:=!&|?+\-*/%~^<>]|\breturn|\btypeof|\bcase|\bdo|\bin|\bof|\bnew|\bdelete|\bvoid/
const IDENT_CHAR = /[\w$]/

/**
 * @returns 与 src 等长的字符串：注释与字符串内部被空格替换，换行保留。
 * 这样后续所有正则都只在**真实代码**上匹配，注释里的函数声明不会再被当成声明。
 */
function mask(src, stringsToo = true) {
  const out = src.split('')
  let i = 0
  let prev = ''
  const n = src.length
  while (i < n) {
    const c = src[i]
    const c2 = src.slice(i, i + 2)
    if (c2 === '//') {
      while (i < n && src[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (c2 === '/*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? n : end + 2
      for (let k = i; k < stop; k += 1) if (src[k] !== '\n') out[k] = ' '
      i = stop
      continue
    }
    if (stringsToo && (c === "'" || c === '"' || c === '`')) {
      out[i] = ' '
      i += 1
      while (i < n) {
        if (src[i] === '\\') {
          out[i] = ' '
          if (src[i + 1] !== '\n') out[i + 1] = ' '
          i += 2
          continue
        }
        if (src[i] === c) break
        if (src[i] !== '\n') out[i] = ' '
        i += 1
      }
      if (i < n) {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (c === '/' && (prev === '' || PREV_SIGNIFICANT.test(prev))) {
      // 正则字面量：按「前一个有效字符」判别。漏判的代价是把 /re/ 的内容当代码，
      // 后果只是多扫一个假声明；错判成正则的代价是丢掉后面的真声明，所以宁可漏判。
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') {
          j += 2
          continue
        }
        if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        else if (src[j] === '/' && !inClass) {
          closed = true
          break
        }
        j += 1
      }
      if (closed) {
        while (j < n && src[j] !== '\n') {
          out[j] = ' '
          j += 1
        }
        i = j
        prev = '/'
        continue
      }
    }
    if (!/\s/.test(c)) prev = c
    i += 1
  }
  return out.join('')
}

// ============================================================
// 括号配平与 token 工具
// ============================================================

const OPEN = { '(': ')', '[': ']', '{': '}', '<': '>' }
const CLOSE = new Set([')', ']', '}', '>'])

/** 从 open 位置的括号起做配平扫描。angle 为真时把 `>` 当尖括号（泛型），否则只认三种硬括号。 */
function matchBracket(masked, open, angle = false) {
  const want = OPEN[masked[open]]
  let depth = 0
  for (let i = open; i < masked.length; i += 1) {
    const c = masked[i]
    if (OPEN[c] && (angle || c !== '<')) depth += 1
    else if (CLOSE.has(c) && (angle || c !== '>')) {
      depth -= 1
      if (depth === 0) return masked[i] === want ? i : -1
      if (depth < 0) return -1
    }
  }
  return -1
}

/**
 * 在 (start, end) 之间按顶层逗号切分（字符串与注释已被遮罩，不会误切）。
 *
 * 尖括号必须参与配平，否则 `opts: Readonly<Record<string, string>>` 会被逗号切成
 * 碎片，碎片里冒出一个叫 `string` 的假形参，报出「形参 string 没有 @param」。
 * 但 `>` 有两种身份：泛型闭合与箭头 `=>`。所以只在**类型注解区**里把尖括号当括号，
 * 进入的时机是顶层冒号，退出的时机是顶层等号（默认值）——默认值里写 `1 < 2`
 * 这种比较不该被当成泛型，否则后面的逗号又会被吞掉。
 */
function splitTop(masked, start, end) {
  const parts = []
  let depth = 0
  let inType = false
  let cur = ''
  for (let i = start; i < end; i += 1) {
    const c = masked[i]
    // 箭头整体跳过：它长得像「等号 + 泛型闭合」，拆开判两种都判错
    if (c === '=' && masked[i + 1] === '>') {
      cur += '=>'
      i += 1
      continue
    }
    if (depth === 0 && c === ':') inType = true
    else if (depth === 0 && inType && c === '=') inType = false

    if (OPEN[c] && c !== '<' && c !== '>') depth += 1
    else if (CLOSE.has(c) && c !== '>') depth -= 1
    else if (inType && c === '<') depth += 1
    else if (inType && c === '>') depth -= 1

    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
      inType = false
      continue
    }
    cur += c
  }
  if (cur.trim() !== '') parts.push(cur)
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

/** 从一段形参文本里取出绑定的名字。解构的每个键都算（`{ a, b }` → a、b）。 */
function paramNames(text) {
  let t = text.trim()
  if (t === '') return []
  t = t.replace(/^(?:public|private|protected|readonly)\s+/, '')
  if (t.startsWith('{') || t.startsWith('[')) {
    const open = 0
    const close = matchBracket(t, open)
    if (close === -1) return []
    const inner = t.slice(open + 1, close)
    const names = []
    // 深度优先找 `ident` / `ident:` 两种形态，避开默认值与嵌套右值
    let depth = 0
    let cur = ''
    const chunks = []
    for (const c of inner) {
      if (OPEN[c] && c !== '<') depth += 1
      else if (CLOSE.has(c) && c !== '>') depth -= 1
      if (c === ',' && depth === 0) {
        chunks.push(cur)
        cur = ''
        continue
      }
      cur += c
    }
    if (cur.trim() !== '') chunks.push(cur)
    for (const chunk of chunks) {
      const c2 = chunk.trim().replace(/^\.\.\./, '')
      const head = c2.split('=')[0].split(':').length > 1 ? c2.split('=')[0] : c2.split(':')[0]
      const m = head.trim().match(/^([A-Za-z_$][\w$]*)/)
      if (m) names.push(m[1])
      else if (c2.trim().startsWith('{') || c2.trim().startsWith('[')) names.push(...paramNames(c2))
    }
    return names
  }
  const head = t.split('=')[0].trim().replace(/^\.\.\./, '')
  const nameOnly = head.includes(':') ? head.slice(0, head.indexOf(':')) : head
  const m = nameOnly.trim().match(/^([A-Za-z_$][\w$]*)/)
  return m ? [m[1]] : []
}

// ============================================================
// JSDoc 解析
// ============================================================

function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === '\n') line += 1
  return line
}

/** 取出紧邻 `pos` 之前、允许中间有空白与 `export` 关键字的 JSDoc 块。 */
function docBefore(src, pos) {
  let i = pos - 1
  while (i >= 0 && /\s/.test(src[i])) i -= 1
  if (i < 1 || src[i] !== '/' || src[i - 1] !== '*') return null
  if (i >= 2 && src[i - 2] === '*' && src[i - 3] !== '/') return null // /**/ 空块不算
  const open = src.lastIndexOf('/**', i)
  if (open === -1) return null
  const end = src.indexOf('*/', open + 3)
  if (end === -1 || end > i) return null
  return { open, text: src.slice(open + 3, end) }
}

/** 把 JSDoc 块拆成 { summary, params: [{ name, rest }], returns, tags }。 */
function parseDoc(block) {
  const lines = block.split('\n').map((l) => l.replace(/^\s*\*ing?/, '').replace(/^\s*\*ing?/, '').replace(/^\s*\* ?/, '').replace(/^\s+/, ''))
  const tags = []
  const summary = []
  const params = []
  let returns = null
  let current = null
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const m = line.match(/^@(\w+)\s*([\s\S]*)$/)
    if (m) {
      current = { tag: m[1], rest: m[2].trim(), lines: [] }
      tags.push(current)
      if (m[1] === 'param') {
        params.push({ name: paramTagName(m[2]), raw: m[2], lines: [] })
        current = params[params.length - 1]
      }
      if (m[1] === 'returns' || m[1] === 'return') returns = current
      continue
    }
    if (current) current.lines.push(line)
    else summary.push(line)
  }
  const summaryText = summary.join('\n').trim()
  const returnsText = returns ? [returns.rest, ...returns.lines].join(' ').trim() : null
  return {
    summary: summaryText,
    params,
    returns: returnsText,
    tags: tags.map((t) => t.tag),
    // @param 只有标签没有描述 —— 等于没写
    emptyParams: params.filter((p) => [p.raw, ...p.lines].join(' ').replace(/^[^ ]*/, '').trim() === '').map((p) => p.name),
  }
}

/** `@param {Type} name - 说明` / `@param name 说明` / `@param {..} [name=default] - 说明`。 */
function paramTagName(rest) {
  let t = rest.trim()
  if (t.startsWith('{')) {
    const close = t.indexOf('}')
    if (close === -1) return ''
    t = t.slice(close + 1).trim()
  }
  const m = t.match(/^(\.\.\.)?(\[)?([A-Za-z_$][\w$]*)?/)
  if (!m || m[3] === undefined) return ''
  return m[3]
}

const CJK = /[一-鿿]/

/**
 * 疑似复述的启发式。只在「描述很短 + 以动作动词开头 + 去掉动词后与标识符同源」时报警。
 * 阈值刻意保守：宁可漏报（作者自己看得出来），也不要把好注释判成复述。
 */
const RESTATE_VERBS = ['获取', '设置', '返回', '创建', '生成', '得到', '读取', '写入', '删除', '检查', '处理', '执行', '计算', '计算', '解析', '计算']
function looksRestated(name, summary) {
  if (summary === '') return false
  const firstLine = summary.split('\n')[0].replace(/[`*_]/g, '').trim()
  if (firstLine === '') return false
  // 去掉中文动作动词后的宾语
  let rest = firstLine
  for (const v of RESTATE_VERBS) {
    if (rest.startsWith(v)) {
      rest = rest.slice(v.length)
      break
    }
  }
  rest = rest.replace(/^(一个|一份|一组|一条|新的|对应的)/, '')
  if (rest === '') return false
  // 标识符按 camelCase 拆词；中文描述里逐词对上就认为在复述名字
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
  if (words.length === 0) return false
  if (rest.length > 24) return false
  const pinyinish = rest.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (pinyinish !== '' && words.some((w) => w === pinyinish)) return true
  // 描述就是「动词 + 标识符的中文原样」——用「描述里出现标识符的完整小写形式」近似
  if (pinyinish === name.toLowerCase()) return true
  return false
}

// ============================================================
// 声明扫描
// ============================================================

const DECL_PATTERNS = [
  { kind: 'function', re: /(?:^|[\s;}])(?:export\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g },
  { kind: 'class', re: /(?:^|[\s;}])(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'interface', re: /(?:^|[\s;}])(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'type', re: /(?:^|[\s;}])(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)\s*(?:<[^=<>]*>)?\s*=/g },
  { kind: 'const', re: /(?:^|[\s;}])(?:export\s+)?(?:declare\s+)?const\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'let', re: /(?:^|[\s;}])(?:export\s+)?(?:declare\s+)?let\s+([A-Za-z_$][\w$]*)/g },
  { kind: 'var', re: /(?:^|[\s;}])(?:export\s+)?(?:declare\s+)?var\s+([A-Za-z_$][\w$]*)/g },
]

/** 取声明名之后的第一个 `(`，跳过一次泛型参数表。 */
function findParamsOpen(masked, afterName) {
  let i = afterName
  while (i < masked.length && /\s/.test(masked[i])) i += 1
  if (masked[i] === '<') {
    const close = matchBracket(masked, i, true)
    if (close === -1) return -1
    i = close + 1
    while (i < masked.length && /\s/.test(masked[i])) i += 1
  }
  return masked[i] === '(' ? i : -1
}

/** 箭头函数：形参表在 `=>` 之前。单个不括号的形参也要认。 */
function arrowParams(masked, declEnd) {
  const arrow = masked.indexOf('=>', declEnd)
  if (arrow === -1) return null
  // 箭头前不该有分号或语句结束符，否则那是别的表达式里的箭头
  const between = masked.slice(declEnd, arrow)
  if (/[;}]/.test(between)) return null
  const paren = masked.lastIndexOf('(', arrow)
  if (paren !== -1 && paren >= declEnd && between.slice(between.lastIndexOf('(')).includes(')')) {
    const close = matchBracket(masked, paren)
    if (close === -1 || close > arrow) return null
    return { open: paren, close }
  }
  const ident = between.match(/([A-Za-z_$][\w$]*)\s*$/)
  if (ident) return { text: ident[1] }
  return null
}

function scanDeclarations(file) {
  const src = readFileSync(file, 'utf8')
  const masked = mask(src)
  // 导出语句的模块说明符是字符串，全遮罩会把 `from './x.js'` 一起吃掉。
  // 所以导出扫描用「只去注释」的那一份视图 —— 语句形状不会因为字符串而变。
  const codeOnly = mask(src, false)
  const decls = new Map()
  for (const { kind, re } of DECL_PATTERNS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(masked)) !== null) {
      const name = m[1]
      const pos = m.index + m[0].length - name.length
      if (decls.has(name)) continue
      // JSDoc 挂在**声明起点**（export / declare / async 那几个关键字之前），
      // 不是挂在名字之前 —— 从名字往回只跨空白会停在 `interface` 上，
      // 后果是有注释的符号全被报成缺注释（整个检查退化成恒红）。
      const declStart = m.index + m[0].search(/[A-Za-z_$]/)
      const decl = { name, kind, file, src, masked, pos, declStart, params: null, returnsVoid: false }
      if (kind === 'function') {
        const open = findParamsOpen(masked, pos + name.length)
        if (open !== -1) {
          const close = matchBracket(masked, open)
          if (close !== -1) {
            decl.params = splitTop(masked, open + 1, close).flatMap(paramNames)
            const after = masked.slice(close + 1, close + 120)
            if (/^\s*:\s*void\b/.test(after)) decl.returnsVoid = true
          }
        }
      } else if (kind === 'const' || kind === 'let' || kind === 'var') {
        const eq = masked.indexOf('=', pos + name.length)
        const arrow = eq === -1 ? null : arrowParams(masked, eq)
        if (arrow) {
          if (arrow.text !== undefined) decl.params = paramNames(arrow.text)
          else decl.params = splitTop(masked, arrow.open + 1, arrow.close).flatMap(paramNames)
          const tail = masked.slice(arrow.close + 1, arrow.close + 160)
          if (/=>\s*:\s*void\b/.test(tail) || /=>\s*\{\s*\}/.test(tail)) decl.returnsVoid = true
        }
      }
      decls.set(name, decl)
    }
  }
  return { src, masked, codeOnly, decls }
}

// ============================================================
// index.ts 导出解析
// ============================================================

const cache = new Map()
function loadFile(file) {
  if (!cache.has(file)) cache.set(file, scanDeclarations(file))
  return cache.get(file)
}

const RE_EXPORT_ALL = /(?:^|\n)\s*export\s+\*\s+(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]([^'"]+)['"]/g
const RE_EXPORT_LIST = /(?:^|\n)\s*export\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/g
const RE_LOCAL_LIST = /(?:^|\n)\s*export\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:;|$)/g
const RE_EXPORT_DECL = /(?:^|\n)\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|class|interface|type|let|var)\s+([A-Za-z_$][\w$]*)/g

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  // 源里写的是 ESM 的 .js 说明符（NodeNext 要求），落盘是 .ts —— 不换后缀
  // 会把「包之间互相再导出」整个判成找不到定义，表现是绝大多数符号根本没进检查。
  const bare = spec.replace(/\.js$/, '')
  const base = join(dirname(fromFile), bare)
  if (existsSync(`${base}.ts`)) return `${base}.ts`
  if (existsSync(join(base, 'index.ts'))) return join(base, 'index.ts')
  return null
}

/** 收集一个文件对外暴露的名字 → 定义所在文件。跟随 `export *` 与具名再导出。 */
function collectExports(file, seen = new Set()) {
  if (seen.has(file) || !existsSync(file)) return []
  seen.add(file)
  const { codeOnly, decls } = loadFile(file)
  const out = []

  RE_EXPORT_DECL.lastIndex = 0
  let m
  while ((m = RE_EXPORT_DECL.exec(codeOnly)) !== null) {
    if (decls.has(m[1])) out.push({ name: m[1], file })
  }

  RE_EXPORT_LIST.lastIndex = 0
  while ((m = RE_EXPORT_LIST.exec(codeOnly)) !== null) {
    const target = resolveSpecifier(file, m[2])
    if (!target) continue
    for (const piece of m[1].split(',')) {
      const t = piece.trim()
      if (t === '') continue
      const parts = t.replace(/^type\s+/, '').split(/\s+as\s+/)
      const local = parts[0].trim()
      const exported = (parts[1] ?? parts[0]).trim()
      out.push({ name: exported, want: local, file: target })
    }
  }

  // 先把匹配收齐再递归：RE_* 是模块级 /g 正则，递归进入子文件会把它自己的
  // lastIndex 清零，循环中途被重置就会静默截断 —— 表现为「某个包一个符号都没查到」。
  RE_EXPORT_ALL.lastIndex = 0
  const starTargets = []
  while ((m = RE_EXPORT_ALL.exec(codeOnly)) !== null) {
    const target = resolveSpecifier(file, m[1])
    if (target) starTargets.push(target)
  }
  for (const target of starTargets) {
    for (const e of collectExports(target, seen)) out.push(e)
  }

  return out
}

/** 把 { name, want, file } 落到真实声明上；同包内再翻一层（barrel → impl）。 */
function locate(entry, depth = 0) {
  const { decls } = loadFile(entry.file)
  const key = entry.want ?? entry.name
  if (decls.has(key)) return decls.get(key)
  if (depth > 2) return null
  for (const e of collectExports(entry.file, new Set([entry.file]))) {
    if (e.name !== key) continue
    const hit = locate({ ...e, want: e.want ?? e.name }, depth + 1)
    if (hit) return hit
  }
  return null
}

// ============================================================
// 校验
// ============================================================

/** interface / type 字面量的成员。type 别名只在对象字面量形态下才要求成员说明。 */
function membersOf(decl) {
  const { masked, pos, kind } = decl
  const braceOf = kind === 'interface'
    ? (() => {
        let i = pos
        while (i < masked.length && masked[i] !== '{') {
          if (masked[i] === '\n' && masked.slice(i, i + 3).includes('extends')) break
          i += 1
        }
        return masked[i] === '{' ? i : -1
      })()
    : (() => {
        let i = masked.indexOf('=', pos)
        if (i === -1) return -1
        let j = i + 1
        while (j < masked.length && /\s/.test(masked[j])) j += 1
        while (j < masked.length && ['|', '&'].includes(masked[j])) {
          j += 1
          while (j < masked.length && /[\s|&]/.test(masked[j])) j += 1
        }
        return masked[j] === '{' ? j : -1
      })()
  if (braceOf === -1) return []
  const close = matchBracket(masked, braceOf)
  if (close === -1) return []
  const members = []
  for (const part of splitTop(masked, braceOf + 1, close)) {
    const nm = part.match(/^([A-Za-z_$][\w$]*|'[^']*'|"[^"]*"|\[[^\]]+\])\s*[?]?\s*[:(]/)
    if (!nm) continue
    const name = nm[1].replace(/^['"]|['"]$/g, '')
    // 方法：签名以 `(` 开头且带 `:` 返回值 —— 字段也可能是函数类型，所以看 `=>` 或 `(` 后跟 `)` / `:`
    const isMethod = part.includes('=>') || /^\w+\??\s*\(/.test(part)
    members.push({ name, isMethod })
  }
  return members
}

const findings = []
const restated = []
let checked = 0

function add(decl, symbol, problem) {
  findings.push({
    file: relative(root, decl.file).replace(/\\/g, '/'),
    line: lineOf(decl.src, decl.pos),
    symbol,
    problem,
  })
}

function checkDecl(decl, exportedName) {
  checked += 1
  const label = exportedName
  const doc = docBefore(decl.src, decl.declStart)
  if (!doc) {
    add(decl, label, '缺 JSDoc 块')
    return
  }
  const parsed = parseDoc(doc.text)
  if (parsed.summary === '') {
    add(decl, label, 'JSDoc 无描述')
  } else if (!CJK.test(parsed.summary)) {
    add(decl, label, '描述非中文')
  } else if (looksRestated(exportedName, parsed.summary)) {
    restated.push({ file: relative(root, decl.file).replace(/\\/g, '/'), line: lineOf(decl.src, decl.pos), symbol: label, summary: parsed.summary.split('\n')[0] })
  }

  const isFn = decl.kind === 'function' || decl.params !== null
  if (isFn) {
    for (const name of decl.params ?? []) {
      if (parsed.params.every((p) => p.name !== name)) {
        add(decl, label, `形参 ${name} 没有 @param`)
      }
    }
    // @param 多余：按顶层名比对。解构字段写作 `opts.path` 时以根名 opts 计，
    // 否则按解构出的字段逐个对会被判成「多了参数」—— 那是判据写错，不是注释写错。
    const declared = new Set(parsed.params.map((p) => p.name).filter((x) => x !== ''))
    for (const name of declared) {
      if (decl.params?.includes(name)) continue
      if (decl.params?.some((p) => parsed.params.some((q) => q.name === `${p}.${name}` || q.name.startsWith(`${p}.`)))) continue
      add(decl, label, `@param ${name} 不是实际形参`)
    }
    for (const name of parsed.emptyParams) {
      add(decl, label, `@param ${name} 缺说明`)
    }
    if (parsed.returns === null && !decl.returnsVoid) {
      add(decl, label, '缺 @returns')
    }
    if (parsed.returns !== null && decl.returnsVoid) {
      restated.push({ file: relative(root, decl.file).replace(/\\/g, '/'), line: lineOf(decl.src, decl.pos), symbol: label, summary: '返回 void 的函数不必写 @returns，可删掉' })
    }
  }

  if (decl.kind === 'interface' || decl.kind === 'type') {
    for (const m of membersOf(decl)) {
      if (m.isMethod) continue // 方法按成员描述要求，不强制 @param
      const memberDoc = memberDocBefore(decl, m.name)
      if (memberDoc === null) add(decl, `${label}.${m.name}`, '成员缺 JSDoc')
      else if (memberDoc === '') add(decl, `${label}.${m.name}`, '成员 JSDoc 无描述')
      else if (!CJK.test(memberDoc)) add(decl, `${label}.${m.name}`, '成员描述非中文')
    }
  }
}

/** 找 interface 成员自己的 JSDoc。返回 null=没有块，''=空描述。 */
function memberDocBefore(decl, memberName) {
  const { masked, src, kind } = decl
  const braceOf = kind === 'interface'
    ? masked.indexOf('{', decl.pos)
    : (() => {
        let j = masked.indexOf('=', decl.pos) + 1
        while (j < masked.length && /[\s|&]/.test(masked[j])) j += 1
        return j
      })()
  if (braceOf === -1) return null
  const close = matchBracket(masked, braceOf)
  if (close === -1) return null
  const re = new RegExp(`(?:^|[\\s;}])(readonly\\s+)?\\??\\s*${memberName}\\s*[?:]`, 'g')
  const body = masked.slice(braceOf + 1, close)
  const m = re.exec(body)
  if (!m) return null
  const abs = braceOf + 1 + m.index + m[0].length - memberName.length
  const doc = docBefore(src, abs)
  if (!doc) return null
  const parsed = parseDoc(doc.text)
  if (parsed.summary === '') return ''
  return CJK.test(parsed.summary) ? parsed.summary : ''
}

// ============================================================
// 主流程
// ============================================================

const packageDirs = existsSync(packagesDir)
  ? readdirSync(packagesDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  : []

for (const pkg of packageDirs) {
  const index = join(packagesDir, pkg, 'src', 'index.ts')
  if (!existsSync(index)) continue
  const exported = collectExports(index)
  const done = new Set()
  for (const entry of exported) {
    if (done.has(entry.name)) continue
    done.add(entry.name)
    const decl = locate(entry)
    if (!decl) {
      findings.push({ file: relative(root, entry.file).replace(/\\/g, '/'), line: 1, symbol: entry.name, problem: '导出找不到定义' })
      continue
    }
    checkDecl(decl, entry.name)
  }
}

findings.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
restated.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({
    checked,
    missing: findings.length,
    restated: restated.length,
    findings,
    restatedHints: restated,
  }, null, 2))
} else {
  for (const f of findings) console.log(`${f.file}:${f.line} ${f.symbol} —— ${f.problem}`)
  for (const r of restated) console.log(`${r.file}:${r.line} ${r.symbol} —— 疑似复述（不判失败）：${r.summary}`)
  console.log(`\n检查 ${checked} 个公共 API 符号：缺 JSDoc ${findings.length} 处 / 疑似复述 ${restated.length} 处`)
}

if (findings.length > 0) process.exitCode = 1
