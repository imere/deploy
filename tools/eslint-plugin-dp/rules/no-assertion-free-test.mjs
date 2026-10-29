import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parser } from 'typescript-eslint'

import { walk, collectCalls, isTestEntryCall, testCallbackOf, callName } from '../ast.mjs'

/**
 * 一个函数体是否真的做断言：含 `assert.*` 调用，或 `throw new Error(...)`。
 *
 * 与被替代的扫描器同一口径 —— 普通的 `throw err` 不算（那是错误路径，不是断言）。
 */
function bodyAsserts(fnNode, visitorKeys) {
  let found = false
  walk(fnNode, (n) => {
    if (
      n.type === 'ThrowStatement' &&
      n.argument?.type === 'NewExpression' &&
      n.argument.callee?.type === 'Identifier' &&
      n.argument.callee.name === 'Error'
    ) {
      found = true
    }
    if (
      n.type === 'CallExpression' &&
      n.callee?.type === 'MemberExpression' &&
      n.callee.object?.type === 'Identifier' &&
      n.callee.object.name === 'assert'
    ) {
      found = true
    }
  }, visitorKeys)
  return found
}

/**
 * 收集一个 AST 里的函数名 → 函数节点：函数声明与「const X = 箭头/函数表达式」。
 * 类方法与对象字面量里的方法不收 —— 被替代的扫描器的文本判据也只认这两种形状。
 */
function collectFnNodes(ast, visitorKeys) {
  const fns = new Map()
  walk(ast, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id?.name && n.body) fns.set(n.id.name, n)
    if (n.type === 'VariableDeclarator' && n.id?.type === 'Identifier') {
      const init = n.init
      if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
        fns.set(n.id.name, init)
      }
    }
  }, visitorKeys)
  return fns
}

/** 形参表里「写了形参但函数体从没引用」的位置；`_` 前缀 = 作者明说不用。 */
function droppedParams(fnNode, visitorKeys) {
  const out = []
  ;(fnNode.params ?? []).forEach((param, index) => {
    let name = null
    if (param.type === 'Identifier') name = param.name
    else if (param.type === 'AssignmentPattern' && param.left?.type === 'Identifier') name = param.left.name
    else if (param.type === 'RestElement' && param.argument?.type === 'Identifier') name = param.argument.name
    if (name === null || name.startsWith('_')) return
    let referenced = false
    walk(fnNode.body, (n) => {
      if (n.type === 'Identifier' && n.name === name) referenced = true
    }, visitorKeys)
    if (!referenced) out.push({ index, param: name })
  })
  return out
}

function parseFile(filePath) {
  const code = readFileSyncSafe(filePath)
  if (code === null) return null
  try {
    return parser.parseForESLint(code, {
      filePath,
      ecmaVersion: 'latest',
      sourceType: 'module',
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    })
  } catch {
    return null
  }
}

function readFileSyncSafe(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * 全仓 helper 扫描，按 packages 根目录做模块级缓存：同一次 ESLint 进程里
 * 文件内容不变，扫一次就够；RuleTester 的夹具在别的目录，自然分开缓存。
 */
const cache = new Map()

function helperIndexFor(packagesRoot) {
  if (cache.has(packagesRoot)) return cache.get(packagesRoot)
  const asserting = new Set()
  const dropping = new Map()

  const scanFile = (filePath) => {
    const parsed = parseFile(filePath)
    if (!parsed) return
    const keys = parsed.visitorKeys
    for (const [name, fn] of collectFnNodes(parsed.ast, keys)) {
      if (bodyAsserts(fn, keys)) asserting.add(name)
      if (/throw|reject/i.test(name)) {
        const dropped = droppedParams(fn, keys)
        if (dropped.length > 0) dropping.set(name, dropped)
      }
    }
  }

  const scanDir = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) scanDir(p)
      else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) scanFile(p)
    }
  }
  scanDir(packagesRoot)

  const index = { asserting, dropping }
  cache.set(packagesRoot, index)
  return index
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: '用例体里既没有 assert 调用、也没有真做断言的 helper 调用时判错 —— 实现改成永远不抛，这用例照样绿；另拦下「throw/reject helper 的形参被丢弃、调用方却传了值」的假断言',
    },
    schema: [],
    messages: {
      noAssertion:
        '用例体里没有任何 assert（含有断言的 helper 调用）—— 实现改成永远不抛，这用例照样绿',
      droppedParam:
        'helper {{name}} 的形参 {{param}} 从未被引用，但这里传了值 —— 这处「断言错误类型」实际只验证了「抛了某些东西」',
    },
  },
  create(context) {
    const filePath = context.filename
    const parts = filePath.split(/[\\/]packages[\\/]/)
    if (parts.length < 2) return {}
    const packagesRoot = parts[0] + '/packages'
    const sourceCode = context.sourceCode
    const visitorKeys = sourceCode.visitorKeys

    // 本文件就地定义的 helper（测试文件里的 runCli 之类）与全仓扫描结果合并判定
    const asserting = new Set(helperIndexFor(packagesRoot).asserting)
    const dropping = new Map(helperIndexFor(packagesRoot).dropping)
    for (const [name, fn] of collectFnNodes(sourceCode.ast, visitorKeys)) {
      if (bodyAsserts(fn, visitorKeys)) asserting.add(name)
      if (/throw|reject/i.test(name)) {
        const dropped = droppedParams(fn, visitorKeys)
        if (dropped.length > 0) dropping.set(name, dropped)
      }
    }

    return {
      CallExpression(call) {
        if (!isTestEntryCall(call)) return
        const callback = testCallbackOf(call)
        if (!callback) return
        const calls = collectCalls(callback, visitorKeys)
        let sawAssert = false
        for (const c of calls) {
          const callee = c.callee
          if (
            callee?.type === 'MemberExpression' &&
            callee.object?.type === 'Identifier' &&
            callee.object.name === 'assert'
          ) {
            sawAssert = true
            continue
          }
          const name = callName(c)
          if (name !== null && asserting.has(name)) sawAssert = true
          if (name !== null && dropping.has(name)) {
            for (const { index: idx, param } of dropping.get(name)) {
              if (c.arguments.length > idx) {
                context.report({ node: c, messageId: 'droppedParam', data: { name, param } })
              }
            }
          }
        }
        if (!sawAssert) {
          context.report({ node: call, messageId: 'noAssertion' })
        }
      },
    }
  },
}
