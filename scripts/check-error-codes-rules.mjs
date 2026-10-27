/**
 * 错误码硬编码门禁的判据 —— `DP.*` 码只许引用 `@dp/ports` 的 `ERR` / `WARN`，不许写字面量。
 *
 * 为什么要单独一道门禁：码的字面量散在各包里，改一个码要同步几十处，漏一处就是
 * 「报的是 A、断言的是 B」这种查不动的现场。把「引用常量」做成构建期的红色，
 * 比靠人 grep 可靠 —— 而人 grep 靠不住这件事，这一轮已经用 795 处替换量证明过了。
 */

/** 一块 `export const X = { ... } as const` 登记表在源码里的区间。 */
export function registryBlock(src, name) {
  const start = src.indexOf(`export const ${name} = {`)
  if (start < 0) return null
  const end = src.indexOf('\n} as const', start)
  if (end < 0) return null
  return [start, end + '\n} as const'.length]
}

/**
 * 登记表里的全部码。
 *
 * @param {string} portsSrc `packages/ports/src/index.ts` 的内容
 * @returns {Set<string>} ERR 与 WARN 两块表里的码
 */
export function registryCodes(portsSrc) {
  const out = new Set()
  for (const name of ['ERR', 'WARN']) {
    const range = registryBlock(portsSrc, name)
    if (range === null) continue
    for (const m of portsSrc.slice(range[0], range[1]).matchAll(/'(DP\.[A-Z0-9_.]+)'/g)) {
      out.add(m[1])
    }
  }
  return out
}

/** 登记表自身那几块 —— 里面的字面量是**定义**，不是引用 */
export function definitionRanges(portsSrc) {
  return ['ERR', 'WARN'].map((n) => registryBlock(portsSrc, n)).filter((r) => r !== null)
}

/**
 * 一段源码里以字面量形式出现的 `DP.*` 码。
 *
 * 只认「像完整码」的形状：三段（`DP.IO.ENOENT`）或两段且已登记的
 * （`DP.INTERACTIVE_PROMPT_DETECTED`）。`startsWith('DP.TPL')` 这类前缀判断
 * 不是码 —— 但既然它写了个前缀，正确的写法同样是从常量取，见门禁输出。
 *
 * @param {string} src 源码文本
 * @param {[number, number][]} skip 跳过的字符区间（登记表自身）
 * @returns {{ line: number, code: string }[]} 每处字面量的行号与码
 */
/**
 * 剥掉一行里的注释，并告诉调用方这行结束时是否仍在块注释里。
 *
 * 只按行首判断会漏两种：`/* ... *\/` 折行时中间那些行不一定以 `*` 开头，
 * 以及行尾的 `// ...`。前者会把注释里提到的码当成实现里的引用。
 *
 * @param {string} line 一行源码
 * @param {boolean} inBlock 进入本行时是否已处在块注释中
 * @returns {{ code: string, inBlock: boolean }} 去掉注释后的代码与本行结束时的状态
 */
export function stripComments(line, inBlock) {
  let out = ''
  let block = inBlock
  let i = 0
  while (i < line.length) {
    if (block) {
      const end = line.indexOf('*/', i)
      if (end === -1) return { code: out, inBlock: true }
      block = false
      i = end + 2
      continue
    }
    if (line.startsWith('//', i)) break
    if (line.startsWith('/*', i)) {
      const end = line.indexOf('*/', i + 2)
      if (end === -1) return { code: out, inBlock: true }
      i = end + 2
      continue
    }
    out += line[i]
    i += 1
  }
  return { code: out, inBlock: block }
}

export function codeLiterals(src, skip = []) {
  const out = []
  const lines = src.split('\n')
  let offset = 0
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const from = offset
    offset += line.length + 1
    const stripped = stripComments(line, inBlock)
    inBlock = stripped.inBlock
    const skipped = skip.some(([s, e]) => from >= s && from < e)
    if (skipped) continue
    const code = stripped.code
    for (const m of code.matchAll(/(?:'|"|`)(DP\.[A-Z][A-Z0-9_.]*)(?:'|"|`)/g)) {
      out.push({ line: i + 1, code: m[1], prefix: false })
    }
    // 族前缀判断（`startsWith('DP.TPL')`）同样算硬编：族也能从常量取
    //（`Object.values(ERR.TPL)`），写成字符串之后改族名就没人提醒
    for (const m of code.matchAll(
      /\.\s*(?:startsWith|includes|endsWith)\(\s*(?:'|"|`)(DP\.[A-Z][A-Z0-9_]*\.[A-Z0-9_]*)(?:'|"|`)/g,
    )) {
      out.push({ line: i + 1, code: m[1], prefix: true })
    }
  }
  return out
}

/**
 * `docs/failures.md` 故障分类表里登记过的码。
 *
 * 表里还有**设计期预留**的族与码（`DP.DISK.*`、`DP.GUARD.*`）：它们当前没被任何包
 * 抛出，但作为分类骨架允许存在（`packages/ports` 有一条断言看着「只许减少」）。
 * 所以出现在 `KNOWN_ORPHANS` 这类清单里的预留码不算硬编 —— 它们本来就没有常量可引。
 *
 * @param {string} doc docs/failures.md 的内容
 * @returns {Set<string>} 表里第一列提到过的码
 */
export function codesInDoc(doc) {
  const out = new Set()
  const lines = doc.split('\n')
  const start = lines.findIndex((l) => l.startsWith('#') && l.includes('故障分类表'))
  if (start < 0) return out
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').startsWith('#')) {
      end = i
      break
    }
  }
  for (const m of lines.slice(start, end).join('\n').matchAll(/^\|\s*([^|]+)\|/gm)) {
    for (const t of (m[1] ?? '').matchAll(/`([^`]+)`/g)) out.add((t[1] ?? '').trim())
  }
  return out
}

/**
 * 一段源码里**既没登记也没进文档**的码字面量 —— 这是彻头彻尾的野码：
 * 用户按它去查处置办法会一无所获，而它连「设计期预留」的身份都没有。
 *
 * @param {string} src 源码文本
 * @param {Set<string>} registry 登记表里的码
 * @param {[number, number][]} skip 跳过的字符区间
 * @param {Set<string>} documented 文档里登记过的码（含预留族）
 * @returns {{ line: number, code: string }[]} 违规处
 */
export function unregisteredCodeHits(src, registry, skip = [], documented = new Set()) {
  return codeLiterals(src, skip).filter((h) => {
    // 族前缀：族也能从常量取，所以一律算硬编
    if (h.prefix) return true
    // 只在文档里（预留码）→ 没有常量可引，不算硬编
    if (documented.has(h.code) && !registry.has(h.code)) return false
    // 登记表里有常量却还写字面量 —— 这正是要挡的
    if (registry.has(h.code)) return true
    // 两段且没登记的（`DP.TPL` 之类）是前缀用法，不是码 —— 不在这里判
    return h.code.split('.').length >= 3
  })
}

/**
 * 一行人类可读的违规说明。
 *
 * @param {{ file: string, line: number, code: string }} v 一条违规
 * @returns {string} 一行说明
 */
export function formatCodeViolation(v) {
  if (v.prefix === true) {
    return `${v.file}:${v.line} —— 族前缀 ${v.code}：族也要从常量取（Object.values(ERR.<族>).some((c) => c === code)），写死前缀改族名时没人提醒`
  }
  return `${v.file}:${v.line} —— 字面量 ${v.code}：码只许引用 @dp/ports 的 ERR / WARN，未登记的码先登记进登记表`
}
