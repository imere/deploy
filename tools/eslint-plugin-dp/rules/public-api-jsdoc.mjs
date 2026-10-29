import { walk, attachedJsdoc } from '../ast.mjs'
import { publicApiFor } from '../public-scope.mjs'
import { relative, sep } from 'node:path'

const CJK = /[一-鿿]/

/** 取出 JSDoc 块的首段描述：第一个 @tag 之前的全部文本。 */
function summaryOf(blockText) {
  const lines = []
  for (const raw of blockText.split('\n')) {
    const line = raw.replace(/^\s*\* ?/, '').replace(/\s+$/, '')
    if (line.startsWith('@')) break
    lines.push(line)
  }
  return lines.join('\n').trim()
}

/** 一行形参文本绑定的名字（解构展开成键，取对象模式的键而非别名）。 */
function flatNames(node, out = []) {
  if (!node) return out
  switch (node.type) {
    case 'Identifier':
      out.push(node.name)
      break
    case 'AssignmentPattern':
      flatNames(node.left, out)
      break
    case 'RestElement':
      flatNames(node.argument, out)
      break
    case 'ObjectPattern':
      for (const prop of node.properties) {
        if (prop.type === 'RestElement') flatNames(prop.argument, out)
        else flatNames(prop.key ?? prop.argument, out)
      }
      break
    case 'ArrayPattern':
      for (const el of node.elements) flatNames(el, out)
      break
    default:
      break
  }
  return out
}

/** 实际形参名（顶层形参；解构展开）。 */
function paramNamesOf(fnNode) {
  const names = []
  for (const p of fnNode.params ?? []) flatNames(p, names)
  return names
}

/**
 * 文档里的 @param 名：剥掉 {类型}、[可选]、...剩余 与默认值，取首段标识符。
 * `@param options.force …` 记作 options —— 子字段说明算根形参的文档，与被替代的门禁一致。
 */
function paramTagName(rest) {
  let t = rest.trim()
  if (t.startsWith('{')) {
    const close = t.indexOf('}')
    if (close === -1) return ''
    t = t.slice(close + 1).trim()
  }
  const m = /^(?:\.\.\.)?(?:\[)?([A-Za-z_$][\w$]*)/.exec(t)
  return m?.[1] ?? ''
}

/** 解析 JSDoc 块：首段描述 + @param 名列表 + 是否有 @returns。 */
function parseDocBlock(blockText) {
    const params = []
    let returns = null
    let current = null
    const summaryLines = []
    for (const raw of blockText.split('\n')) {
      const line = raw.replace(/^\s*\* ?/, '').replace(/\s+$/, '')
      const tag = /^@(\w+)\s*([\s\S]*)$/.exec(line)
      if (tag) {
        if (tag[1] === 'param') {
          current = { name: paramTagName(tag[2]), rest: tag[2] }
          params.push(current)
        } else if (tag[1] === 'returns' || tag[1] === 'return') {
          current = { name: null, rest: tag[2], isReturns: true }
          returns = current
        } else {
          current = null
        }
        continue
      }
      if (current) current.rest += `\n${line}`
      else summaryLines.push(line)
    }
    return {
      summary: summaryLines.join('\n').trim(),
      params,
      returns: returns === null ? null : returns.rest.trim(),
    }
  }

/** 声明节点的函数体（函数声明本身，或 const 声明的箭头 / 函数表达式初始化）。 */
function functionOf(node) {
  if (node.type === 'FunctionDeclaration') return node
  if (node.type === 'VariableDeclarator') {
    const init = node.init
    if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) return init
  }
  return null
}

/** 函数是否返回 void：显式 `: void` 注解，或体内没有任何带值的 return。 */
function returnsVoid(fnNode, visitorKeys) {
  const ann = fnNode.returnType?.typeAnnotation
  if (ann && (ann.type === 'TSVoidKeyword' || (ann.type === 'TSTypeReference' && ann.typeName?.name === 'void'))) {
    return true
  }
  if (fnNode.body?.type !== 'BlockStatement') return false
  let hasValueReturn = false
  walk(fnNode.body, (n) => {
    if (n.type === 'ReturnStatement' && n.argument !== null && n.argument !== undefined) hasValueReturn = true
  }, visitorKeys)
  return !hasValueReturn
}

const DOC_FORMS = [
  'FunctionDeclaration',
  'VariableDeclarator',
  'ClassDeclaration',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
]

export default {
  meta: {
    type: 'problem',
    docs: {
      description: '公共 API 符号必须有带中文描述的 JSDoc：形参逐个有 @param（子字段说明算根形参的文档）、非 void 函数有 @returns、导出的 interface / type 字面量的数据成员逐个有中文说明',
    },
    schema: [
      {
        type: 'object',
        properties: {
          // 旧门禁的 barrel 追踪有缺陷（同名首见即跳过、文件只展开一次、遮罩误伤），
          // 一批公共符号从来没被检查过。补齐文档后从清单摘除 —— 只许缩小。
          exempt: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
          },
          // 条目两种形态：'Symbol' 豁免整个符号，'Symbol.member' 只豁免它的一个
          // 数据成员（成员缺文档但符号其余成员合规时用，避免整符号连坐豁免）。
        },
        additionalProperties: false,
      },
    ],
    messages: {
      missingDoc: '缺 JSDoc 块',
      emptyDoc: 'JSDoc 无描述',
      notChinese: '描述非中文',
      missingParam: '形参 {{name}} 没有 @param',
      extraParam: '@param {{name}} 不是实际形参',
      emptyParam: '@param {{name}} 缺说明',
      missingReturns: '缺 @returns',
      memberMissingDoc: '成员 {{name}} 缺 JSDoc',
      memberEmptyDoc: '成员 {{name}} JSDoc 无描述',
      memberNotChinese: '成员 {{name}} 描述非中文',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    const visitorKeys = sourceCode.visitorKeys
    const isPublic = publicApiFor(context)
    const filePath = relative(process.cwd(), context.filename).split(sep).join('/')
    const exempt = new Set(context.options?.[0]?.exempt?.[filePath] ?? [])
    const checkMembers = (typeNode, members, name) => {
      for (const member of members) {
        if (member.type === 'TSMethodSignature') continue
        // readonly 成员不判 —— 与被替代的门禁同一口径：它的成员名判据吃不下
        // 修饰符前缀，readonly 成员从来没被检查过；新判据先不加码。
        if (member.readonly) continue
        const memberName =
          member.key?.type === 'Identifier'
            ? member.key.name
            : sourceCode.getText(member.key ?? member).replace(/^['"]|['"]$/g, '')
        const block = attachedJsdoc(sourceCode, member)
        if (!block) {
          if (!exempt.has(`${name}.${memberName}`)) {
            context.report({ node: member, messageId: 'memberMissingDoc', data: { name: memberName } })
          }
          continue
        }
        const summary = summaryOf(block.value)
        if (summary === '') {
          if (!exempt.has(`${name}.${memberName}`)) {
            context.report({ node: member, messageId: 'memberEmptyDoc', data: { name: memberName } })
          }
        } else if (!CJK.test(summary) && !exempt.has(`${name}.${memberName}`)) {
          context.report({ node: member, messageId: 'memberNotChinese', data: { name: memberName } })
        }
      }
    }
    return {
      'Program:exit'(program) {
        walk(program, (n) => {
          const parent = n.parent
          const exported =
            DOC_FORMS.includes(n.type) && parent?.type === 'ExportNamedDeclaration'
          const declaratorExported =
            n.type === 'VariableDeclarator' &&
            parent?.type === 'VariableDeclaration' &&
            parent.parent?.type === 'ExportNamedDeclaration'
          if (!exported && !declaratorExported) return
          const name = n.id?.type === 'Identifier' ? n.id.name : null
          if (name === null || !isPublic(name) || exempt.has(name)) return

          const block = attachedJsdoc(sourceCode, n)
          if (!block) {
            context.report({ node: n, messageId: 'missingDoc' })
            return
          }
          const parsed = parseDocBlock(block.value)
          if (parsed.summary === '') {
            context.report({ node: n, messageId: 'emptyDoc' })
          } else if (!CJK.test(parsed.summary)) {
            context.report({ node: n, messageId: 'notChinese' })
          }

          const fn = functionOf(n)
          if (fn) {
            const actual = paramNamesOf(fn)
            const documented = new Set(parsed.params.map((p) => p.name).filter((x) => x !== ''))
            for (const p of actual) {
              if (!documented.has(p)) {
                context.report({ node: fn, messageId: 'missingParam', data: { name: p } })
              }
            }
            for (const tag of parsed.params) {
              if (tag.name === '') {
                context.report({ node: fn, messageId: 'emptyParam', data: { name: tag.rest.slice(0, 20) } })
                continue
              }
              if (!actual.includes(tag.name)) {
                context.report({ node: fn, messageId: 'extraParam', data: { name: tag.name } })
              }
              // @param 只有标签没有说明 —— 等于没写
              const desc = tag.rest.replace(/^\s*(?:\.\.\.)?(?:\[)?[A-Za-z_$][\w$]*(?:\])?(?:\s*=\s*[^\s\]]+)?/, '').trim()
              if (desc === '') {
                context.report({ node: fn, messageId: 'emptyParam', data: { name: tag.name } })
              }
            }
            if (parsed.returns === null && !returnsVoid(fn, visitorKeys)) {
              context.report({ node: fn, messageId: 'missingReturns' })
            }
          }

          if (n.type === 'TSInterfaceDeclaration') {
            checkMembers(n, n.body?.body ?? [], name)
          } else if (n.type === 'TSTypeAliasDeclaration' && n.typeAnnotation?.type === 'TSTypeLiteral') {
            checkMembers(n, n.typeAnnotation.members ?? [], name)
          }
        }, visitorKeys)
      },
    }
  },
}
