/**
 * `--rsh` argv 的契约测试。
 *
 * 核心断言只有一句：**rsync 会追加的那半截（`-l user` / host / `rsync --server`）
 * 一个都不许出现在我们的 argv 里**。写上去就是"连错两次"（spikes.md S5）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'
import { buildRshArgv, rshValueForRsync, DEFAULT_CONNECT_TIMEOUT_SEC } from './rsh.js'

const base = {
  sshPath: '/usr/bin/ssh',
  authKind: 'key' as const,
  knownHostsMode: 'strict' as const,
}

/** rsync 追加的部分（S5 实测样本形态）——用来断言我们没有提前生产它 */
const RSYNC_APPENDED = ['-l', 'user', 'dp-target', 'rsync', '--server']

describe('buildRshArgv · 基本形状', () => {
  test('不含主机名，也不含 rsync --server 那半截', () => {
    const argv = buildRshArgv({ ...base, port: 2222, identityFile: '/keys/id_ed25519' })
    assert.equal(argv[0], '/usr/bin/ssh')
    for (const forbidden of RSYNC_APPENDED) {
      assert.ok(!argv.includes(forbidden), `argv 不应包含 ${forbidden}（那是 rsync 自己追加的）`)
    }
    assert.ok(!argv.includes('--server'))
    assert.ok(!argv.some((a) => a === 'rsync'))
  })

  test('%h 不会被 rsync 替换：无跳板时 argv 里根本不该出现 %h', () => {
    const argv = buildRshArgv({ ...base })
    assert.ok(!argv.some((a) => a.includes('%h')), '无跳板时不该有任何 %h')
  })

  test('key 认证带 BatchMode=yes + NumberOfPasswordPrompts=0 + IdentitiesOnly=yes', () => {
    const argv = buildRshArgv({ ...base, identityFile: '/keys/id_ed25519' })
    assert.ok(argv.includes('BatchMode=yes'))
    assert.ok(argv.includes('NumberOfPasswordPrompts=0'))
    assert.ok(argv.includes('IdentitiesOnly=yes'))
  })

  test('agent 认证也带 BatchMode=yes，但不声称 IdentitiesOnly', () => {
    const argv = buildRshArgv({ ...base, authKind: 'agent' })
    assert.ok(argv.includes('BatchMode=yes'))
    assert.ok(!argv.includes('IdentitiesOnly=yes'))
  })

  test('ConnectTimeout 缺省存在且可覆盖', () => {
    assert.ok(buildRshArgv({ ...base }).includes(`ConnectTimeout=${DEFAULT_CONNECT_TIMEOUT_SEC}`))
    assert.ok(buildRshArgv({ ...base, connectTimeoutSec: 7 }).includes('ConnectTimeout=7'))
  })

  test('主机密钥策略逐档映射，默认 strict', () => {
    assert.ok(buildRshArgv({ ...base }).includes('StrictHostKeyChecking=yes'))
    assert.ok(
      buildRshArgv({ ...base, knownHostsMode: 'accept-new' }).includes('StrictHostKeyChecking=accept-new'),
    )
  })

  test('端口与 identityFile 走 ssh 自己的选项', () => {
    const argv = buildRshArgv({ ...base, port: 2222, identityFile: '/keys/id' })
    assert.equal(argv[argv.indexOf('-p') + 1], '2222')
    assert.equal(argv[argv.indexOf('-i') + 1], '/keys/id')
  })
})

describe('buildRshArgv · 多跳', () => {
  test('默认用 -J，多跳用逗号连接', () => {
    const argv = buildRshArgv({ ...base, hops: ['jump1@host1', 'jump2@host2'] })
    const idx = argv.indexOf('ProxyJump=jump1@host1,jump2@host2')
    assert.ok(idx !== -1, '应为 ProxyJump=（OpenSSH 的 -J 在 argv 里是 -o ProxyJump）')
  })

  test('ProxyCommand 形态带 %h:%p —— 这个 %h 由 ssh 替换，不是 rsync', () => {
    const argv = buildRshArgv({ ...base, hops: ['jump@host'], hopMode: 'proxy-command-w' })
    const pc = argv.find((a) => a.startsWith('ProxyCommand='))
    assert.ok(pc !== undefined)
    assert.match(pc, /-W %h:%p/)
  })

  test('nc 形态：跳板禁 TCP 转发时的退路（spikes.md S4）', () => {
    const argv = buildRshArgv({ ...base, hops: ['jump@host'], hopMode: 'proxy-command-nc' })
    const pc = argv.find((a) => a.startsWith('ProxyCommand='))
    assert.ok(pc !== undefined)
    assert.match(pc, /nc %h %p/)
  })

  test('ProxyCommand 形态只支持一跳 —— 多跳链会构造出错误的转发', () => {
    assert.throws(
      () => buildRshArgv({ ...base, hops: ['a@h1', 'b@h2'], hopMode: 'proxy-command-w' }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        return true
      },
    )
  })

  test('跳板标识含空白 → 拒绝（歧义靠拒绝）', () => {
    assert.throws(
      () => buildRshArgv({ ...base, hops: ['jump@host extra'] }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
    )
  })
})

describe('buildRshArgv · 非法输入', () => {
  test('ConnectTimeout 非正整数 → 拒绝（不允许 ssh 无限等）', () => {
    for (const bad of [0, -1, 1.5]) {
      assert.throws(
        () => buildRshArgv({ ...base, connectTimeoutSec: bad }),
        (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
        `ConnectTimeout=${bad} 应被拒绝`,
      )
    }
  })
})

describe('rshValueForRsync · rsync 的 -e 空白拆分限制', () => {
  test('-J 形态每个 argv 元素都无空白：拼成字符串后的空白只来自元素之间的分隔', () => {
    const argv = buildRshArgv({ ...base, hops: ['jump@host'] })
    for (const a of argv) {
      assert.ok(!/\s/.test(a), `单个 argv 元素含空白会被 rsync 拆错：${JSON.stringify(a)}`)
    }
    const value = rshValueForRsync(argv)
    assert.match(value, /ProxyJump=jump@host/)
  })

  test('ProxyCommand 形态含空白 → 明确拒绝并给出两条出路', () => {
    assert.throws(
      () => rshValueForRsync(buildRshArgv({ ...base, hops: ['jump@host'], hopMode: 'proxy-command-w' })),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.match(err.hint ?? '', /dp-rsh/)
        return true
      },
    )
  })
})
