import { collectCalls, isTestEntryCall, testCallbackOf } from '../ast.mjs'

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'assert.throws / assert.rejects 只给一个实参时判错 —— 那只验证「抛了东西」，错误类型 / 码 / 消息一条都没验，实现抛别的错测试照样绿',
    },
    schema: [],
    messages: {
      missingExpected: 'assert.{{method}}(fn) 没有第二个参数：错误类型/码/消息一条都没验（实现抛别的错测试照样绿）',
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
            callee.property?.type !== 'Identifier'
          ) {
            continue
          }
          const method = callee.property.name
          if (method !== 'throws' && method !== 'rejects') continue
          if (assertCall.arguments.length < 2) {
            context.report({ node: assertCall, messageId: 'missingExpected', data: { method } })
          }
        }
      },
    }
  },
}
