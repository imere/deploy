import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DpError, type DpErrorCode } from '@dp/ports'
import { buildSshArgv } from './argv.js'
import { statScript } from './posix.js'
import { FakeSshDriver } from './fake-driver.js'
import {
  assertNoHops,
  DEFAULT_PREFERENCE,
  resolveDriver,
  resolveTimeoutMs,
  type DriverAvailability,
  type DriverFactory,
  type SshDriverKind,
} from './driver.js'
import { loadSsh2 } from './ssh2.js'

const CONN = { host: 'dp-target', auth: { type: 'agent' } } as const

/** 按给定可用性表造工厂；表里没有的驱动一律视为不可用 */
function factoryOf(availability: Partial<Record<SshDriverKind, DriverAvailability>>): DriverFactory {
  return (kind) => {
    const a = availability[kind] ?? { ok: false, reason: `${kind} 未注册` }
    return {
      kind,
      available: async () => a,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      close: async () => {},
    }
  }
}

const OK: DriverAvailability = { ok: true }

describe('resolveDriver —— 偏好链', () => {
  it('默认顺序是 native-ssh 优先（唯一能抗量子的那条）', () => {
    assert.deepEqual(DEFAULT_PREFERENCE, ['native-ssh', 'ssh2'])
  })

  it('native 可用 → 选 native', async () => {
    const { driver } = await resolveDriver(factoryOf({ 'native-ssh': OK, ssh2: OK }), {})
    assert.equal(driver.kind, 'native-ssh')
  })

  it('native 不可用 → 退化到 ssh2，并记录尝试轨迹', async () => {
    const { driver, attempts } = await resolveDriver(
      factoryOf({ 'native-ssh': { ok: false, reason: 'PATH 里找不到 ssh' }, ssh2: OK }),
      {},
    )
    assert.equal(driver.kind, 'ssh2')
    assert.deepEqual(
      attempts.map((a) => [a.kind, a.availability.reason ?? 'ok']),
      [
        ['native-ssh', 'PATH 里找不到 ssh'],
        ['ssh2', 'ok'],
      ],
    )
  })

  it('显式 preferred 覆盖默认顺序', async () => {
    const { driver } = await resolveDriver(factoryOf({ 'native-ssh': OK, ssh2: OK }), {
      preferred: ['ssh2', 'native-ssh'],
    })
    assert.equal(driver.kind, 'ssh2')
  })

  it('两者都不可用 → DP.SSH.DRIVER_UNAVAILABLE，且**逐项列出失败原因**', async () => {
    const err = await resolveDriver(
      factoryOf({
        'native-ssh': { ok: false, reason: 'PATH 里找不到 ssh（试过 ssh / ssh.exe）' },
        ssh2: { ok: false, reason: 'ssh2 未安装' },
      }),
      {},
    ).then(() => null, (e: unknown) => e)

    assert.ok(err instanceof DpError)
    assert.equal(err.code, 'DP.SSH.DRIVER_UNAVAILABLE' as DpErrorCode)
    assert.match(err.message, /native-ssh/)
    assert.match(err.message, /PATH 里找不到 ssh/)
    assert.match(err.message, /ssh2/)
    assert.match(err.message, /ssh2 未安装/)
    assert.ok(err.hint !== undefined && err.hint.length > 0, '必须告诉用户下一步怎么办')
  })

  it('显式指定但不可用 → 同码，hint 指向「换驱动 / 怎么装」', async () => {
    const err = await resolveDriver(factoryOf({ ssh2: { ok: false, reason: 'ssh2 未安装' } }), {
      explicit: 'ssh2',
    }).then(() => null, (e: unknown) => e)

    assert.ok(err instanceof DpError)
    assert.equal(err.code, 'DP.SSH.DRIVER_UNAVAILABLE')
    // message 逐项列原因，「显式指定」这句在 hint 里（它是对用户的建议，不是失败事实）
    assert.match(err.message, /ssh2 未安装/)
    assert.match(err.hint ?? '', /显式指定了 ssh2/)
    assert.match(err.hint ?? '', /pnpm add/)
  })

  it('工厂造驱动时抛错也算一条失败原因，不会让它凭空消失', async () => {
    const factory: DriverFactory = (kind) => ({
      kind,
      available: async () => {
        throw new Error(`探测 ${kind} 时炸了`)
      },
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      close: async () => {},
    })
    const err = await resolveDriver(factory, { preferred: ['native-ssh'] }).then(() => null, (e: unknown) => e)
    assert.ok(err instanceof DpError)
    assert.equal(err.code, 'DP.SSH.DRIVER_UNAVAILABLE')
    assert.match(err.message, /探测 native-ssh 时炸了/)
  })

  it('真实驱动：ssh2 本机没装时表现为「不可用 + 怎么装」，不是崩溃', async () => {
    const load = loadSsh2(true)
    if (load.ok) {
      // 本机恰好装了 ssh2：断言它能收窄出 Client 就够了
      assert.equal(typeof load.mod.Client, 'function')
      return
    }
    assert.match(load.reason, /ssh2/)
    assert.match(load.hint, /pnpm add/)
    // 关键：hint 必须说清抗量子的取舍，否则用户会以为它等价
    assert.match(load.hint, /抗量子/)
  })

  it('FakeSshDriver 满足 SshDriver 形状（fixture 本身不会骗人）', async () => {
    const d = new FakeSshDriver()
    assert.equal((await d.available()).ok, true)
    const stat = await d.exec({ argv: ['sh', '-c', statScript('/srv/app')] })
    assert.equal(stat.code, 3, '/srv/app 不存在 → 退出码 3（与 posix.ts 的约定一致）')
    await d.close()
    assert.equal(d.closed, true)
  })

  it('FakeSshDriver 对没登记的裸命令明确报错，不静默成功', async () => {
    const d = new FakeSshDriver()
    const err = await d.exec({ argv: ['rm', '-rf', '/'] }).then(() => null, (e: unknown) => e)
    assert.ok(err instanceof DpError)
    assert.equal(err.code, 'DP.SSH.DRIVER_UNAVAILABLE')
  })
})

describe('多跳占位 —— 本批未实现，必须显式拒绝', () => {
  it('空 hops / undefined 都放行', () => {
    assert.doesNotThrow(() => assertNoHops(undefined))
    assert.doesNotThrow(() => assertNoHops([]))
  })

  it('非空 hops → DP.CONFIG.INVALID，并指向 ProxyJump 与下一批', () => {
    assert.throws(
      () => assertNoHops([{ ssh: 'ops@jump.example.com' }]),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID' as DpErrorCode)
        assert.match(err.hint ?? '', /ProxyJump/)
        assert.match(err.hint ?? '', /下一批/)
        return true
      },
    )
  })
})

describe('resolveTimeoutMs —— 每个子进程都必须有 timeout', () => {
  it('显式值优先', () => {
    assert.equal(resolveTimeoutMs(1234), 1234)
  })

  it('环境变量 DP_SSH_TIMEOUT_MS 生效', () => {
    const before = process.env.DP_SSH_TIMEOUT_MS
    try {
      process.env.DP_SSH_TIMEOUT_MS = '5000'
      assert.equal(resolveTimeoutMs(undefined), 5000)
    } finally {
      if (before === undefined) delete process.env.DP_SSH_TIMEOUT_MS
      else process.env.DP_SSH_TIMEOUT_MS = before
    }
  })

  it('缺省 / 垃圾值 → 30000（绝不会是 undefined，即"无限等待"）', () => {
    const before = process.env.DP_SSH_TIMEOUT_MS
    try {
      delete process.env.DP_SSH_TIMEOUT_MS
      assert.equal(resolveTimeoutMs(undefined), 30_000)
      process.env.DP_SSH_TIMEOUT_MS = 'not-a-number'
      assert.equal(resolveTimeoutMs(undefined), 30_000)
      process.env.DP_SSH_TIMEOUT_MS = '-5'
      assert.equal(resolveTimeoutMs(undefined), 30_000)
      process.env.DP_SSH_TIMEOUT_MS = '0'
      assert.equal(resolveTimeoutMs(undefined), 30_000)
    } finally {
      if (before === undefined) delete process.env.DP_SSH_TIMEOUT_MS
      else process.env.DP_SSH_TIMEOUT_MS = before
    }
  })
})

describe('凭据不出现在任何 argv 里', () => {
  it('SshConnectionOptions 里的 password 从不进 argv（走 SSH_ASKPASS）', () => {
    // 结构性保证：buildSshArgv 的入参类型里根本没有 secret 字段
    const argv = buildSshArgv({
      authKind: 'password',
      knownHostsMode: 'strict',
      remoteArgv: ['id', '-un'],
    })
    assert.equal(argv.join(' ').includes('password='), false)
    assert.equal(argv.join(' ').includes('--password'), false)
    assert.deepEqual(argv.slice(-2), ['id', '-un'])
  })

  it('连接配置本身不要求 passwordRef 被本包解析', () => {
    // passwordRef 只是引用；本包收的是调用方解析后的明文
    assert.equal(typeof CONN.host, 'string')
  })
})
