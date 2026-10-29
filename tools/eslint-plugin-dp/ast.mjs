/** 在 AST 上做深度优先遍历的小工具；visitorKeys 来自当前 ESLint 实例，插件自带的键表不掺和。 */

/**
 * 深度优先遍历节点及其子节点。
 *
 * @param {object} node 起始节点（可空）
 * @param {(n: object) => void} visit 访问回调
 * @param {Record<string, string[]>} visitorKeys 节点类型的子键表
 */
export function walk(node, visit, visitorKeys) {
  if (!node || typeof node !== 'object') return
  visit(node)
  const keys = visitorKeys[node.type]
  if (!keys) return
  for (const key of keys) {
    const child = node[key]
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c && typeof c.type === 'string') walk(c, visit, visitorKeys)
      }
    } else if (child && typeof child.type === 'string') {
      walk(child, visit, visitorKeys)
    }
  }
}

/**
 * 收集节点内全部 CallExpression（含嵌套）。
 *
 * @param {object} node 起始节点
 * @param {Record<string, string[]>} visitorKeys 节点类型的子键表
 * @returns {object[]} 调用表达式列表
 */
export function collectCalls(node, visitorKeys) {
  const calls = []
  walk(node, (n) => {
    if (n.type === 'CallExpression') calls.push(n)
  }, visitorKeys)
  return calls
}

/**
 * 调用表达式的「名字」：标识符取自身，成员调用取属性名。判定依据与旧扫描器一致 ——
 * 方法调用也按裸名匹配 helper。
 *
 * @param {object} call CallExpression 节点
 * @returns {string | null} 名字；取不出来为 null
 */
export function callName(call) {
  const c = call.callee
  if (!c) return null
  if (c.type === 'Identifier') return c.name
  if (c.type === 'MemberExpression' && c.property?.type === 'Identifier') return c.property.name
  return null
}

/** node:test 的用例入口名。 */
export const TEST_ENTRY_NAMES = new Set(['test', 'it'])

/**
 * 取紧邻节点之前的 JSDoc 块（`/**` 开头的块注释）。
 *
 * 挂在 `export` 上的文档对声明节点要沿 export 链向上找 —— 文档写在 export 关键字之前。
 * 只认「最近的一条注释就是 JSDoc 块」的形状：中间隔着别的注释不算。
 *
 * @param {object} sourceCode ESLint SourceCode
 * @param {object} node 声明节点
 * @returns {object | null} JSDoc 块注释节点；没有则 null
 */
export function attachedJsdoc(sourceCode, node) {
  let anchor = node
  if (node.parent?.type === 'VariableDeclaration') anchor = node.parent
  if (anchor.parent?.type === 'ExportNamedDeclaration') anchor = anchor.parent
  const before = sourceCode.getCommentsBefore(anchor)
  const last = before[before.length - 1]
  if (last && last.type === 'Block' && last.value.startsWith('*')) return last
  return null
}

/**
 * 判断一个 CallExpression 是否是用例入口（test / it）。`test.skip` / `test.todo`
 * 不跑，也就不提供保障判定的对象；`test.only` 照常判定。
 *
 * @param {object} call CallExpression 节点
 * @returns {boolean} 是否用例入口
 */
export function isTestEntryCall(call) {
  const c = call.callee
  if (!c) return false
  if (c.type === 'Identifier') return TEST_ENTRY_NAMES.has(c.name)
  if (c.type === 'MemberExpression' && c.object?.type === 'Identifier' && TEST_ENTRY_NAMES.has(c.object.name)) {
    if (c.property?.type !== 'Identifier') return false
    return c.property.name === 'only'
  }
  return false
}

/**
 * 取用例入口的回调函数节点。
 *
 * @param {object} call 用例入口的 CallExpression
 * @returns {object | null} 箭头函数 / 函数表达式节点；取不出来为 null
 */
export function testCallbackOf(call) {
  for (const arg of call.arguments) {
    if (arg?.type === 'ArrowFunctionExpression' || arg?.type === 'FunctionExpression') return arg
  }
  return null
}
