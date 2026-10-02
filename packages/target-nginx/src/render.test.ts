/**
 * conf 渲染。
 *
 * 只测「拦住什么」会让人把规则写松（把合法的 `$host` 也拦掉），
 * 所以每类都配一条「必须放行」：误伤同样是故障。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import type { RenderContext } from '@dp/template'
import { renderConf, renderShadowMainConf } from './render.js'
import type { Location, ServerBlock } from './types.js'

const CTX: RenderContext = {
  project: 'web',
  env: 'prod',
  release: { id: 'r-7f3a', current: '/srv/web/current' },
  now: new Date('2026-01-02T03:04:05.000Z'),
}

function render(server: ServerBlock, path?: string): string {
  return renderConf(server, CTX, path === undefined ? undefined : { path })
}

function throws(block: ServerBlock, code: string): DpError {
  try {
    render(block)
  } catch (err) {
    assert.ok(err instanceof DpError, `期望 DpError，实际 ${String(err)}`)
    assert.equal(err.code, code)
    assert.ok((err.hint ?? '') !== '', `错误 ${code} 必须带 hint`)
    return err
  }
  throw new Error(`期望 ${code}，实际渲染成功`)
}

function throwsCode(run: () => unknown, code: string): DpError {
  try {
    run()
  } catch (err) {
    assert.ok(err instanceof DpError, `期望 DpError，实际 ${String(err)}`)
    assert.equal(err.code, code)
    return err
  }
  throw new Error(`期望 ${code}，实际未抛错`)
}

const FULL: ServerBlock = {
  serverName: ['web.example.com', 'www.example.com'],
  listen: [80, '443 ssl'],
  root: '${release.current}',
  index: ['index.html'],
  locations: [
    { path: '/', tryFiles: '$uri $uri/ /index.html' },
    { path: '/api/', proxy: { upstream: 'http://127.0.0.1:8080' } },
    { path: '= /healthz', proxy: { upstream: 'http://127.0.0.1:8080', websocket: true, timeouts: { connect: 5, read: 60 } } },
  ],
  extra: ['add_header X-Frame-Options "SAMEORIGIN";'],
}

const GOLDEN = `# managed by dp
# 由 dp 生成，直接改这个文件会在下次部署时被覆盖；配置请改 projects.*.target.nginx
server {
  listen 80;
  listen 443 ssl;
  server_name web.example.com www.example.com;
  root /srv/web/current;
  index index.html;
  location / {
    try_files $uri $uri/ /index.html;
  }
  location /api/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
  location = /healthz {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_connect_timeout 5s;
    proxy_read_timeout 60s;
  }
  add_header X-Frame-Options "SAMEORIGIN";
}
`

describe('renderConf', () => {
  it('golden：完整 conf 逐字相同，且两次渲染完全一致', () => {
    const first = render(FULL)
    assert.equal(first, GOLDEN)
    // 幂等是纯函数包的底线：输出里只要掺了时间/顺序不定的东西，两次就不一样
    assert.equal(render(FULL), first)
    assert.equal(first.endsWith('}\n'), true)
  })

  it('保留 nginx 自己的变量：$host / $uri / $1 一律不转义', () => {
    const out = render({
      root: '/srv',
      locations: [{ path: '/', tryFiles: '$uri $uri/ /index.html' }, { path: '/api/', proxy: { upstream: 'http://127.0.0.1:8080' } }],
    })
    assert.match(out, /proxy_set_header Host \$host;/)
    assert.match(out, /try_files \$uri \$uri\/ \/index\.html;/)
    // 少这一个 $ 产出的 conf 直接废掉：$uri 会变成 nginx 认不出的变量名
    assert.equal(out.includes('${'), false)
  })

  it('字面量 ${x} 用 $${x} 转义后照原样落盘', () => {
    const out = render({ root: '/srv', locations: [{ path: '/', extra: ['add_header X-Lit "${x}";'] }] })
    assert.match(out, /add_header X-Lit "\$\{x\}";/)
  })

  it('省略 serverName → _ ；显式空数组 → 拒绝（静默变 _ 会盖掉别的 vhost）', () => {
    assert.match(render({ root: '/srv' }), /server_name _;/)
    const err = throws({ serverName: [], root: '/srv' }, 'DP.NGX.CONF_INVALID')
    assert.match(err.message, /空数组/)
    assert.match(err.hint ?? '', /catch-all/)
  })

  it('省略 listen → 80', () => {
    assert.match(render({ root: '/srv' }), /listen 80;/)
  })

  it('rejects 反代末尾斜杠，并在 hint 里说明两种写法的语义', () => {
    const err = throws({ locations: [{ path: '/api/', proxy: { upstream: 'http://127.0.0.1:8080/' } }] }, 'DP.NGX.CONF_INVALID')
    assert.match(err.message, /末尾带斜杠/)
    assert.match(err.hint ?? '', /剥掉 location 前缀/)
  })

  it('rejects 非 http(s) 的 upstream（写错 scheme 会让请求被当静态文件）', () => {
    for (const bad of ['127.0.0.1:8080', 'htp://127.0.0.1:8080', 'ws://127.0.0.1:8080', 'http://']) {
      assert.throws(
        () => render({ locations: [{ path: '/api/', proxy: { upstream: bad } }] }),
        (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
        `upstream ${bad} 必须被拒`,
      )
    }
  })

  it('rejects location.path 缺匹配前缀 —— nginx 不会报错，只是永远匹配不上', () => {
    for (const bad of ['api/', '~^/api$ ']) {
      assert.throws(
        () => render({ locations: [{ path: bad, extra: ['return 204;'] }] }),
        (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
        `location ${bad} 必须被拒`,
      )
    }
    // 合法前缀必须放行
    for (const good of ['/', '/api/', '= /healthz', '~ \\.php$', '^~ /static/']) {
      assert.doesNotThrow(() => render({ locations: [{ path: good, extra: ['return 204;'] }] }))
    }
  })

  it('rejects 值里的换行（conf 档）：这是往 conf 注入指令的通路', () => {
    const injected: Location = {
      path: '/api/',
      proxy: { upstream: 'http://127.0.0.1:8080\n  add_header X-Injected 1;' },
    }
    const viaLiteral = throws({ locations: [injected] }, 'DP.NGX.UNSAFE_VALUE')
    assert.match(viaLiteral.message, /<LF>/)
    // 同一份攻击从环境变量来，模板层自己就挡；两条路都要拦住
    const viaEnv = throwsCode(
      () =>
        renderConf(
          { locations: [{ path: '/', proxy: { upstream: '${env.UPSTREAM}' } }] },
          { ...CTX, envVars: { UPSTREAM: 'http://127.0.0.1:8080\n  include /tmp/evil.conf;' } },
        ),
      'DP.NGX.UNSAFE_VALUE',
    )
    assert.match(viaEnv.message, /<LF>/)
    assert.throws(
      () => render({ serverName: ['a.com\n  add_header X-Injected 1;'], root: '/srv' }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.UNSAFE_VALUE',
    )
  })

  it('rejects 值里的 conf 语法边界（; { }）', () => {
    assert.throws(
      () => render({ serverName: ['a.com; deny all;'], root: '/srv' }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
    )
  })

  it('rejects 空 location / 无内容来源的 server —— 它们只会安静地 404', () => {
    assert.throws(
      () => render({ locations: [{ path: '/admin/' }] }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
    )
    assert.throws(
      () => render({ serverName: ['a.com'] }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
    )
  })

  it('rejects 同名 server_name / 重复 location（nginx -t 才会报，先在这里报）', () => {
    assert.throws(
      () => renderConf([{ serverName: ['a.com'], root: '/srv' }, { serverName: ['a.com'], root: '/srv2' }], CTX),
      (e: unknown) => e instanceof DpError && /a\.com/.test(e.message),
    )
    assert.throws(
      () => render({ locations: [{ path: '/', extra: ['return 204;'] }, { path: '/', extra: ['return 205;'] }] }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
    )
  })

  it('extra 原样输出：不渲染、不替换字符（显式逃生舱）', () => {
    const out = render({ root: '/srv', extra: ['# 上面这行是用户自己写的', 'add_header X-Lit "${project}.conf";'] })
    assert.match(out, /# 上面这行是用户自己写的/)
    assert.match(out, /add_header X-Lit "\$\{project\}\.conf";/)
  })

  it('root 用 path 档：非法路径字符被拒', () => {
    assert.throws(
      () => render({ root: '/srv/web?x=1' }),
      (e: unknown) => e instanceof DpError,
    )
  })

  // `path` 档只挡控制字符与跨平台非法字符，`;` `{` `}` 不在其中。
  // 而 root / index 都是被拼进 `<指令> <值>;` 的 —— 值里一个分号就多出一条指令，
  // 与 try_files / server_name 是同一条通路，不能只给那几个字段做边界检查。
  it('root 含 conf 边界字符被拒：值里一个分号就多出一条指令', () => {
    for (const bad of ['/srv; root /etc', '/srv{', '/srv}']) {
      assert.throws(
        () => render({ root: bad }),
        (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
        `应拒绝 ${bad}`,
      )
    }
  })

  it('location 里的 root 同样拒绝边界字符', () => {
    assert.throws(
      () => render({ root: '/srv', locations: [{ path: '/', root: '/srv; root /etc' }] }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
    )
  })

  it('index 含 conf 边界字符被拒（空白检查挡不住 `a.html;root`）', () => {
    for (const bad of ['index.html;root', 'index.html{', 'index.html}']) {
      assert.throws(
        () => render({ root: '/srv', index: [bad] }),
        (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
        `应拒绝 ${bad}`,
      )
    }
  })

  it('多个 server 块 → 各自渲染，冲突检查跨块', () => {
    const out = renderConf([{ serverName: ['a.com'], root: '/a' }, { serverName: ['b.com'], root: '/b' }], CTX)
    assert.equal(out.match(/^server \{$/gm)?.length, 2)
  })
})

describe('renderShadowMainConf', () => {
  it('include 真实树 + 候选文件，且顺序固定', () => {
    const out = renderShadowMainConf({
      includes: ['/etc/nginx/conf.d/*.conf'],
      candidate: '/etc/nginx/conf.d/.dp-shadow/r-1/web.conf',
    })
    assert.equal(
      out,
      `# managed by dp
# 影子主配置：只为在不碰生产目录的前提下让 \`nginx -t\` 解析候选文件。它不是生产主配置，
# 目的路径、日志、mime.types 等一概不管 —— 校验范围是新文件本身与 include 能否解析。
events { }
http {
  include /etc/nginx/conf.d/*.conf;
  include /etc/nginx/conf.d/.dp-shadow/r-1/web.conf;
}
`,
    )
  })

  it('include 路径含结构字符就拒绝（列目录拿到畸形文件名时）', () => {
    assert.throws(
      () => renderShadowMainConf({ includes: ['/etc/nginx/conf.d/a b.conf'], candidate: '/x/c.conf' }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
    )
  })
})
