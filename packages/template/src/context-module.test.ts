/**
 * `context.ts` 只有类型没有行为，但产物 `build/context.js` 仍要出现在覆盖率记录里。
 *
 * 为什么需要这个文件：`tsc` 把它编译成 `export {}`，盘上确实有这个产物；
 * 而门禁把「盘上有产物、lcov 里没记录」判未达标 —— 理由是没有任何测试碰到它。
 * 一个纯类型模块被别处 `import type` 引用时会被整体擦除，于是这个产物永远加载不到，
 * 缺口是「测试没加载」而不是「代码没测到」。这里显式加载一次把它钉进记录。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

describe('context 模块', () => {
  it('纯类型模块能被真的加载，且不导出任何运行时值', async () => {
    // 动态 import 而不是 `import './context.js'`：静态的副作用导入能被 bundler 与
    // 编译器当成无用导入擦掉，而这里要的恰恰是「它被加载过」这件事本身
    const url = pathToFileURL(resolve(import.meta.dirname, 'context.js')).href
    const mod: Record<string, unknown> = await import(url)
    assert.equal(typeof mod, 'object')
    // 类型在运行时不留痕：没有值导出就是没有值导出
    assert.deepEqual(Object.keys(mod), [])
  })
})
