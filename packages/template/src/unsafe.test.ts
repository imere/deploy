/**
 * 危险字符四档。
 *
 * 每一档都测「命中」与「放行」两条 —— 只测命中会让人把规则写得过严
 * （比如误伤 nginx 的 `$` 或多行模板），而误伤同样是故障。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { assertSafe } from './unsafe.js'
import { renderString } from './render.js'
import type { RenderContext, Usage } from './context.js'

function rejects(value: string, usage: Usage): DpError {
  try {
    assertSafe(value, usage, 'projects.web.target.root')
    throw new Error(`期望 ${usage} 拒绝 ${JSON.stringify(value)}，实际放行`)
  } catch (err) {
    assert.ok(err instanceof DpError)
    assert.equal(err.code, 'DP.TPL.UNSAFE_VALUE')
    assert.ok((err.hint ?? '') !== '', '错误必须带 hint')
    return err
  }
}

function allows(value: string, usage: Usage): void {
  assert.doesNotThrow(() => assertSafe(value, usage))
}

describe('assertSafe · text 档（默认）', () => {
  it('拒绝 NUL 与控制字符', () => {
    const err = rejects('a\u0000b', 'text')
    assert.match(err.message, /\\u0000/)
    // 被拒字符必须是转义形式，不能把原始控制字符塞进 message
    assert.equal(err.message.includes('\u0000'), false)
    assert.equal(err.message.includes('普通文本字段'), true)
  })

  it('放行换行与制表符（模板自身就是多行的）', () => {
    allows('line1\nline2\r\n\tindented', 'text')
  })

  it('拒绝其他控制字符，如 ESC', () => {
    assert.match(rejects('a\u001bb', 'text').message, /\\u001b/)
  })
})

describe('assertSafe · path 档', () => {
  it('拒绝换行 —— 一个值变成两行，参数与指令的边界就没了', () => {
    const err = rejects('/srv/web\nrm -rf /', 'path')
    assert.match(err.message, /<LF>/)
  })

  it('拒绝 \\r', () => {
    rejects('/srv/web\r', 'path')
  })

  it('拒绝路径里的非法字符（复用 core 的判定，不重写正则）', () => {
    const err = rejects('/srv/we*b', 'path')
    assert.match(err.message, /路径不允许的字符/)
    assert.match(err.message, /\*|\\u002a/i)
  })

  it('拒绝 Windows 保留名', () => {
    const err = rejects('C:/srv/NUL', 'path')
    assert.equal(err.code, 'DP.TPL.UNSAFE_VALUE')
  })

  it('放行正常路径与制表符', () => {
    allows('/srv/web/releases/20240102-0315', 'path')
    allows('/srv/web/current', 'path')
  })

  it('放行 Windows 盘符路径 —— 盘符的 `:` 不是"非法字符"', () => {
    // core 的 win32 判定把 `:` 列为非法，因为它校验的是相对源路径条目；
    // 这里的 value 是完整路径，Windows 目标机上必然带盘符。不摘前缀就
    // 等于宣布 path 档不支持 Windows 目标机 —— 与分档初衷相反。
    allows('C:/srv/web/current', 'path')
    allows('D:\\srv\\web\\current', 'path')
  })

  it('放行 UNC 路径', () => {
    allows('\\\\srv\\share\\web\\current', 'path')
  })

  it('盘符摘掉后其余规则照旧 —— 保留名与非法字符仍被拒', () => {
    rejects('C:/srv/NUL', 'path')
    rejects('C:/srv/we*b', 'path')
    rejects('C:/srv/we\nb', 'path')
  })
})

describe('assertSafe · shell 档', () => {
  it('拒绝换行', () => {
    rejects('web\n--config /etc/passwd', 'shell')
  })

  it('拒绝控制字符', () => {
    rejects('we\u0000b', 'shell')
  })

  it('放行分号 —— 它在合法路径里可能出现，且本仓从不拼 shell 字符串', () => {
    // Runner 只有 exec(argv[])，分号没有任何解释机会；为它报错只会是误伤
    allows('/srv/web;backup', 'shell')
    allows('a;rm -rf /', 'shell')
  })
})

describe('assertSafe · conf 档', () => {
  it('拒绝换行', () => {
    rejects('server {\n', 'conf')
  })

  it('放行 nginx / yaml 的正常标点与空格', () => {
    allows('server { listen 80; root /srv/web/current; }', 'conf')
    allows('services: { web: { image: "api:1" } }', 'conf')
  })
})

describe('renderString · usage 生效', () => {
  const ctx: RenderContext = {
    project: 'web',
    env: 'prod',
    envVars: { KEY: 'v' },
    release: { current: '/srv/web/current' },
  }

  it('变量里的控制字符按 usage 判定，而不是模板整体', () => {
    // 多行模板本身合法：conf 就是多行的，换行不该让整份模板被拒
    const tpl = 'server {\n  root ${release.current};\n}\n'
    assert.equal(renderString(tpl, ctx, { usage: 'text' }), 'server {\n  root /srv/web/current;\n}\n')
  })

  it('注入进来的换行在 path 档被拒，即使模板本身多行', () => {
    const ctx2: RenderContext = { ...ctx, envVars: { DIR: '/srv\nweb' } }
    assert.throws(
      () => renderString('root ${env.DIR};', ctx2, { usage: 'path' }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.TPL.UNSAFE_VALUE',
    )
  })

  it('默认 usage 为 text', () => {
    assert.equal(renderString('a\tb\nc', ctx), 'a\tb\nc')
  })
})
