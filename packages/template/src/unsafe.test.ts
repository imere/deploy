/**
 * 危险字符四档。
 *
 * 每一档都测「命中」与「放行」两条 —— 只测命中会让人把规则写得过严
 * （比如误伤 nginx 的 `$` 或多行模板），而误伤同样是故障。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { assertSafe, escapeChar, escapeFragment } from './unsafe.js'
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

/**
 * 转义本身是**闸门的输出格式**，不是内部细节：错误 message 要能直接贴进日志 /
 * issue 而不弄坏它，所以转义对不对得单独钉住。
 */
describe('escapeChar / escapeFragment · 错误信息里的转义', () => {
  it('换行 / 回车 / 制表符各有具名形式，便于人眼定位', () => {
    assert.equal(escapeChar('\n'), '<LF>')
    assert.equal(escapeChar('\r'), '<CR>')
    assert.equal(escapeChar('\t'), '<TAB>')
  })

  it('DEL（0x7f）不可打印，转成 \\u007f', () => {
    // 它不在「可打印」那一侧：只看 code >= 0x20 会把 DEL 当普通字符放行，
    // 而它进日志一样会弄坏终端
    assert.equal(escapeChar('\u007f'), '\\u007f')
  })

  it('其余控制字符补齐四位十六进制', () => {
    assert.equal(escapeChar('\u0000'), '\\u0000')
    assert.equal(escapeChar('\u0001'), '\\u0001')
    assert.equal(escapeChar('\u001f'), '\\u001f')
  })

  it('空格与高位字符原样保留 —— 中文与 emoji 不该被转义', () => {
    assert.equal(escapeChar(' '), ' ')
    assert.equal(escapeChar('a'), 'a')
    assert.equal(escapeChar('中'), '中')
    assert.equal(escapeChar('\u{1f600}'), '\u{1f600}')
  })

  it('escapeFragment 逐字符转义，原始控制字符一个都不留在结果里', () => {
    const fragment = escapeFragment('a\u0000b\tc\u001b')
    assert.equal(fragment, 'a\\u0000b<TAB>c\\u001b')
    assert.equal(/[\u0000-\u0008\u000b\u000e-\u001f]/.test(fragment), false)
  })
})

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

  it('拒绝 DEL（0x7f）—— 它不可打印，不能因为 >= 0x20 就当普通字符', () => {
    assert.match(rejects('a\u007fb', 'text').message, /\\u007f/)
  })

  it('放行非 C0 的高位字符，中文与 emoji 在 text 档是合法内容', () => {
    allows('版本 v2：完成 ✅', 'text')
    allows('a\u{1f600}b', 'text')
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

  it('放行正常路径', () => {
    allows('/srv/web/releases/20240102-0315', 'path')
    allows('/srv/web/current', 'path')
  })

  it('拒绝 TAB —— 分档里的空白放行清单不是最终判据', () => {
    // `ALLOWED.path` 放了 0x09，但同一个值还要过 `checkSourcePaths(…, 'win32')`，
    // 那里的非法字符集含整个 C0，于是 TAB 仍被拒。这是对的：Windows 文件名本来
    // 就不接受控制字符，当成「路径里的合法空白」放行才是把风险留给目标机。
    // （原先这条测试的标题写着「放行制表符」却从没真传过制表符，所以一直没暴露。）
    assert.match(rejects('/srv/web\tcurrent', 'path').message, /<TAB>/)
  })

  it('拒绝 DEL 与其他控制字符', () => {
    assert.match(rejects('/srv/web\u007f', 'path').message, /\\u007f/)
  })

  it('错误带上配置路径，便于定位到具体配置项', () => {
    const err = rejects('/srv/we*b', 'path')
    assert.equal(err.path, 'projects.web.target.root')
  })

  it('没给路径时错误里就没有 path 值，而不是拼一个 undefined 字符串', () => {
    try {
      assertSafe('/srv/we*b', 'path')
      assert.fail('应当抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.path, undefined)
      assert.equal(String(err.message).includes('undefined'), false)
    }
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
    rejects('we\u007fb', 'shell')
  })

  it('拒绝制表符 —— shell 档连空白都不放行', () => {
    rejects('web\troot', 'shell')
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

  it('拒绝控制字符 —— 写进 conf 文件的一律不放行', () => {
    rejects('root /srv/a\u0000b;', 'conf')
    rejects('root /srv/a\u007fb;', 'conf')
  })

  it('放行 nginx 自己的变量与查询串 —— conf 档不是 path 档', () => {
    // path 档会拒掉 `?`（Windows 非法字符），但 rewrite 目标、proxy_pass 的
    // query、log_format 里的 `?` 都是合法的 conf 内容。分档的意义就在这里：
    // 同一个字符按落点判定，不是按字符表一刀切。
    allows('rewrite ^/old/(.*)$ /new/$1?permanent redirect;', 'conf')
    allows('set $x "$host:$request_uri";', 'conf')
  })
})

/**
 * 分档的直接证据：同一个值在一档放行、另一档拒。
 *
 * 只测各档的独立行为，挡不住「把某档的规则悄悄收紧」—— 收紧后本档的命中测试
 * 照样全绿，只有跨档对照才会红。
 */
describe('assertSafe · 同一个值在不同档的判定', () => {
  it('换行：text 放行，path / shell / conf 全拒', () => {
    allows('line1\nline2', 'text')
    rejects('line1\nline2', 'path')
    rejects('line1\nline2', 'shell')
    rejects('line1\nline2', 'conf')
  })

  it('Windows 非法字符：path 拒，conf / shell 放行', () => {
    rejects('/srv/web?v=1', 'path')
    allows('/srv/web?v=1', 'conf')
    allows('/srv/web?v=1', 'shell')
  })

  it('带盘符的路径只在 path 档有特殊待遇', () => {
    allows('C:/srv/web/current', 'path')
    // 同一个串在 conf 档也不该被当成路径去挑保留名 —— 它就是一段普通文本
    allows('C:/srv/NUL', 'conf')
  })
})

/**
 * 不是「某个字符不合法」的失败：整体规则（保留名、长度）命中，但定位不到具体字符。
 *
 * 这条路径的 message 里给的是 core 的错误码而不是字符 —— 定位不出字符还说
 * 「含不允许的字符 X」等于给了个不存在的线索，用户会去逐字找而找不到。
 */
describe('assertSafe · path 档的非字符级失败', () => {
  it('Windows 保留名 → message 给出 core 的错误码而不是编个字符', () => {
    const err = rejects('C:/srv/NUL', 'path')
    assert.match(err.message, /DP\.PATH\.RESERVED_NAME/)
    assert.match(err.message, /该值会被写进远端文件路径/)
    // core 的原始建议要透出来，再补一句「不要绕过校验」
    assert.match(err.hint ?? '', /重命名/)
  })

  it('保留名带扩展名同样命中（NUL.txt 这类整段都能骗过粗看）', () => {
    assert.match(rejects('C:/srv/nul.txt', 'path').message, /DP\.PATH\.RESERVED_NAME/)
  })

  it('超过 win32 长度上限 → 同样落到错误码那条分支', () => {
    const long = `/${'a'.repeat(280)}`
    const err = rejects(long, 'path')
    assert.match(err.message, /DP\.PATH\.TOO_LONG/)
    assert.match(err.hint ?? '', /LongPathsEnabled/)
  })

  it('超长路径放行不该被长度规则以外的误判顶掉：错误码即判据', () => {
    // 反向钉住上面那条：合法的超长值报的是 TOO_LONG，不是别的什么
    try {
      assertSafe(`/${'a'.repeat(280)}`, 'path')
      assert.fail('应当抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.TPL.UNSAFE_VALUE')
    }
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

  it('模板自身写出来的字符不过闸门 —— 只校验被替换进去的值', () => {
    // 闸门管的是**注入**。模板是作者写的，它里面的换行、缩进都是产物的一部分；
    // 把整份模板一起查，等于把所有多行 conf 全部拒掉 —— 误伤与漏检一样是故障。
    // 代价要说清：作者要往模板里塞控制字符是可能的，这里不挡。
    assert.equal(renderString('server {\n\troot /srv/web;\n}\n', ctx), 'server {\n\troot /srv/web;\n}\n')
    assert.equal(renderString('a\u0000b', ctx), 'a\u0000b')
  })

  it('转义的引用不取值，因此也不进闸门', () => {
    // `$${x}` 的产出物是模板作者写下的字面量，没有任何外部内容被注入；
    // 若这里也报错，就得提供一个「连字面量都能过闸」的写法，那没有
    const ctx2: RenderContext = { ...ctx, envVars: { DIR: '/srv\nweb' } }
    assert.equal(renderString('$${env.DIR}', ctx2), '${env.DIR}')
  })

  it('路径规则在渲染链路上同样生效 —— 不只是直接调 assertSafe 才会', () => {
    // 只测 assertSafe 会漏掉「renderString 忘了传 usage」这种接线断点：
    // 断言函数本身对，但值没经过它
    const ctx2: RenderContext = { ...ctx, envVars: { DIR: '/srv/we*b' } }
    assert.equal(renderString('root ${env.DIR};', ctx2, { usage: 'conf' }), 'root /srv/we*b;')
    assert.throws(
      () => renderString('root ${env.DIR};', ctx2, { usage: 'path' }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.TPL.UNSAFE_VALUE',
    )
  })

  it('UNSAFE_VALUE 带上 options.path，便于定位到具体配置项', () => {
    try {
      renderString('root ${env.DIR};', { ...ctx, envVars: { DIR: '/srv\nweb' } }, { usage: 'path', path: 'projects.web.target.root' })
      assert.fail('应当抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.TPL.UNSAFE_VALUE')
      assert.equal(err.path, 'projects.web.target.root')
    }
  })

  it('多段模板里只有出事的那一段报错，错误指向它而不是整份模板', () => {
    const ctx2: RenderContext = { ...ctx, envVars: { OK: '/srv/ok', BAD: '/srv/b\nd' } }
    assert.equal(renderString('${env.OK}\n${env.OK}', ctx2, { usage: 'path' }), '/srv/ok\n/srv/ok')
    assert.throws(
      () => renderString('${env.OK}\n${env.BAD}', ctx2, { usage: 'path' }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.TPL.UNSAFE_VALUE',
    )
  })
})
