import { walk, attachedJsdoc } from '../ast.mjs'
import { publicApiFor } from '../public-scope.mjs'

/** 中文描述判定：摘要里至少要有一个 CJK 字符。与被替代的门禁同一区间。 */
const CJK = /[一-鿿]/

/** 以动作动词开头 + 去掉动词后与标识符同源 = 在复述名字。 */
const RESTATE_VERBS = ['获取', '设置', '返回', '创建', '生成', '得到', '读取', '写入', '删除', '检查', '处理', '执行', '计算', '解析']

/**
 * 复述启发式，判据逐条对齐被替代的门禁：只在「描述很短 + 以动作动词开头 +
 * 去掉动词后与标识符同源」时报警。
 *
 * @param {string} name 标识符名
 * @param {string} summary JSDoc 首段描述
 * @returns {boolean} 是否疑似复述
 */
export function looksRestated(name, summary) {
  if (summary === '') return false
  const firstLine = summary.split('\n')[0].replace(/[`*_]/g, '').trim()
  if (firstLine === '') return false
  let rest = firstLine
  for (const v of RESTATE_VERBS) {
    if (rest.startsWith(v)) {
      rest = rest.slice(v.length)
      break
    }
  }
  rest = rest.replace(/^(一个|一份|一组|一条|新的|对应的)/, '')
  if (rest === '') return false
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
  if (words.length === 0) return false
  if (rest.length > 24) return false
  const pinyinish = rest.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (pinyinish !== '' && words.some((w) => w === pinyinish)) return true
  if (pinyinish === name.toLowerCase()) return true
  return false
}

/** 被 require-jsdoc 认领的导出形态 —— 本规则的判定对象与它完全重合。 */
export const EXPORTED_CONTEXTS = [
  'ExportNamedDeclaration > FunctionDeclaration',
  'ExportNamedDeclaration > VariableDeclaration > VariableDeclarator',
  'ExportNamedDeclaration > ClassDeclaration',
  'ExportNamedDeclaration > TSInterfaceDeclaration',
  'ExportNamedDeclaration > TSTypeAliasDeclaration',
]

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

/** 导出名：declarator 的 id、函数 / 类 / 接口 / 别名的 id。 */
function exportedName(node) {
  if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') return node.id.name
  if (node.id?.type === 'Identifier') return node.id.name
  return null
}

export default {
  meta: {
    type: 'suggestion',
    docs: {
      description: 'JSDoc 摘要疑似在复述标识符名时给出提示 —— 只提示不判失败，人工决定要不要把「为什么」写进去',
    },
    schema: [],
    messages: {
      restated: '疑似复述（不判失败）：描述以动作动词开头、去掉动词后与名字同源 —— 把「为什么 / 不这么定会怎样」写进去，而不是把名字翻译一遍',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    const visitorKeys = sourceCode.visitorKeys
    const isPublic = publicApiFor(context)
    return {
      'Program:exit'(program) {
        walk(program, (n) => {
          const parent = n.parent
          const exported =
            (n.type === 'FunctionDeclaration' ||
              n.type === 'ClassDeclaration' ||
              n.type === 'TSInterfaceDeclaration' ||
              n.type === 'TSTypeAliasDeclaration') &&
            parent?.type === 'ExportNamedDeclaration'
          const declaratorExported =
            n.type === 'VariableDeclarator' &&
            parent?.type === 'VariableDeclaration' &&
            parent.parent?.type === 'ExportNamedDeclaration'
          if (!exported && !declaratorExported) return
          const name = exportedName(n)
          if (name === null || !isPublic(name)) return
          const block = attachedJsdoc(sourceCode, n)
          if (!block) return
          const summary = summaryOf(block.value)
          if (!CJK.test(summary)) return
          if (looksRestated(name, summary)) {
            context.report({ node: n, messageId: 'restated' })
          }
        }, visitorKeys)
      },
    }
  },
}
