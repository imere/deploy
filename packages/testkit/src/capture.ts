import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'

/** 期望的具体错误类。收窄到 DpError 家族：调用点要么拿到 DpError，要么当场炸 */
type ErrorClass = new (...args: never[]) => DpError

/**
 * 同步捕异常并交还成 DpError。
 *
 * 不给 `kind` 时必须真的抛出 DpError：静默吞掉「抛了别的东西」等于把错误类型与处理分支的
 * 对应关系从测试里删掉。给 `kind` 时校验的是具体子类 —— 实现改成抛别的类型（退出码跟着变），
 * 测试必须当场红。没有异常时抛「期望抛错，但没有」：一个不抛的用例本身就是错误路径的漏测。
 *
 * @param fn 预期抛错的调用
 * @param kind 期望的具体错误类；省略时只要求是 DpError
 * @returns 捕获到的错误（.code / .message / .cause 链可直接断言）
 */
export function caught(fn: () => unknown, kind?: ErrorClass): DpError {
  try {
    fn()
  } catch (err) {
    if (kind !== undefined) {
      assert.ok(err instanceof kind, `期望抛 ${kind.name}，实际是 ${(err as Error)?.name}: ${String(err)}`)
      return err as DpError
    }
    if (err instanceof DpError) return err
    throw new Error(`期望 DpError，实际是 ${String(err)}`, { cause: err })
  }
  throw new Error('期望抛错，但没有')
}

/**
 * 异步捕 reject 并交还成 DpError。语义与 {@link caught} 一致，差别只在 await。
 *
 * @param p 预期 reject 的 Promise
 * @param kind 期望的具体错误类；省略时只要求是 DpError
 * @returns 捕获到的错误（.code / .message / .cause 链可直接断言）
 */
export async function caughtAsync(p: Promise<unknown>, kind?: ErrorClass): Promise<DpError> {
  try {
    await p
  } catch (err) {
    if (kind !== undefined) {
      assert.ok(err instanceof kind, `期望 reject ${kind.name}，实际是 ${(err as Error)?.name}: ${String(err)}`)
      return err as DpError
    }
    if (err instanceof DpError) return err
    throw new Error(`期望 DpError，实际是 ${String(err)}`, { cause: err })
  }
  throw new Error('期望 reject，但没有')
}
