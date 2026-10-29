import { collectCalls, isTestEntryCall, testCallbackOf } from '../ast.mjs'

const METHODS = new Set(['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual'])

/** 压掉全部空白 —— 旧判据的归一化方式：逐字符比较不受排版影响。 */
const squash = (s) => s.replace(/\s+/g, '')

/** 左右两边有一边含调用就不算恒等：`f(x) === f(x)` 在纯函数下也恒等，但那是要比的量。 */
const hasCall = (s) => /[\w$)\]]\s*\(/.test(s)

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'assert.equal/deepEqual 等断言的两个实参是同一份表达式的拷贝时判错 —— 永不失败的断言与没有断言等价，但它绿着，留下「已验证过」的错觉',
    },
    schema: [],
    messages: {
      tautology: '两个实参是同一表达式的拷贝，永不失败 —— 想比的是哪两个量，就各算一次',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode
    return {
      CallExpression(call) {
        if (!isTestEntryCall(call)) return
        const callback = testCallbackOf(call)
        if (!callback) return
        const visitorKeys = sourceCode.visitorKeys
        for (const assertCall of collectCalls(callback, visitorKeys)) {
          const callee = assertCall.callee
          if (
            callee?.type !== 'MemberExpression' ||
            callee.object?.type !== 'Identifier' ||
            callee.object.name !== 'assert' ||
            callee.property?.type !== 'Identifier' ||
            !METHODS.has(callee.property.name)
          ) {
            continue
          }
          const args = assertCall.arguments
          if (args.length < 2) continue
          const lhs = sourceCode.getText(args[0])
          const rhs = sourceCode.getText(args[1])
          const squashed = squash(lhs)
          if (squashed === '' || squashed !== squash(rhs)) continue
          if (hasCall(lhs)) continue
          context.report({ node: assertCall, messageId: 'tautology' })
        }
      },
    }
  },
}
