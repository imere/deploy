import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_REPLACEMENT,
  MAX_ARRAY_ITEMS,
  compileRedact,
  isSecretKey,
  redact,
} from './redact.js'
import { DpError } from '@dp/ports'

const S = '***'

describe('redact / key 名', () => {
  it('包含匹配（含大小写与拼接）', () => {
    const c = compileRedact()
    for (const k of [
      'password', 'PASSWORD', 'xToken', 'api_key', 'apiKey', 'secret',
      'privatekey', 'private_key', 'credential', 'authorization',
      'auth', 'cookie', 'session', 'passphrase', 'passwd', 'pem',
    ]) {
      assert.equal(isSecretKey(k, c), true, `${k} 应命中`)
    }
  })

  it('key 只按单词边界命中：keyboard/monkey/keypath 不脱敏', () => {
    const c = compileRedact()
    for (const k of ['keyboard', 'monkey', 'keypath', 'keyword', 'donkey']) {
      assert.equal(isSecretKey(k, c), false, `${k} 不应命中`)
    }
    // 独立的 key 及其带分隔符形式要命中
    for (const k of ['key', 'KEY', 'my-key', 'key file']) {
      assert.equal(isSecretKey(k, c), true, `${k} 应命中`)
    }
  })

  it('auth 按词段命中：authToken/auth_token 命中，author/authority 不命中', () => {
    const c = compileRedact()
    for (const k of ['auth', 'authToken', 'auth_token', 'x-auth', 'oauth2_token']) {
      assert.equal(isSecretKey(k, c), true, `${k} 应命中`)
    }
    // 误伤防线：作者类字段不是凭据，脱掉会让排障看不出是谁触发的
    for (const k of ['author', 'authority', 'authorName', 'coauthor']) {
      assert.equal(isSecretKey(k, c), false, `${k} 不应命中`)
    }
  })

  it('证书与签名不算敏感（公开信息，脱掉反而没法排障）', () => {
    const c = compileRedact()
    for (const k of ['certificate', 'cert', 'sig', 'signature']) {
      assert.equal(isSecretKey(k, c), false, `${k} 不应命中`)
    }
  })

  it('命中即整值替换，且不改原对象', () => {
    const src = { password: 'hunter2', host: 'web-01' }
    const out = redact(src) as Record<string, unknown>
    assert.deepEqual(out, { password: S, host: 'web-01' })
    assert.equal(src.password, 'hunter2', '原对象必须保持不变')
  })

  it('嵌套对象里的敏感 key 一样命中', () => {
    const out = redact({ outer: { inner: { apiKey: 'k' } } }) as Record<string, any>
    assert.equal(out.outer.inner.apiKey, S)
  })

  it('支持 extraKeyPatterns（字符串与 RegExp）', () => {
    const out = redact({ pin: '1234', card: 'x' }, { extraKeyPatterns: ['pin', /CARD$/] }) as Record<string, unknown>
    assert.deepEqual(out, { pin: S, card: S })
  })
})

describe('redact / 值模式', () => {
  const cases: ReadonlyArray<readonly [string, string]> = [
    ['PEM 私钥（完整块）', '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAbody\n-----END OPENSSH PRIVATE KEY-----'],
    ['PEM 私钥（仅头部残片）', 'key is -----BEGIN RSA PRIVATE KEY----- and more'],
    ['Bearer', 'Authorization: Bearer abc.def.ghi'],
    ['ssh-rsa', 'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQ'],
    ['ssh-ed25519', 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP'],
    ['GitHub token', 'ghp_abcdefghij0123456789ABCDEFGHIJ'],
    ['GitHub oauth', 'gho_abcdefghij0123456789ABCDEFGHIJ'],
    ['Slack token', 'xoxb-1234567890-abcdefghij'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE'],
  ]

  for (const [name, raw] of cases) {
    it(`${name} 命中即脱敏`, () => {
      const out = redact({ note: raw }) as Record<string, string>
      assert.ok(!out.note!.includes('BEGIN'), `${name} 残留`)
      assert.ok(out.note!.includes(S), `${name} 未被替换`)
    })
  }

  it('PEM 完整块连正文一起脱敏（只脱头部等于没脱）', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nSECRETBODYLINE\n-----END RSA PRIVATE KEY-----'
    const out = redact(pem) as string
    assert.equal(out, S)
  })

  it('证书不脱敏', () => {
    const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'
    assert.equal(redact(cert), cert)
  })

  it('替换后保留周边上下文（这是值模式与 key 模式最大的区别）', () => {
    const out = redact({ note: 'login failed: Bearer abc123XYZ' }) as Record<string, string>
    assert.equal(out.note, `login failed: ${S}`)
  })

  it('支持 extraValuePatterns，并补上缺失的 g 标志', () => {
    const out = redact({ note: 'id=42 id=43' }, { extraValuePatterns: [/id=\d+/] }) as Record<string, string>
    assert.equal(out.note, `${S} ${S}`)
  })

  it('extraValuePatterns 里的 g 标志 lastIndex 不会污染下一次调用', () => {
    const opts = { extraValuePatterns: [/x\d+/g] }
    assert.deepEqual(redact({ a: 'x1 x2' }, opts), { a: `${S} ${S}` })
    assert.deepEqual(redact({ a: 'x1 x2' }, opts), { a: `${S} ${S}` })
  })
})

describe('redact / 健壮性', () => {
  it('自引用不无限递归', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    const out = redact(a) as Record<string, unknown>
    assert.equal(out.name, 'a')
    assert.equal(out.self, '[Circular]')
  })

  it('a→b→a 双向环', () => {
    const a: Record<string, unknown> = { n: 'a' }
    const b: Record<string, unknown> = { n: 'b', a }
    a.b = b
    const out = redact(a) as Record<string, any>
    assert.equal(out.b.n, 'b')
    assert.equal(out.b.a, '[Circular]')
  })

  it('共享引用（不是环）不该被误判', () => {
    const shared = { v: 1 }
    const out = redact({ a: shared, b: shared }) as Record<string, any>
    assert.deepEqual(out.a, { v: 1 })
    assert.deepEqual(out.b, { v: 1 })
  })

  it('超过 maxDepth 替换为 replacement', () => {
    let deep: Record<string, unknown> = { leaf: 'x' }
    for (let i = 0; i < 10; i++) deep = { next: deep }
    const out = redact(deep) as Record<string, any>
    assert.ok(JSON.stringify(out).includes(S), '深层应被截断')
  })

  it('maxDepth 可配（maxDepth = 根对象之下允许的层数）', () => {
    const deep: Record<string, unknown> = { a: { b: { c: 1 } } }
    assert.deepEqual(redact(deep, { maxDepth: 0 }), { a: '***' })
    assert.deepEqual(redact(deep, { maxDepth: 1 }), { a: { b: '***' } })
    assert.deepEqual(redact(deep, { maxDepth: 6 }), { a: { b: { c: 1 } } })
  })

  it('Symbol / BigInt / function / undefined 都能安全落盘', () => {
    const out = redact({
      sym: Symbol('s'),
      big: 10n,
      fn: function f() {},
      undef: undefined,
    }) as Record<string, unknown>
    assert.equal(out.sym, 'Symbol(s)')
    assert.equal(out.big, '10n')
    assert.equal(out.fn, '[Function]')
    assert.equal(out.undef, 'undefined')
  })

  it('Map → 普通对象，Set → 数组', () => {
    const out = redact({
      m: new Map<string, unknown>([['a', 1], ['token', 'zzz']]),
      s: new Set([1, 2]),
    }) as Record<string, any>
    assert.equal(out.m.a, 1)
    assert.equal(out.m.token, S, 'Map 的 key 也要走脱敏')
    assert.deepEqual(out.s, [1, 2])
  })

  it('Error → name/message/stack，且栈也过脱敏', () => {
    const err = new Error('connect failed with Bearer abc123XYZ')
    const out = redact({ err }) as Record<string, any>
    assert.equal(out.err.name, 'Error')
    assert.equal(out.err.message, `connect failed with ${S}`)
    assert.ok(!String(out.err.stack).includes('abc123XYZ'), '栈里不能留凭据')
  })

  it('Error 上的 code/path/hint 一并带出（排障要靠它们）', () => {
    const err = new DpError('DP.PATH.NOT_WRITABLE', 'nope', { path: 'projects.web.source', hint: '检查权限' })
    const out = redact({ err }) as Record<string, any>
    assert.equal(out.err.code, 'DP.PATH.NOT_WRITABLE')
    assert.equal(out.err.path, 'projects.web.source')
    assert.equal(out.err.hint, '检查权限')
  })

  it('toJSON 会被尊重（DpError 的结构化输出就靠它）', () => {
    const out = redact({ err: new DpError('DP.VERIFY.FAILED', 'bad') }) as Record<string, any>
    assert.equal(out.err.code, 'DP.VERIFY.FAILED')
  })

  it('toJSON 抛错时退回自有键，不冒泡', () => {
    const bad = {
      code: 'X',
      toJSON(): unknown {
        throw new Error('toJSON 炸了')
      },
    }
    const out = redact({ bad }) as Record<string, any>
    assert.equal(out.bad.code, 'X')
  })

  it('Date → ISO 串；非法日期不炸', () => {
    assert.equal(redact(new Date('2026-10-02T07:00:00.000Z')), '2026-10-02T07:00:00.000Z')
    const bad = new Date(NaN)
    assert.equal(typeof redact(bad), 'string')
  })

  it('Uint8Array / Buffer → [bytes:N]，二进制不进日志', () => {
    assert.equal(redact(new Uint8Array(4)), '[bytes:4]')
    assert.equal(redact(Buffer.from('abcdef')), '[bytes:6]')
  })

  it('非有限数字降级成字符串（JSON.stringify 会写成 null，信息全丢）', () => {
    const out = redact({ n: Number.NaN, i: Infinity }) as Record<string, string>
    assert.equal(out.n, 'NaN')
    assert.equal(out.i, 'Infinity')
  })

  it('超长字符串截断', () => {
    const out = redact('x'.repeat(3000)) as string
    assert.equal(out, `${'x'.repeat(2000)}…(truncated)`)
  })

  it('maxStringLength 与 replacement 可配', () => {
    assert.equal(redact('abcdefghij', { maxStringLength: 4 }), 'abcd…(truncated)')
    const out = redact({ password: 'v' }, { replacement: '<redacted>' }) as Record<string, unknown>
    assert.equal(out.password, '<redacted>')
  })

  it('超长数组只留前 100 个并追加计数', () => {
    const out = redact(Array.from({ length: MAX_ARRAY_ITEMS + 5 }, (_, i) => i)) as unknown[]
    assert.equal(out.length, MAX_ARRAY_ITEMS + 1)
    assert.equal(out[out.length - 1], '…(5 more)')
  })

  it('getter 抛错 / Proxy ownKeys 抛错都不冒泡', () => {
    const withBadGetter = {
      get boom(): string {
        throw new Error('getter 炸了')
      },
    }
    const out = redact({ f: withBadGetter }) as Record<string, Record<string, unknown>>
    assert.equal(out.f!.boom, '[Unserializable]')

    const evil = new Proxy({ a: 1 }, {
      ownKeys() {
        throw new Error('ownKeys 炸了')
      },
    })
    const out2 = redact({ e: evil }) as Record<string, unknown>
    assert.equal(out2.e, '[Unserializable]')
  })

  it('replacement 本身被用作深度截断与敏感替换', () => {
    assert.equal(DEFAULT_REPLACEMENT, '***')
  })
})
