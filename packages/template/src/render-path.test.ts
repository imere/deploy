/**
 * 模板渲染里**只有出错时**才走到的路径。
 *
 * 关注两条：
 *  1. 补 path 的那条：语法错本身带配置位置，而错误路径要补上调用方的配置项路径
 *     （`projects.web.target.confd`），否则用户拿到的是模板里的偏移量，
 *     还得自己回去数第几个 `${` 写错了
 *  2. 非 DpError 必须原样上抛：包一层 catch 把所有异常都当「变量错」，
 *     会把调用方的 TypeError 报成 `DP.TPL.MISSING_VALUE` —— 排查方向整个偏掉
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { renderString } from './render.js'
import { validateVars } from './vars.js'
import type { RenderContext } from './context.js'

const ctx: RenderContext = {
  project: 'web',
  env: 'prod',
  envVars: { DEPLOY_KEY: 'abc123' },
  git: { sha: 'deadbeef', branch: 'main' },
  release: { id: '20240102-0315', current: '/srv/web/current' },
  now: new Date('2024-01-02T03:15:00.000Z'),
}

describe('renderString · 语法错补配置路径', () => {
  it('给了 path 时，语法错被补上配置项路径而不是模板偏移量', () => {
    try {
      renderString('server { listen ${', ctx, { path: 'projects.web.target.confd' })
      assert.fail('应当抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.TPL.SYNTAX')
      assert.equal(err.path, 'projects.web.target.confd')
    }
  })

  it('没给 path 时保持原样：不凭空造一个路径', () => {
    try {
      renderString('${unclosed', ctx)
      assert.fail('应当抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.TPL.SYNTAX')
    }
  })

  it('补 path 后 code 与 message 都不变，只多一个定位', () => {
    const raw = (() => {
      try {
        renderString('${', ctx)
        assert.fail('应当抛错')
      } catch (err) {
        assert.ok(err instanceof DpError)
        return { code: err.code, message: err.message, hint: err.hint }
      }
    })()
    try {
      renderString('${', ctx, { path: 'projects.web.target.confd' })
      assert.fail('应当抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, raw.code)
      assert.equal(err.message, raw.message)
      assert.equal(err.hint, raw.hint)
    }
  })
})

describe('validateVars · 非 DpError 原样上抛', () => {
  it('ctx.now 不是 Date 时报的是 TypeError，不是 DP.TPL.MISSING_VALUE', () => {
    const badCtx = { ...ctx, now: 'not-a-date' } as unknown as RenderContext
    assert.throws(
      () => validateVars('x ${now}', badCtx),
      (err: unknown) => {
        assert.ok(!(err instanceof DpError), '调用方的类型错被误报成变量错，排查方向会偏掉')
        assert.ok(err instanceof TypeError)
        return true
      },
    )
  })

  it('DpError 仍然被收集成列表，不上抛', () => {
    const errors = validateVars('${env.NOT_SET} ${env.OTHER_MISSING}', ctx)
    assert.deepEqual(
      errors.map((e) => e.code),
      ['DP.TPL.MISSING_ENV', 'DP.TPL.MISSING_ENV'],
    )
  })
})
