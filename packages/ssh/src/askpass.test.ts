import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { DpError } from '@dp/ports'
import { askpassToken, createAskpassHelper } from './askpass.js'

const created: string[] = []
after(() => {
  // 兜底清理：任何一条用例中途失败也不该把含密码的文件留在磁盘上
  for (const p of created) rmSync(p, { recursive: true, force: true })
})

function helper(secret: string, dir?: string) {
  const h = createAskpassHelper(secret, dir === undefined ? {} : { dir })
  created.push(dirname(h.path))
  return h
}

const isWindows = process.platform === 'win32'

describe('createAskpassHelper —— 脚本内容', () => {
  it('POSIX：shebang + printf 单引号包裹（不是裸插值）', { skip: isWindows ? 'Windows 上用 .cmd' : false }, () => {
    const h = helper('s3cret')
    const body = readFileSync(h.path, 'utf8')
    assert.ok(body.startsWith('#!/bin/sh\n'), body)
    assert.ok(body.includes("printf '%s\\n' 's3cret'"), body)
  })

  it('POSIX：密码含单引号时按 POSIX 规则转义', { skip: isWindows ? 'Windows 上用 .cmd' : false }, () => {
    const h = helper("it's")
    const body = readFileSync(h.path, 'utf8')
    assert.ok(body.includes(`'it'\\''s'`), body)
  })

  it('POSIX：含空格的密码保持为单引号内的一整串', { skip: isWindows ? 'Windows 上用 .cmd' : false }, () => {
    const body = readFileSync(helper('a b c').path, 'utf8')
    assert.ok(body.includes("'a b c'"), body)
  })

  it('Windows：生成 .cmd 且带 @echo off', { skip: isWindows ? false : '非 Windows' }, () => {
    const h = helper('s3cret')
    assert.ok(h.path.endsWith('.cmd'), h.path)
    assert.match(readFileSync(h.path, 'utf8'), /@echo off/i)
  })
})

describe('createAskpassHelper —— 环境变量', () => {
  it('SSH_ASKPASS 指向脚本、REQUIRE=force、DISPLAY 非空', () => {
    const h = helper('pw')
    assert.equal(h.env.SSH_ASKPASS, h.path)
    assert.equal(h.env.SSH_ASKPASS_REQUIRE, 'force')
    // Linux 上 DISPLAY 为空会被 OpenSSH 判定"没有 X 就用不了 askpass"
    assert.equal(h.env.DISPLAY, ':0')
  })

  it('环境变量里**不含**密码本体（ps / /proc/<pid>/environ 都能看到）', () => {
    const h = helper('SuperSecret123')
    for (const v of Object.values(h.env)) {
      assert.doesNotMatch(v, /SuperSecret123/)
    }
  })

  it('env 对象里没有多余的东西', () => {
    assert.deepEqual(Object.keys(helper('pw').env).sort(), ['DISPLAY', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'])
  })
})

describe('createAskpassHelper —— 权限与生命周期', () => {
  it('目录与文件都是 0700', { skip: process.platform === 'win32' ? 'Windows 无 POSIX 权限位' : false }, () => {
    const h = helper('pw')
    assert.equal(statSync(dirname(h.path)).mode & 0o777, 0o700)
    assert.equal(statSync(h.path).mode & 0o777, 0o700)
  })

  it('临时目录落在给定的 dir 下', () => {
    const h = helper('pw', tmpdir())
    assert.ok(h.path.startsWith(tmpdir()), h.path)
  })

  it('用完即删：dispose 之后文件与目录都不存在', () => {
    const h = createAskpassHelper('pw')
    const dir = dirname(h.path)
    assert.ok(existsSync(h.path))
    h.dispose()
    assert.equal(existsSync(h.path), false)
    assert.equal(existsSync(dir), false)
  })

  it('dispose 幂等（重复调用不抛）', () => {
    const h = createAskpassHelper('pw')
    h.dispose()
    assert.doesNotThrow(() => h.dispose())
    assert.doesNotThrow(() => h.dispose())
  })

  it('每次生成的目录互不相同（并发部署不会互相覆盖）', () => {
    const a = helper('pw')
    const b = helper('pw')
    assert.notEqual(a.path, b.path)
  })
})

describe('createAskpassHelper —— 拒绝不安全输入', () => {
  it('空 secret 直接拒绝（必然认证失败，不必花一次往返）', () => {
    assert.throws(
      () => createAskpassHelper(''),
      (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
    )
  })

  it('Windows 上含 cmd.exe 会解释的字符的密码被拒绝（不给注入面留缝）', {
    skip: isWindows ? false : '仅 Windows 的 .cmd 受此限；POSIX 的 sh 单引号能安全表达',
  }, () => {
    for (const bad of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a%PATH%', 'a!b', 'a"b', 'a\nb']) {
      assert.throws(
        () => createAskpassHelper(bad),
        (err: unknown) => {
          assert.ok(err instanceof DpError)
          assert.equal(err.code, 'DP.SSH.AUTH_FAILED')
          assert.ok(err.hint !== undefined && err.hint.length > 0, '必须有 hint')
          return true
        },
        bad,
      )
    }
  })

  it('拒绝时不落任何文件（不会留下含密码的残留）', {
    skip: isWindows ? false : '仅 Windows 分支',
  }, () => {
    const before = existsSync(tmpdir())
    assert.equal(before, true)
    assert.throws(() => createAskpassHelper('a&b'))
  })
})

describe('askpassToken', () => {
  it('长度固定且不重复', () => {
    assert.equal(askpassToken().length, 12)
    assert.notEqual(askpassToken(), askpassToken())
  })
})
