/**
 * 变量渲染：成功路径、错误路径、以及最容易出事的 `$`。
 *
 * 特别关注「$ 后不是 {」这条 —— nginx conf 的正确性直接依赖它，
 * 而它的失败模式是「产出一份能过语法检查、行为全错的 conf」，
 * 静态检查发现不了，只能在这里钉住。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { renderString } from './render.js'
import type { RenderContext } from './context.js'

const ctx: RenderContext = {
  project: 'web',
  env: 'prod',
  envVars: { DEPLOY_KEY: 'abc123', EMPTY_IS_REJECTED: '' },
  git: { sha: 'deadbeef', branch: 'main', tag: 'v1.2.3' },
  release: { id: '20240102-0315', current: '/srv/web/current' },
  now: new Date('2024-01-02T03:15:00.000Z'),
}

function codeOf(fn: () => unknown): { code: string; hint: string | undefined } {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof DpError, `期望 DpError，实际 ${String(err)}`)
    assert.ok((err.hint ?? '') !== '', '错误必须带 hint，否则用户不知道该改什么')
    return { code: err.code, hint: err.hint }
  }
  throw new Error('期望抛错，但没有')
}

describe('renderString · 变量渲染', () => {
  it('渲染全部内置变量', () => {
    assert.equal(
      renderString('${project} ${env} ${git.sha} ${git.branch} ${git.tag} ${release.id} ${release.current}', ctx),
      'web prod deadbeef main v1.2.3 20240102-0315 /srv/web/current',
    )
  })

  it('区分 ${env}（环境名）与 ${env.NAME}（环境变量）', () => {
    assert.equal(renderString('${env}', ctx), 'prod')
    assert.equal(renderString('${env.DEPLOY_KEY}', ctx), 'abc123')
  })

  it('${now} 用注入的时钟，输出 ISO 8601', () => {
    assert.equal(renderString('${now}', ctx), '2024-01-02T03:15:00.000Z')
  })

  it('extra 变量可用，优先级低于内置变量', () => {
    const withExtra: RenderContext = { ...ctx, extra: { image: 'registry.local/api', project: 'shadow' } }
    assert.equal(renderString('${image}', withExtra), 'registry.local/api')
    // 内置优先：extra 里的 project 不该盖掉上下文里的
    assert.equal(renderString('${project}', withExtra), 'web')
  })

  it('不含变量的输入逐字原样返回', () => {
    const input = 'server { listen 80; root /srv/web/public; }'
    assert.equal(renderString(input, ctx), input)
  })

  it('注入 ctx.now 后两次渲染字节级一致', () => {
    const a = renderString('built=${now} sha=${git.sha}', ctx)
    const b = renderString('built=${now} sha=${git.sha}', ctx)
    assert.equal(a, b)
  })
})

describe('renderString · $ 之后不是 {', () => {
  it('nginx 自己的变量原样保留', () => {
    const conf = 'server_name $host; proxy_pass http://$request_uri; set $x "${project}-ok";'
    assert.equal(renderString(conf, ctx), 'server_name $host; proxy_pass http://$request_uri; set $x "web-ok";')
  })

  it('行尾与独立的 $ 也保留', () => {
    assert.equal(renderString('cost is $5 and $ alone', ctx), 'cost is $5 and $ alone')
  })
})

describe('renderString · 转义', () => {
  it('$${x} → 字面量 ${x}', () => {
    assert.equal(renderString('$${project}', ctx), '${project}')
  })

  it('$$ → $', () => {
    assert.equal(renderString('$$$$', ctx), '$$')
  })

  it('转义的引用既不渲染也不报错', () => {
    // env.NOT_SET 并不存在，但转义后不该触发 MISSING_ENV
    assert.equal(renderString('$${env.NOT_SET}', ctx), '${env.NOT_SET}')
  })

  it('转义不闭合也不报错，按字面量处理', () => {
    assert.equal(renderString('$${unclosed', ctx), '${unclosed')
  })
})

describe('renderString · 错误路径（每条都断言 code 与 hint）', () => {
  it('未知变量 → DP.TPL.UNKNOWN_VAR，hint 列出全部可用变量', () => {
    const { code, hint } = codeOf(() => renderString('${nope}', ctx))
    assert.equal(code, 'DP.TPL.UNKNOWN_VAR')
    assert.match(hint ?? '', /env\.NAME/)
    assert.match(hint ?? '', /release\.current/)
  })

  it('缺环境变量 → DP.TPL.MISSING_ENV，不渲染成空串', () => {
    const { code, hint } = codeOf(() => renderString('${env.NOT_SET}', ctx))
    assert.equal(code, 'DP.TPL.MISSING_ENV')
    assert.match(hint ?? '', /NOT_SET/)
  })

  it('空值环境变量同样被拒', () => {
    assert.equal(codeOf(() => renderString('${env.EMPTY_IS_REJECTED}', ctx)).code, 'DP.TPL.MISSING_ENV')
  })

  it('git.tag 为空 → DP.TPL.MISSING_VALUE，hint 指向 git.sha', () => {
    const { code, hint } = codeOf(() => renderString('${git.tag}', { ...ctx, git: { sha: 'abc' } }))
    assert.equal(code, 'DP.TPL.MISSING_VALUE')
    assert.match(hint ?? '', /git\.sha/)
  })

  it('未闭合 → DP.TPL.SYNTAX，message 给出位置', () => {
    // 真正没有 `}` 的情况：位置片段里会出现 ⟦ 标记，让用户能直接看到断在哪
    const { code, hint } = codeOf(() => renderString('root ${release.current', ctx))
    assert.equal(code, 'DP.TPL.SYNTAX')
    assert.match(hint ?? '', /\$\$\{/)
    try {
      renderString('root ${release.current', ctx)
      assert.fail('应当抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.match(err.message, /⟦/)
    }
  })

  it('变量名里混入非法字符 → DP.TPL.SYNTAX', () => {
    const { code, hint } = codeOf(() => renderString('root ${release.current;};', ctx))
    assert.equal(code, 'DP.TPL.SYNTAX')
    assert.match(hint ?? '', /变量名/)
  })

  it('嵌套 → DP.TPL.SYNTAX，hint 说明不支持嵌套', () => {
    const { code, hint } = codeOf(() => renderString('${env.${x}}', ctx))
    assert.equal(code, 'DP.TPL.SYNTAX')
    assert.match(hint ?? '', /嵌套/)
  })

  it('变量名非法 → DP.TPL.SYNTAX', () => {
    assert.equal(codeOf(() => renderString('${1bad}', ctx)).code, 'DP.TPL.SYNTAX')
  })

  it('出错时不留下 ${x} 原文（绝不产出语法合法语义错的 conf）', () => {
    let out = ''
    try {
      out = renderString('root ${nope};', ctx)
    } catch {
      // 抛错正是预期路径：要验的是「出错时不留下 ${x} 原文」，所以 out 保持空串
    }
    assert.equal(out.includes('${'), false)
  })

  it('options.path 被带进错误，便于定位配置项', () => {
    try {
      renderString('${nope}', ctx, { path: 'projects.web.target.confd' })
      assert.fail('应当抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.path, 'projects.web.target.confd')
    }
  })
})
