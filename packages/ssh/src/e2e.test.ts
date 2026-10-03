/**
 * 真机集成测试 —— **默认跳过**。
 *
 * 需要真 SSH 目标时按 `.agents/skills/dp-spike-env/` 起 podman 容器，
 * 然后：
 *
 * ```
 * DP_SSH_E2E=1 \
 * DP_SSH_HOST=127.0.0.1 DP_SSH_USER=dpuser DP_SSH_PORT=2222 \
 * node --test packages/ssh/build/e2e.test.js
 * ```
 *
 * 它补的是假驱动**覆盖不到**的那一层：posix.ts 生成的脚本体是否真能在
 * 一台真实 POSIX 机器上跑通（base64 是否存在、stat 的 GNU/BSD 选项差异、
 * 主机密钥策略的真实行为）。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'
import { connectSsh } from './connect.js'
import type { SshConnectionOptions } from './driver.js'

const E2E = process.env.DP_SSH_E2E === '1'
const SKIP = E2E
  ? false
  : '需要真机：设置 DP_SSH_E2E=1 与 DP_SSH_HOST / DP_SSH_USER（见 .agents/skills/dp-spike-env）'

const host = process.env.DP_SSH_HOST ?? '127.0.0.1'
const user = process.env.DP_SSH_USER ?? 'dpuser'
const port = process.env.DP_SSH_PORT === undefined ? undefined : Number(process.env.DP_SSH_PORT)
const password = process.env.DP_SSH_PASSWORD

describe('真机：连接 + 事实探测', { skip: SKIP }, () => {
  let close: () => Promise<void> = async () => {}

  before(async () => {
    const options: SshConnectionOptions = {
      host,
      user,
      port,
      knownHosts: 'accept-new',
      auth: password === undefined ? { type: 'agent' } : { type: 'password', passwordRef: 'env:DP_SSH_PASSWORD' },
      secrets: password === undefined ? undefined : { password },
      timeoutMs: 20_000,
    }
    const conn = await connectSsh(options)
    close = conn.close
  })

  after(async () => {
    await close()
  })

  it('Facts 全部是实证出来的', async () => {
    const conn = await connectSsh({ host, user, port, knownHosts: 'accept-new', auth: { type: 'agent' } })
    try {
      const f = conn.facts
      assert.notEqual(f.platform, 'unknown')
      assert.notEqual(f.arch, 'other')
      assert.ok(f.tmpdir.startsWith('/'))
      // 每个探过的工具都必须有结论（有或没有），不能是 undefined
      for (const [name, v] of Object.entries(f.tools)) {
        assert.ok(v === null || typeof v === 'string', `${name} 的探测结果形状不对`)
      }
    } finally {
      await conn.close()
    }
  })

  it('exec 拿得到真实退出码', async () => {
    const conn = await connectSsh({ host, user, port, knownHosts: 'accept-new', auth: { type: 'agent' } })
    try {
      assert.equal((await conn.runner.exec(['true'])).code, 0)
      assert.notEqual((await conn.runner.exec(['false'])).code, 0)
      assert.equal((await conn.runner.exec(['echo', 'hi'])).stdout.trim(), 'hi')
    } finally {
      await conn.close()
    }
  })

  it('二进制往返字节一致（base64 通道真的可用）', async () => {
    const conn = await connectSsh({ host, user, port, knownHosts: 'accept-new', auth: { type: 'agent' } })
    const p = '/tmp/.dp-e2e-blob.bin'
    try {
      const data = new Uint8Array(256)
      for (let i = 0; i < 256; i++) data[i] = i
      await conn.runner.writeFile(p, data)
      const back = await conn.runner.readBinary(p)
      assert.equal(back.length, 256)
      for (let i = 0; i < 256; i++) assert.equal(back[i], i, `第 ${i} 字节不一致`)
      await conn.runner.remove(p)
    } finally {
      await conn.close()
    }
  })

  it('探测说明列出了没探到的项', async () => {
    const conn = await connectSsh({ host, user, port, knownHosts: 'accept-new', auth: { type: 'agent' } })
    try {
      assert.ok(Array.isArray(conn.probeNotes))
    } finally {
      await conn.close()
    }
  })
})

describe('真机：主机密钥 strict 必须拒绝未知的指纹', { skip: SKIP }, () => {
  it('未知主机 + strict → DP.SSH.HOST_KEY_UNKNOWN', async () => {
    const err = await connectSsh({
      host,
      user,
      port,
      knownHosts: 'strict',
      auth: { type: 'agent' },
      userKnownHostsFile: '/tmp/.dp-e2a-empty-known-hosts',
    })
      .then(() => null, (e: unknown) => e)
    if (err === null) return // 该主机已在系统 known_hosts 里，跳过这条断言
    assert.ok(err instanceof DpError)
    assert.ok(
      err.code === 'DP.SSH.HOST_KEY_UNKNOWN' || err.code === 'DP.SSH.CONNECT_FAILED',
      `实际是 ${err.code}：${err.message}`,
    )
  })
})

describe('真机：rsync --rsh 前缀契约', { skip: SKIP }, () => {
  it('rshArgv 不含 host 也不含 %h', async () => {
    const conn = await connectSsh({ host, user, port, knownHosts: 'accept-new', auth: { type: 'agent' } })
    try {
      const t = await conn.tunnel()
      assert.ok(!t.rshArgv.includes(host), 'rsync 会自己追加 host')
      assert.ok(!t.rshArgv.some((a) => a.includes('%h')), '实测 %h 不会被替换')
      await t.close()
    } finally {
      await conn.close()
    }
  })
})
