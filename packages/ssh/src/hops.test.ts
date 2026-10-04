/**
 * 多跳配置的驱动侧行为。
 *
 * 只覆盖**不需要真 ssh 服务器**的部分：偏好链选中 ssh2 时的拒绝路径。
 * 真机多跳端到端由 e2e 测试在 DP_SSH_E2E=1 时才跑。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { Ssh2Driver } from './ssh2.js'
import { validateHops, type SshConnectionOptions } from './driver.js'

function options(hops: SshConnectionOptions['hops']): SshConnectionOptions {
  return { host: '10.0.0.7', auth: { type: 'agent' }, hops }
}

describe('ssh2 + hops —— 本批明确报错，不许静默按单跳连', () => {
  it('exec 抛 DP.CONFIG.INVALID，并指向 native-ssh', async () => {
    const driver = new Ssh2Driver(options([{ ssh: 'ops@jump.example.com' }]))
    await assert.rejects(
      () => driver.exec({ argv: ['true'] }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.match(err.hint ?? '', /native-ssh/)
        return true
      },
    )
  })

  it('隧道入口同样拒绝（否则会先在这里失败并给出错误方向的提示）', async () => {
    const driver = new Ssh2Driver(options([{ ssh: 'ops@jump.example.com' }]))
    await assert.rejects(() => driver.openTunnel(), { code: 'DP.CONFIG.INVALID' })
  })

  it('没有 hops 时不拦（单跳走 ssh2 是既有行为）', async () => {
    const driver = new Ssh2Driver(options([]))
    await assert.rejects(
      () => driver.exec({ argv: ['true'] }),
      // 走到这里说明没被多跳拦下；缺 ssh2 时是 DRIVER_UNAVAILABLE，这里不依赖本机装没装
      (err: unknown) => !(err instanceof DpError) || err.code !== 'DP.CONFIG.INVALID' || !/多跳/.test(err.message),
    )
  })
})

describe('connectSsh 的逐跳校验入口', () => {
  it('非法连接串在选驱动之前就失败（不为注定失败的连接买单）', () => {
    assert.throws(() => validateHops([{ ssh: 'ops@' }]), { code: 'DP.CONFIG.INVALID' })
  })
})
