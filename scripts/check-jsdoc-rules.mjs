/**
 * JSDoc 门禁的纯文本判定层：源码遮罩、括号配平、形参切分、注释块定位、块解析、复述启发式。
 *
 * 单独成模块是为了让它能被 `node --test` 直接断言。门禁脚本自己的判据一旦没有回归测试，
 * 判据被改坏（放宽到抓不住、或误伤合法写法）不会有任何东西变红 —— 而它恰恰是
 * 「谁来验验证者」的那条链。这套判据有七个已经踩过的解析 bug，每一个报出来的结论都说得过去、
 * 判定却是错的，所以每条边界都有对应用例钉住。
 *
 * 分层：只碰字符串，不碰文件系统（`resolveSpecifier` 的存在性检查由调用方注入）。
 * 读文件、列目录、报告拼装都留在门禁入口那边。
 */
import { dirname, join } from 'node:path'

// ============================================================
// 源码遮罩：把注释与字符串内容换成等长空格（保留换行）
// ============================================================

const PREV_SIGNIFICANT = /[([{,;:=!&|?+\-*/%~^<>]|\breturn|\btypeof|\bcase|\bdo|\bin|\bof|\bnew|\bdelete|\bvoid/

/**
 * 从 open 处的引号起把整段字面量遮罩掉，返回结束后的下标。
 *
 * 模板串必须穿透 `${}`：插值里是代码，里面还能再套引号与模板串。不穿透的后果实测过一次 ——
 * 一个拼接 shell 引号的模板里出现了同种反引号，模板被判成提前结束，从那一行往后几十行
 * 代码全被当成字符串吃掉，那批导出在门禁眼里根本不存在（报「导出找不到定义」）。
 * 这是漏报，比误报难发现得多：脚本只是安静地看不见它们。
 *
 * 已知局限：插值里的块注释不单独处理（那种写法极罕见），按普通字符遮罩。
 */
export function maskString(src, open, out) {
  const quote = src[open]
  // 空栈 = 在字符串里；栈顶 'code' = 在 `${}` 插值里，按代码规则扫
  const stack = []
  let braceDepth = 0
  let i = open
  out[i] = ' '
  i += 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') {
      out[i] = ' '
      if (src[i + 1] !== '\n') out[i + 1] = ' '
      i += 2
      continue
    }
    if (stack.length === 0) {
      if (c === quote) {
        out[i] = ' '
        return i + 1
      }
      if (quote === '`' && c === '$' && src[i + 1] === '{') {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
        stack.push('code')
        braceDepth = 1
        continue
      }
      if (c !== '\n') out[i] = ' '
      i += 1
      continue
    }
    if (c === '{') braceDepth += 1
    else if (c === '}') {
      braceDepth -= 1
      if (braceDepth === 0) {
        out[i] = ' '
        stack.pop()
        i += 1
        continue
      }
    } else if (c === "'" || c === '"' || c === '`') {
      i = maskString(src, i, out)
      continue
    } else if (src.slice(i, i + 2) === '//') {
      while (i < src.length && src[i] !== '\n') {
        out[i] = ' '
        i += 1
      }
      continue
    }
    if (c !== '\n') out[i] = ' '
    i += 1
  }
  return i
}

/**
 * 与 src 等长的字符串：注释与字符串内部被空格替换，换行保留。
 * 这样后续所有正则都只在**真实代码**上匹配，注释里的函数声明不会再被当成声明。
 *
 * stringsToo 为假时只去注释 —— 导出扫描要用这一份视图：语句形状不会因为字符串而变，
 * 但模块说明符（`from './x.js'`）本身是字符串，全遮罩会把再导出语句一起吃掉。
 */
export function mask(src, stringsToo = true) {
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
      i = maskString(src, i, out)
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
export function matchBracket(masked, open, angle = false) {
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
export function splitTop(masked, start, end) {
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
export function paramNames(text) {
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

export function lineOf(src, index) {
  let line = 1
  for (let i = 0; i < index && i < src.length; i += 1) if (src[i] === '\n') line += 1
  return line
}

/**
 * 取出紧邻 `pos` 之前、允许中间有空白与 `export` 关键字的 JSDoc 块。
 *
 * 块起点不能取「`pos` 之前最后一个块起始标记」：注释正文里写 glob 或 Markdown 代码块时
 * 常出现同样的字面量（下面用「起始标记」「结束标记」指代这两个三字符序列），
 * 那会把块截在字面量处，后面的 `@param` 被静默丢掉。
 * 可靠的判据是——块起点必然位于**上一个结束标记之后**；在那之后取第一个起始标记，
 * 块内再多的字面量也骗不过去。块结束同理不靠搜索：`pos` 前那个结束标记就是它。
 *
 * 顺带一条给后来人：本文件自己的注释里也别写那两个字面量，否则注释提前闭合，
 * 报错信息会指向下一行，看起来像那里出了问题（作者踩过一次）。
 */
export function docBefore(src, pos) {
  let i = pos - 1
  while (i >= 0 && /\s/.test(src[i])) i -= 1
  if (i < 1 || src[i] !== '/' || src[i - 1] !== '*') return null
  if (i >= 2 && src[i - 2] === '*' && src[i - 3] !== '/') return null // 空块不算
  const prevEnd = src.lastIndexOf('*/', i - 2)
  const open = src.indexOf('/**', prevEnd === -1 ? 0 : prevEnd + 2)
  if (open === -1 || open > i - 3) return null
  return { open, text: src.slice(open + 3, i - 1) }
}

/** 把 JSDoc 块拆成 { summary, params: [{ name, rest }], returns, tags }。 */
export function parseDoc(block) {
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
export function paramTagName(rest) {
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

export const CJK = /[一-鿿]/

/**
 * 疑似复述的启发式。只在「描述很短 + 以动作动词开头 + 去掉动词后与标识符同源」时报警。
 * 阈值刻意保守：宁可漏报（作者自己看得出来），也不要把好注释判成复述。
 */
const RESTATE_VERBS = ['获取', '设置', '返回', '创建', '生成', '得到', '读取', '写入', '删除', '检查', '处理', '执行', '计算', '计算', '解析', '计算']
export function looksRestated(name, summary) {
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
export function findParamsOpen(masked, afterName) {
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
export function arrowParams(masked, declEnd) {
  const arrow = masked.indexOf('=>', declEnd)
  if (arrow === -1) return null
  // 等号与箭头之间只能是形参：`(...)` 或单个标识符（前面可挂 `async` 与泛型）。
  // 不能只看等号右边第一个字符 —— 字符串已被遮罩成空格，看过去看到的是字符串**后面**
  // 的内容，常量照样能蒙混过关。实测：`const HINT = '...'` 后面跟一个带箭头的函数时，
  // 中间那截骨架长得像 `exportfunctionsummarize...(stderr:string){...`，
  // 于是门禁要求一个字符串常量写 `@param` 与 `@returns`。
  const body = masked
    .slice(declEnd + 1, arrow)
    .replace(/\s+/g, '')
    .replace(/^async/, '')
    .replace(/^<[^<>]*>/, '')
  if (body === '') return null
  const isIdent = /^[A-Za-z_$][\w$]*$/.test(body)
  const isParen = body.startsWith('(') && body.endsWith(')')
  if (!isIdent && !isParen) return null
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

/**
 * 从源码文本扫出声明表：名字 → { kind, src, masked, pos, declStart, params, returnsVoid }。
 * `file` 只是报告用的标签，不参与任何判定（判定全部只看文本）。
 */
export function scanDeclarations(src, file = '') {
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

/**
 * 把模块说明符解析成本仓的源文件路径。`exists` 由调用方注入 —— 本模块不碰文件系统。
 *
 * workspace 包名（`from '@dp/ports'`）也要能解析：只认相对说明符的话，
 * 跨包再导出整条链会断在这里，表现为那些符号**根本没进检查**（漏报，且很安静）。
 * 源里写的是 ESM 的 .js 说明符（NodeNext 要求），落盘是 .ts —— 不换后缀
 * 会把「包之间互相再导出」整个判成找不到定义，表现是绝大多数符号根本没进检查。
 */
export function resolveSpecifier(fromFile, spec, exists) {
  if (!spec.startsWith('.')) {
    const m = /^(.*[/\\])packages[/\\]/.exec(fromFile.replace(/\\/g, '/'))
    if (m && spec.startsWith('@dp/')) {
      const name = spec.slice('@dp/'.length).replace(/\.js$/, '')
      const p = join(m[1], 'packages', name, 'src', 'index.ts')
      if (exists(p)) return p
    }
    return null
  }
  const bare = spec.replace(/\.js$/, '')
  const base = join(dirname(fromFile), bare)
  if (exists(`${base}.ts`)) return `${base}.ts`
  if (exists(join(base, 'index.ts'))) return join(base, 'index.ts')
  return null
}

// ============================================================
// 校验判定
// ============================================================

/** interface / type 字面量的成员。type 别名只在对象字面量形态下才要求成员说明。 */
export function membersOf(decl) {
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

/** 找 interface 成员自己的 JSDoc。返回 null=没有块，''=空描述。 */
export function memberDocBefore(decl, memberName) {
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
  // 成员名的真实起点要直接找，不能用 `m[0].length - memberName.length` 反推：
  // 正则尾部的 `[?:]` 也算进了 `m[0]`，减出来的位置会偏进名字内部（实测落在 `type` 的 `y` 上），
  // 往回找注释必然落空 —— 表现为「成员缺 JSDoc」，而注释就在那一行的正上方。
  const nameAt = body.indexOf(memberName, m.index)
  if (nameAt === -1) return null
  const abs = braceOf + 1 + nameAt
  const doc = docBefore(src, abs)
  if (!doc) return null
  const parsed = parseDoc(doc.text)
  if (parsed.summary === '') return ''
  return CJK.test(parsed.summary) ? parsed.summary : ''
}

/**
 * @param 相关的三类缺口：实际形参没写、写了的不是实际形参、写了标签但没说明。
 * 返回顺序固定为「缺 → 多 → 空」，与报告里的输出顺序一致。
 *
 * 多余判定按顶层名比对。解构字段写作 `opts.path` 时以根名 opts 计，
 * 否则按解构出的字段逐个对会被判成「多了参数」—— 那是判据写错，不是注释写错。
 */
export function matchParamDocs(params, parsed) {
  const missing = []
  for (const name of params ?? []) {
    if (parsed.params.every((p) => p.name !== name)) missing.push(name)
  }
  const declared = new Set(parsed.params.map((p) => p.name).filter((x) => x !== ''))
  const extra = []
  for (const name of declared) {
    if (params?.includes(name)) continue
    if (params?.some((p) => parsed.params.some((q) => q.name === `${p}.${name}` || q.name.startsWith(`${p}.`)))) continue
    extra.push(name)
  }
  return { missing, extra, empty: parsed.emptyParams }
}

/** interface / type 的成员逐个判：缺块、空描述、非中文。方法成员不强制说明。 */
export function checkMembers(decl, label) {
  const out = []
  if (decl.kind !== 'interface' && decl.kind !== 'type') return out
  for (const m of membersOf(decl)) {
    if (m.isMethod) continue // 方法按成员描述要求，不强制 @param
    const memberDoc = memberDocBefore(decl, m.name)
    if (memberDoc === null) out.push({ symbol: `${label}.${m.name}`, problem: '成员缺 JSDoc' })
    else if (memberDoc === '') out.push({ symbol: `${label}.${m.name}`, problem: '成员 JSDoc 无描述' })
    else if (!CJK.test(memberDoc)) out.push({ symbol: `${label}.${m.name}`, problem: '成员描述非中文' })
  }
  return out
}