/**
 * schema 的 nginx 段单测。
 *
 * 关注三件 schema 真正该管的事：**默认值**、**联合形态**、**类型层看不出来的非法值**。
 * 语义判定（upstream 末尾斜杠、listen 修饰符、locations 空数组）刻意不在这里测 ——
 * 那些属于 @dp/target-nginx，在 schema 再写一遍就是两套规则各自漂移。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { defineNginx, defineTarget, nginxSchema, type NginxInput } from './config.js'

function codeOf(fn: () => unknown): { code: string; path?: string; hint?: string } {
  try {
    fn()
  } catch (err) {
    if (err instanceof DpError) {
      return { code: err.code, ...(err.path !== undefined ? { path: err.path } : {}), ...(err.hint !== undefined ? { hint: err.hint } : {}) }
    }
    throw err
  }
  assert.fail('应当抛错')
}

/**
 * 故意写错的输入走这里，而不是 `defineNginx({...} as unknown as ...)`。
 *
 * 非法输入本来就无法用类型表达，而 `Schema.parse(input: unknown, path)` 的签名
 * 正是为此存在：断言用的是**配置加载器实际走的那条路**（config-file 调的也是
 * schema.parse），比在测试里另造一个 cast 入口更接近生产。
 */
function parseRaw(value: unknown): unknown {
  return nginxSchema.parse(value, 'nginx')
}

const BASE: NginxInput = { server: { root: '/srv/app/current' } }

describe('nginx · 省略可选项', () => {
  it('不产生 filename / force / reload 这几个键', () => {
    const parsed = defineNginx(BASE)
    assert.deepEqual(Object.keys(parsed), ['server'])
    // 「键不存在」与「键存在但 undefined」在这里是同一件事：默认行为归 @dp/target-nginx 管
    assert.equal('filename' in parsed, false)
    assert.equal('force' in parsed, false)
    assert.equal('reload' in parsed, false)
  })

  it('写了就保留原值（不做任何改写）', () => {
    const parsed = defineNginx({ ...BASE, filename: '${project}.conf', force: true, reload: ['nginx', '-s', 'reload'] })
    assert.equal(parsed.filename, '${project}.conf')
    assert.equal(parsed.force, true)
    assert.deepEqual(parsed.reload, ['nginx', '-s', 'reload'])
  })
})

describe('nginx · server 的联合形态', () => {
  it('单块对象原样通过', () => {
    const parsed = defineNginx({ server: { serverName: ['a.example.com'], listen: [80, '443 ssl'] } })
    // 逐字段断言做不到：Array.isArray 收不掉 readonly T[] 分支，TS 不给窄化。
    // 整体比对反而更强 —— 它同时证明了「只保留写过的键」
    assert.deepEqual(parsed.server, { serverName: ['a.example.com'], listen: [80, '443 ssl'] })
  })

  it('多块数组逐块解析', () => {
    const parsed = defineNginx({
      server: [
        { serverName: ['a.example.com'], root: '/srv/a/current' },
        { serverName: ['b.example.com'], listen: [8080], locations: [{ path: '/', root: '/srv/b' }] },
      ],
    })
    assert.ok(Array.isArray(parsed.server))
    assert.equal(parsed.server.length, 2)
    assert.deepEqual(parsed.server[1], {
      serverName: ['b.example.com'],
      listen: [8080],
      locations: [{ path: '/', root: '/srv/b' }],
    })
  })

  it('数字与字符串的 listen 都接受，混合也接受', () => {
    const parsed = defineNginx({ server: { listen: [80, '443 ssl', 'unix:/tmp/s.sock'] } })
    assert.deepEqual(parsed.server, { listen: [80, '443 ssl', 'unix:/tmp/s.sock'] })
  })

  it('空数组是合法输入（语义判定归渲染层）', () => {
    // 刻意不在这里拒：渲染层已经带着 hint 拒它（DP.NGX.CONF_INVALID），
    // schema 再拒一次就是两套规则，症状是两边提示不一致
    const parsed = defineNginx({ server: { locations: [] } })
    assert.deepEqual(parsed.server, { locations: [] })
  })

  it('数字（既不是对象也不是数组）→ 说清两种期望形态', () => {
    const r = codeOf(() => parseRaw({ ...BASE, server: 8080 }))
    assert.equal(r.code, 'CONFIG_INVALID')
    assert.match(String(r.hint), /单个 server 块对象/)
    assert.match(String(r.hint), /server 块数组/)
  })
})

describe('nginx · reload', () => {
  it('false 通过（由外部机制重载）', () => {
    const parsed = defineNginx({ ...BASE, reload: false })
    assert.equal(parsed.reload, false)
  })

  it('argv 里的空串被拒 —— 类型层看不出来，但空参数会让远端 execve 直接失败', () => {
    const r = codeOf(() => defineNginx({ ...BASE, reload: ['nginx', '', 'reload'] }))
    assert.equal(r.code, 'CONFIG_INVALID')
    assert.equal(r.path, 'nginx.reload[1]')
    assert.match(String(r.hint), /execve/)
  })

  it('首元素空串同样被拒', () => {
    assert.equal(codeOf(() => defineNginx({ ...BASE, reload: [''] })).code, 'CONFIG_INVALID')
  })

  it('既不是数组也不是 false → 说清两种写法', () => {
    const r = codeOf(() => parseRaw({ ...BASE, reload: 'nginx -s reload' }))
    assert.equal(r.code, 'CONFIG_INVALID')
    assert.match(String(r.hint), /argv 数组/)
    assert.match(String(r.hint), /false/)
  })
})

describe('nginx · 未知字段被拒', () => {
  it('server 里的未知键报出可用字段', () => {
    const r = codeOf(() => parseRaw({ server: { root: '/srv', upstream: 'http://x' } }))
    assert.equal(r.code, 'CONFIG_INVALID')
    assert.equal(r.path, 'nginx.server.upstream')
    assert.match(String(r.hint), /serverName/)
  })

  it('顶层未知键同样被拒（confd 不在这里，写了就是错配置）', () => {
    const r = codeOf(() => parseRaw({ ...BASE, confd: '/etc/nginx/conf.d' }))
    assert.equal(r.code, 'CONFIG_INVALID')
    assert.equal(r.path, 'nginx.confd')
  })

  it('嵌套层的未知键定位到具体路径', () => {
    const r = codeOf(() =>
      parseRaw({ server: { locations: [{ path: '/', root: '/srv', rewrites: [] }] } }),
    )
    assert.equal(r.path, 'nginx.server.locations[0].rewrites')
  })
})

describe('targetSchema 里的 nginx', () => {
  it('opt() 后省略不产生该键（零回归的前提）', () => {
    const target = defineTarget({ type: 'static' })
    assert.equal('nginx' in target, false)
  })

  it('配了就能取到，且 confd 与 nginx 同级', () => {
    const target = defineTarget({ type: ['nginx'], confd: '/etc/nginx/conf.d', nginx: BASE })
    assert.deepEqual(target.nginx, { server: { root: '/srv/app/current' } })
    assert.equal(target.confd, '/etc/nginx/conf.d')
  })

  it('json schema 里 server 必填（漏了它渲染不出任何东西）', () => {
    assert.deepEqual(nginxSchema.toJsonSchema().required, ['server'])
  })

  it('json schema 里 server 是联合（导出给编辑器的那份不能撒谎）', () => {
    const server = nginxSchema.toJsonSchema().properties?.['server']
    assert.ok(server?.anyOf !== undefined, '单块 / 多块必须导出成 anyOf')
  })
})
