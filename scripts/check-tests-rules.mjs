const squash = (s) => s.replace(/\s+/g, '')

const hasCall = (s) => /[\w$)\]]\s*\(/.test(s)

/**
 * 两个实参是不是「永不失败的相等断言」。
 *
 * @param {string} lhs 第一个实参的源码文本
 * @param {string} rhs 第二个实参的源码文本
 * @returns {boolean} 两边是否同一份纯表达式（归一化后逐字符相同且不含调用）
 */
export function isTautology(lhs, rhs) {
  const a = squash(lhs)
  if (a === '') return false
  if (a !== squash(rhs)) return false
  return !hasCall(lhs)
}
