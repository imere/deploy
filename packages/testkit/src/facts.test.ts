import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { defaultFacts, linuxFacts } from './facts.js'

describe('defaultFacts', () => {
  it('白板默认值：能力全零值，软链保持可用，布局推导必得 user 的前提', () => {
    const facts = defaultFacts()
    assert.equal(facts.host, 'test-host')
    assert.equal(facts.platform, 'linux')
    assert.equal(facts.arch, 'x64')
    assert.equal(facts.init, 'systemd')
    assert.equal(facts.homedir, '/home/u')
    assert.equal(facts.tmpdir, '/tmp')
    assert.deepEqual(facts.env, {})
    assert.deepEqual(facts.tools, {})
    assert.equal(facts.capabilities.canSymlink, true)
    assert.equal(facts.capabilities.systemdScope, 'none')
    assert.equal(facts.capabilities.lingerEnabled, false)
    assert.equal(facts.capabilities.canBindPrivilegedPort, false)
    assert.deepEqual(facts.capabilities.canWrite, {})
    assert.deepEqual(facts.capabilities.canChown, [])
    assert.deepEqual(facts.capabilities.sudoAllowlist, [])
  })

  it('capabilities 是部分覆盖：只动写下来的键，其余能力保持默认（整体替换测不出这一点）', () => {
    const facts = defaultFacts({ capabilities: { canWrite: { '/srv/app': true } } })
    assert.deepEqual(facts.capabilities.canWrite, { '/srv/app': true })
    assert.equal(facts.capabilities.canSymlink, true)
    assert.equal(facts.capabilities.systemdScope, 'none')
    assert.deepEqual(facts.capabilities.sudoAllowlist, [])
  })

  it('显式写 undefined 与不写等效：覆盖表不是重置开关', () => {
    const facts = defaultFacts({
      host: 'web-01',
      capabilities: { canWrite: undefined, canSymlink: undefined },
    })
    assert.equal(facts.host, 'web-01')
    assert.deepEqual(facts.capabilities.canWrite, {})
    assert.equal(facts.capabilities.canSymlink, true)
  })

  it('顶层字段按名单覆盖：host / platform / tools 各自独立', () => {
    const facts = defaultFacts({
      host: 'dp-target',
      platform: 'win32',
      tools: { ssh: null },
    })
    assert.equal(facts.host, 'dp-target')
    assert.equal(facts.platform, 'win32')
    assert.deepEqual(facts.tools, { ssh: null })
    assert.equal(facts.init, 'systemd', '没写的字段不许丢失')
  })
})

describe('linuxFacts', () => {
  it('只比 defaultFacts 多 system scope 的 systemd，其余字段逐项一致', () => {
    const linux = linuxFacts()
    const base = defaultFacts()
    assert.equal(linux.capabilities.systemdScope, 'system')
    assert.equal(linux.host, base.host)
    assert.equal(linux.platform, base.platform)
    assert.deepEqual(linux.capabilities.canWrite, base.capabilities.canWrite)
    assert.deepEqual(linux.tools, base.tools)
  })

  it('覆盖表照常生效，且点名过的 capabilities 优先于内置的 system scope', () => {
    const facts = linuxFacts({ homedir: '/home/dev', capabilities: { systemdScope: 'user' } })
    assert.equal(facts.homedir, '/home/dev')
    assert.equal(facts.capabilities.systemdScope, 'user')
  })
})
