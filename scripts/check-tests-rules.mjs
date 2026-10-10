/** 恒等断言识别：输入两个实参的源码文本，输出是不是恒等。不读文件、不扫目录。 */
const squash = (s) => s.replace(/\s+/g, '')

const hasCall = (s) => /[\w$)\]]\s*\(/.test(s)

/**
 * 两个实参是不是「永不失败的相等断言」。
 *
 * 三条边界都是踩出来的，改任何一条都会立刻产生误报或漏报：
 * - 归一化只抹空白：抹字面量会把「结构相同、值不同」判成恒等
 * - 含调用的实参不算恒等：`assert.equal(fmt(r), fmt(r))` 验的就是两次求值一致，
 *   算成恒等会驱动人去改一条本来就对的测试
 * - 空串不算：避免把「没解析出来」当成「解析出相等了」
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
