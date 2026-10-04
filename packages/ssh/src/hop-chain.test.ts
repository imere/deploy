/**
 * 多跳的两类验证，分开是因为它们证明的东西根本不同：
 *
 *  ① `planHopChain` 是纯函数，「连到了另一台机器」这类错误必须在碰网络之前
 *     就被判掉，所以它的每条规则都能用夹具钉死。
 *  ② 链**是不是真串起来**只能靠假模块看调用关系 —— 尤其是 `sock` 必须就是
 *     上一跳 forwardOut 返回的那个对象。这一条不验，链看起来建好了，实际
 *     每一跳都在直连，测试照样全绿。
 *
 * 真机多跳（两台以上机器 + 跳板的 direct-tcpip）在 DP_SSH_HOP_E2E=1 时才跑。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { planHopChain } from './hop-chain.js'
import { openHopChain } from './ssh2-hops.js'
import type { Ssh2ChannelLike, Ssh2ClientLike, Ssh2Load, Ssh2ModuleLike } from './ssh2.js'
import type { HopSpec, SshConnectionOptions } from './driver.js'

// ------------------------------------------------------------
// 假 ssh2 模块
// ------------------------------------------------------------

class FakeChannel implements Ssh2ChannelLike {
  constructor(readonly label: string) {}
  on(): unknown {
    return this
  }
}

class FakeClient implements Ssh2ClientLike {
  ended = false
  private ready: (() => void) | undefined

  constructor(
    private readonly world: FakeWorld,
    readonly label: string,
  ) {
    world.clients.push(this)
  }

  on(event: string, handler: () => void): unknown {
    if (event === 'ready') this.ready = handler
    return this
  }

  connect(config: Readonly<Record<string, unknown>>): void {
    this.world.connects.push({ client: this, config })
    // 微任务而不是同步：真实 ssh2 也是异步就绪，同步回调会掩盖
    // "先注册 ready 再 connect" 这个顺序依赖
    queueMicrotask(() => this.ready?.())
  }

  forwardOut(
    srcHost: string,
    srcPort: number,
    dstHost: string,
    dstPort: number,
    callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void,
  ): void {
    this.world.forwards.push({ client: this, srcHost, srcPort, dstHost, dstPort })
    // 拒绝表按 FQDN 写（'b.example.com'），也认裸标签（'b'）——
    // 夹具里的连接串常常只写裸标签，两种都能命中，改主机名时不必改拒绝表
    const denied =
      this.world.forwardFailsFor.has(dstHost) || this.world.forwardFailsFor.has(dstHost.split('.')[0] ?? dstHost)
    if (denied) {
      callback(new Error(`administratively prohibited: open failed (${dstHost})`), undefined as never)
      return
    }
    callback(undefined, this.world.channel(`${this.label}->${dstHost}`))
  }

  exec(
    command: string,
    _options: Readonly<Record<string, unknown>>,
    callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void,
  ): void {
    this.world.execs.push({ client: this, command })
    callback(undefined, this.world.channel(`nc:${this.label}`))
  }

  sftp(): void {
    throw new Error('本测试不涉及 sftp')
  }

  end(): void {
    this.ended = true
  }
}

interface ConnectCall {
  readonly client: FakeClient
  readonly config: Readonly<Record<string, unknown>>
}
interface ForwardCall {
  readonly client: FakeClient
  readonly srcHost: string
  readonly srcPort: number
  readonly dstHost: string
  readonly dstPort: number
}
interface ExecCall {
  readonly client: FakeClient
  readonly command: string
}
interface FakeWorld {
  module: Ssh2Load
  readonly connects: ConnectCall[]
  readonly forwards: ForwardCall[]
  readonly execs: ExecCall[]
  readonly clients: FakeClient[]
  /** 这些 dstHost 的 forwardOut 一律失败（模拟 AllowTcpForwarding no） */
  readonly forwardFailsFor: Set<string>
  readonly channels: FakeChannel[]
  channel(label: string): FakeChannel
  /** 换掉 Client 构造器（用来制造"永远不 ready"） */
  freezeConnect(): void
}

function fakeWorld(forwardFailsFor: readonly string[] = []): FakeWorld {
  const channels: FakeChannel[] = []
  const clients: FakeClient[] = []
  let freeze = false
  const world: FakeWorld = {
    module: { ok: false, reason: '未初始化', hint: '' },
    connects: [],
    forwards: [],
    execs: [],
    clients,
    // 拒绝表两种形态都存：'b.example.com' 与它的裸标签 'b'。
    // 夹具里的连接串常常只写裸标签，两边归一后才不会漏判
    forwardFailsFor: new Set(forwardFailsFor.flatMap((h) => [h, h.split('.')[0] ?? h])),
    channels,
    channel: (label) => {
      const c = new FakeChannel(label)
      channels.push(c)
      return c
    },
    freezeConnect: () => {
      freeze = true
    },
  }

  class Client extends FakeClient {
    // ssh2 是 `new Client()`，不带参数：label 与 world 只能在这里补
    constructor() {
      super(world, `c${world.clients.length}`)
    }
    override connect(config: Readonly<Record<string, unknown>>): void {
      if (freeze) {
        // 记录下"发出了 connect 但永远不 ready"，超时断言要看它
        world.connects.push({ client: this, config })
        return
      }
      super.connect(config)
    }
  }
  const mod: Ssh2ModuleLike = { Client: Client as unknown as new () => Ssh2ClientLike }
  world.module = { ok: true, mod }
  return world
}

const options = (over: Partial<SshConnectionOptions> = {}): SshConnectionOptions => ({
  host: 'leaf.example.com',
  auth: { type: 'agent' },
  ...over,
})

const hop = (ssh: string, auth?: HopSpec['auth'], port?: number): HopSpec => ({
  ssh,
  ...(auth === undefined ? {} : { auth }),
  ...(port === undefined ? {} : { port }),
})

// ------------------------------------------------------------
// ① 纯函数
// ------------------------------------------------------------

describe('planHopChain —— 形状与报错', () => {
  it('单跳恒为 direct，端口不写就不补 22', () => {
    const plan = planHopChain([hop('ops@jump.example.com', { type: 'agent' })])
    assert.equal(plan.length, 1)
    assert.equal(plan[0]!.via, 'direct')
    assert.equal(plan[0]!.index, 0)
    assert.equal(plan[0]!.host, 'jump.example.com')
    assert.equal(plan[0]!.user, 'ops')
    assert.equal(plan[0]!.port, undefined, '补 22 会盖掉用户在 ssh_config 里配的 Port')
  })

  it('第 2 跳起是 forwardOut，端口与认证逐跳独立', () => {
    const plan = planHopChain([
      hop('ops@a.example.com', { type: 'agent' }),
      hop('root@b.example.com:2222', { type: 'key', identityFile: '/k/id' }),
    ])
    assert.equal(plan[1]!.via, 'forwardOut')
    assert.equal(plan[1]!.port, 2222)
    assert.deepEqual(plan[1]!.auth, { type: 'key', identityFile: '/k/id' })
  })

  it('port 字段与连接串里的端口一致时只用一份', () => {
    const plan = planHopChain([hop('ops@a.example.com:2200', { type: 'agent' }, 2200)])
    assert.equal(plan[0]!.port, 2200)
  })

  it('0 跳报错而不是返回空数组（空数组会被调用方当成"不需要跳板"）', () => {
    assert.throws(() => planHopChain([]), (err: unknown) => {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.CONFIG.INVALID')
      assert.equal(err.path, 'hosts.*.ssh.hops')
      return true
    })
  })

  it('连接串与 port 字段矛盾时拒绝，指出是哪一跳', () => {
    assert.throws(
      () => planHopChain([hop('ops@a', { type: 'agent' }), hop('ops@b:22', { type: 'agent' }, 2222)]),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.equal(err.path, 'hosts.*.ssh.hops[1].port')
        assert.match(err.message, /第 1 跳/)
        return true
      },
    )
  })

  it('缺认证要说第几跳，路径能直接定位', () => {
    assert.throws(
      () => planHopChain([hop('ops@a', { type: 'agent' }), hop('ops@b')]),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.equal(err.path, 'hosts.*.ssh.hops[1].auth')
        assert.match(err.message, /第 1 跳/)
        return true
      },
    )
  })

  it('非法连接串 / 非法端口在计划期就被拒', () => {
    assert.throws(() => planHopChain([hop('ops@', { type: 'agent' })]), { code: 'DP.CONFIG.INVALID' })
    assert.throws(() => planHopChain([hop('ops@a', { type: 'agent' }, 70000)]), {
      code: 'DP.CONFIG.INVALID',
    })
  })

  it('allowNc 打开时计划也不选 nc —— 手段能不能用只有真跑一次才知道', () => {
    const plan = planHopChain([hop('ops@a', { type: 'agent' }), hop('ops@b', { type: 'agent' })], {
      allowNc: true,
    })
    assert.deepEqual(
      plan.map((s) => s.via),
      ['direct', 'forwardOut'],
    )
  })
})

// ------------------------------------------------------------
// ② 假模块契约
// ------------------------------------------------------------

describe('openHopChain —— 链真的串起来了吗', () => {
  it('三跳：forwardOut 调 2 次，每次的目标就是下一跳', async () => {
    const world = fakeWorld()
    const chain = await openHopChain(
      [
        hop('ops@a.example.com', { type: 'agent' }),
        hop('ops@b.example.com', { type: 'agent' }, 2200),
        hop('ops@c.example.com', { type: 'agent' }),
      ],
      options(),
      { load: () => world.module, timeoutMs: 2000 },
    )
    assert.equal(chain.clients.length, 3)
    assert.equal(world.forwards.length, 2)
    assert.deepEqual(
      world.forwards.map((f) => [f.client.label, f.dstHost, f.dstPort, f.srcPort]),
      [
        ['c0', 'b.example.com', 2200, 0],
        ['c1', 'c.example.com', 22, 0],
      ],
      'forwardOut 必须从**前一跳**发起，目标与端口就是下一跳；srcPort 必须是 0',
    )
    assert.equal((chain.leaf as FakeClient).label, 'c2', 'leaf 是最后一跳：exec 打在它上面')
    await chain.close()
  })

  it('第 2 跳收到的 sock 就是第 1 跳 forwardOut 返回的那个 channel（不验这条，链可能全是直连）', async () => {
    const world = fakeWorld()
    const chain = await openHopChain(
      [hop('ops@a', { type: 'agent' }), hop('ops@b', { type: 'agent' })],
      options(),
      { load: () => world.module, timeoutMs: 2000 },
    )
    const second = world.connects[1]!
    assert.ok('sock' in second.config, '第 2 跳必须走 channel，不能带 host/port 直连')
    assert.equal('host' in second.config, false)
    const fwd = world.forwards[0]!
    assert.equal(second.config.sock, world.channels.find((c) => c.label === `${fwd.client.label}->b`))
    await chain.close()
  })

  it('第 0 跳直连：没有 sock，带 host/port', async () => {
    const world = fakeWorld()
    const chain = await openHopChain([hop('ops@a.example.com', { type: 'agent' })], options(), {
      load: () => world.module,
      timeoutMs: 2000,
    })
    assert.equal('sock' in world.connects[0]!.config, false)
    assert.equal(world.connects[0]!.config.host, 'a.example.com')
    await chain.close()
  })

  it('每一跳的凭据独立：跳板走密钥、目标机走密码，两份 connect 配置不同', async () => {
    const world = fakeWorld()
    const chain = await openHopChain(
      [
        hop('ops@a', { type: 'key', identityFile: '/keys/jump' }),
        hop('root@b', { type: 'password', passwordRef: 'env:DP_T' }),
      ],
      options({ secrets: { password: 'leaf-secret' } }),
      { load: () => world.module, timeoutMs: 2000 },
    )
    assert.equal(world.connects[0]!.config.privateKey, '/keys/jump')
    assert.equal('password' in world.connects[0]!.config, false, '跳板不得继承目标机的密码')
    assert.equal(world.connects[1]!.config.password, 'leaf-secret')
    assert.equal('privateKey' in world.connects[1]!.config, false)
    await chain.close()
  })

  it('中间跳的凭据走 hopSecrets，不吃 opts.secrets', async () => {
    const world = fakeWorld()
    const chain = await openHopChain(
      [
        hop('ops@a', { type: 'password', passwordRef: 'env:DP_J' }),
        hop('ops@b', { type: 'password', passwordRef: 'env:DP_T' }),
        hop('ops@c', { type: 'password', passwordRef: 'env:DP_C' }),
      ],
      options({ secrets: { password: 'leaf-secret' } }),
      {
        load: () => world.module,
        timeoutMs: 2000,
        hopSecrets: [{ password: 'jump-secret' }, { password: 'inner-secret' }, undefined],
      },
    )
    assert.equal(world.connects[0]!.config.password, 'jump-secret')
    assert.equal(world.connects[1]!.config.password, 'inner-secret')
    assert.equal(world.connects[2]!.config.password, 'leaf-secret')
    await chain.close()
  })

  it('forwardOut 被拒且允许 nc 时，在前一跳上 exec nc 并把它的 channel 当 sock', async () => {
    const world = fakeWorld(['b.example.com'])
    const chain = await openHopChain(
      [hop('ops@a', { type: 'agent' }), hop('ops@b', { type: 'agent' })],
      options(),
      { load: () => world.module, timeoutMs: 2000, allowNc: true },
    )
    assert.equal(world.execs.length, 1)
    assert.equal(world.execs[0]!.client.label, 'c0', 'nc 必须在**前一跳**上起')
    assert.equal(world.execs[0]!.command, 'nc -q0 b 22', 'nc 拿到的是这一跳**实际要连**的 host/port')
    assert.equal(world.connects[1]!.config.sock, world.channels.find((c) => c.label === 'nc:c0'))
    await chain.close()
  })

  it('nc 不被允许时绝不悄悄走 nc', async () => {
    const world = fakeWorld(['b.example.com'])
    await assert.rejects(
      () =>
        openHopChain([hop('ops@a', { type: 'agent' }), hop('ops@b', { type: 'agent' })], options(), {
          load: () => world.module,
          timeoutMs: 2000,
        }),
      { code: 'DP.SSH.HOP_FAILED' },
    )
    assert.equal(world.execs.length, 0, '默认不许在跳板上起进程')
  })

  it('两种手段都不通时报错要逐项列出原因（否则没法分辨是禁转发还是没有 nc）', async () => {
    const world = fakeWorld(['b.example.com'])
    // 让 nc 也失败
    class NoNcClient extends FakeClient {
      constructor() {
        super(world, `c${world.clients.length}`)
      }
      override exec(
        _command: string,
        _options: Readonly<Record<string, unknown>>,
        callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void,
      ): void {
        callback(new Error('nc: command not found'), undefined as never)
      }
    }
    world.module = {
      ok: true,
      mod: { Client: NoNcClient as unknown as new () => Ssh2ClientLike },
    }
    await assert.rejects(
      () =>
        openHopChain([hop('ops@a', { type: 'agent' }), hop('ops@b', { type: 'agent' })], options(), {
          load: () => world.module,
          timeoutMs: 2000,
          allowNc: true,
        }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SSH.HOP_FAILED')
        assert.equal(err.path, 'hosts.*.ssh.hops[1]')
        assert.match(err.message, /forwardOut：.*open failed/s)
        assert.match(err.message, /nc：.*command not found/s)
        return true
      },
    )
  })

  it('第 3 跳失败时前两跳都被 end 掉了（不留孤儿会话在跳板机上）', async () => {
    const world = fakeWorld(['c.example.com'])
    await assert.rejects(
      () =>
        openHopChain(
          [hop('ops@a', { type: 'agent' }), hop('ops@b', { type: 'agent' }), hop('ops@c', { type: 'agent' })],
          options(),
          { load: () => world.module, timeoutMs: 2000 },
        ),
      { code: 'DP.SSH.HOP_FAILED' },
    )
    assert.equal(world.clients.length, 2, '第 3 跳的 client 根本不该建起来')
    assert.deepEqual(
      world.clients.map((c) => c.ended),
      [true, true],
    )
  })

  it('超时要报第几跳，不是笼统的"连接超时"', async () => {
    const world = fakeWorld()
    world.freezeConnect()
    await assert.rejects(
      () =>
        openHopChain([hop('ops@a', { type: 'agent' }), hop('ops@b', { type: 'agent' })], options(), {
          load: () => world.module,
          timeoutMs: 30,
        }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SSH.HOP_FAILED')
        assert.equal(err.path, 'hosts.*.ssh.hops[0]')
        assert.match(err.message, /第 0 跳连接超时 30ms/)
        return true
      },
    )
  })

  it('close 逆序且幂等', async () => {
    const world = fakeWorld()
    const chain = await openHopChain(
      [
        hop('ops@a', { type: 'agent' }),
        hop('ops@b', { type: 'agent' }),
        hop('ops@c', { type: 'agent' }),
      ],
      options(),
      { load: () => world.module, timeoutMs: 2000 },
    )
    const endedAt: number[] = []
    world.clients.forEach((c, i) => {
      const orig = c.end.bind(c)
      c.end = () => {
        endedAt.push(i)
        orig()
      }
    })
    await chain.close()
    assert.deepEqual(endedAt, [2, 1, 0], '必须先关最内层')
    await chain.close()
    assert.deepEqual(endedAt, [2, 1, 0], '重复 close 不能再关一次')
  })

  it('ssh2 装不上时报驱动不可用，而不是把链建到一半', async () => {
    await assert.rejects(
      () =>
        openHopChain([hop('ops@a', { type: 'agent' })], options(), {
          load: () => ({ ok: false, reason: 'ssh2 未安装', hint: '装 ssh2' }),
          timeoutMs: 100,
        }),
      { code: 'DP.SSH.DRIVER_UNAVAILABLE' },
    )
  })
})

// ------------------------------------------------------------
// ③ 真机（默认跳过）
// ------------------------------------------------------------

const E2E = process.env.DP_SSH_HOP_E2E === '1'
/** 形如 `ops@jump:2222,ops@inner:22`，逗号分隔，末跳就是目标机 */
const CHAIN = (process.env.DP_SSH_HOP_CHAIN ?? '')
  .split(',')
  .filter((s) => s !== '')

describe('真机：多跳链上 exec', { skip: !E2E || CHAIN.length < 2 }, () => {
  it('穿过整条链建立 N 个连接并逆序关掉', async () => {
    const hops: HopSpec[] = CHAIN.map((s) => ({
      ssh: s,
      auth: { type: 'password', passwordRef: 'env:DP_SSH_PASSWORD' },
    }))
    const chain = await openHopChain(hops, options({ secrets: { password: process.env.DP_SSH_PASSWORD } }), {
      timeoutMs: 15_000,
    })
    try {
      assert.equal(chain.clients.length, CHAIN.length)
    } finally {
      await chain.close()
    }
  })
})
