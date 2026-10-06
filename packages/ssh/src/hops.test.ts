/**
 * 多跳配置的驱动侧行为。
 *
 * 只覆盖**不需要真 ssh 服务器**的部分：ssh2 驱动在有 hops 时走哪条路径。
 * 链本身怎么串起来的在 hop-chain.test.ts（假模块契约），真机端到端在
 * DP_SSH_E2E / DP_SSH_HOP_E2E 打开时才跑。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { Ssh2Driver } from './ssh2.js'
import type { Ssh2ChannelLike, Ssh2ClientLike, Ssh2Load } from './ssh2-module.js'
import { validateHops, type SshConnectionOptions } from './driver.js'

function options(hops: SshConnectionOptions['hops']): SshConnectionOptions {
  return { host: '10.0.0.7', auth: { type: 'agent' }, hops }
}

/**
 * 一个「第一跳能连上、之后所有转发都被拒」的假 ssh2。
 *
 * 用它而不是真 ssh2 是为了断言**路径**：多跳时驱动必须去建链（于是报
 * HOP_FAILED），而不是像以前那样在入口就报「不支持多跳」。
 */
const moduleFwdDenied: Ssh2Load = {
  ok: true,
  mod: {
    Client: class implements Ssh2ClientLike {
      private ready: (() => void) | undefined
      on(event: string, handler: () => void): unknown {
        if (event === 'ready') this.ready = handler
        return this
      }
      connect(): void {
        queueMicrotask(() => this.ready?.())
      }
      forwardOut(
        _srcHost: string,
        _srcPort: number,
        _dstHost: string,
        _dstPort: number,
        callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void,
      ): void {
        callback(new Error('administratively prohibited: open failed'), undefined as never)
      }
      exec(): void {}
      sftp(): void {}
      end(): void {}
    },
  },
}

describe('ssh2 + hops —— 走链，不再是入口就拒绝', () => {
  it('exec 会去建链，被拒时报 HOP_FAILED（不是"不支持多跳"）', async () => {
    const driver = new Ssh2Driver(
      options([
        { ssh: 'ops@jump.example.com', auth: { type: 'agent' } },
        { ssh: 'ops@inner.example.com', auth: { type: 'agent' } },
      ]),
      { load: () => moduleFwdDenied },
    )
    await assert.rejects(
      () => driver.exec({ argv: ['true'] }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SSH.HOP_FAILED')
        assert.equal(err.path, 'hosts.*.ssh.hops[1]')
        return true
      },
    )
  })

  it('隧道入口明确说「多跳隧道未实现」并指向 native-ssh', async () => {
    const driver = new Ssh2Driver(options([{ ssh: 'ops@jump.example.com' }]))
    await assert.rejects(
      () => driver.openTunnel(),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SSH.TUNNEL_FAILED')
        assert.match(err.message, /多跳隧道未实现/)
        assert.match(err.hint ?? '', /native-ssh/)
        return true
      },
    )
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
