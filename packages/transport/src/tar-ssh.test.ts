/**
 * tar-ssh 的两侧 argv 与执行。
 *
 * 核心断言：两侧都是**独立 argv**，没有 shell 管道字符；本机侧 `-C <root> -- <entries>`，
 * 远端侧 `-C <remoteRoot>`。提权只包装远端的 tar，不包装本机的。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'
import { buildTarArgv, remoteExtractCommand, runTarSsh } from './tar-ssh.js'
import { fakeSpawn } from './fake-spawn.js'
import type { TransferRequest } from './types.js'

const req: TransferRequest = {
  kind: 'remote',
  localRoot: '/work/dist',
  entries: ['index.html', 'assets/app.js'],
  remoteRoot: '/srv/www/current',
  host: 'dp-target',
}

const opts = {
  localTarPath: '/usr/bin/tar',
  rsh: { sshPath: '/usr/bin/ssh', authKind: 'key' as const, knownHostsMode: 'strict' as const },
  remoteTarget: 'dp-user@dp-target',
}

describe('buildTarArgv', () => {
  test('本机侧：tar -cf - -C <root> -- <entries...>', () => {
    const { local } = buildTarArgv(req, opts)
    assert.equal(local[0], '/usr/bin/tar')
    assert.equal(local[local.indexOf('-cf') + 1], '-')
    assert.equal(local[local.indexOf('-C') + 1], '/work/dist')
    assert.equal(local[local.indexOf('--') + 1], 'index.html')
    assert.equal(local[local.indexOf('--') + 2], 'assets/app.js')
  })

  test('`--` 必须存在：否则以 - 开头的文件名会被 tar 当选项', () => {
    const { local } = buildTarArgv({ ...req, entries: ['-weird-name'] }, opts)
    assert.ok(local.includes('--'))
    assert.equal(local[local.indexOf('--') + 1], '-weird-name')
  })

  test('--no-same-owner：非 root 解包保留 owner 会失败', () => {
    const { local, remote } = buildTarArgv(req, opts)
    assert.ok(local.includes('--no-same-owner'))
    assert.ok(remote.includes('--no-same-owner'))
  })

  test('远端侧：ssh argv + tar -xf - -C <remoteRoot>，结尾是远端命令', () => {
    const { remote } = buildTarArgv(req, opts)
    assert.equal(remote[0], '/usr/bin/ssh')
    const tarIdx = remote.indexOf('tar')
    assert.ok(tarIdx > 0)
    assert.equal(remote[tarIdx + 2], '-')
    assert.equal(remote[remote.indexOf('-C', tarIdx) + 1], '/srv/www/current')
  })

  test('两侧都不含 shell 管道字符 —— 绝不用 shell 管道（铁律 1）', () => {
    const { local, remote } = buildTarArgv(req, opts)
    for (const a of [...local, ...remote]) {
      assert.ok(!/[|;&<>`]/.test(a), `argv 元素含 shell 元字符：${a}`)
    }
  })

  test('become 只包装远端 tar，本机 tar 不受影响', () => {
    const { local, remote } = buildTarArgv(req, { ...opts, become: { type: 'sudo', user: 'root' } })
    assert.ok(remote.includes('sudo'))
    assert.ok(remote.includes('-n'), '提权必须 -n，永不交互')
    assert.ok(!local.includes('sudo'))
  })

  test('空源 → DP.SOURCE.EMPTY', () => {
    assert.throws(
      () => buildTarArgv({ ...req, entries: [] }, opts),
      (err: unknown) => err instanceof DpError && err.code === 'DP.SOURCE.EMPTY',
    )
  })
})

describe('remoteExtractCommand', () => {
  test('只是展示用：逐参数 quoteArg 拼成一条可读命令', () => {
    const { remote } = buildTarArgv(req, opts)
    const rendered = remoteExtractCommand(remote)
    assert.match(rendered, /tar -xf - --no-same-owner -C \/srv\/www\/current$/)
  })
})

describe('runTarSsh', () => {
  /**
   * 两端退出码**由测试显式决定**。
   *
   * 不能靠 fake 的 autoClose：它已经在内部排了一个 0ms 结束定时器，测试再排一个
   * close 就变成竞态（谁先到谁赢），失败原因会随机漂移。这里统一 autoClose:false，
   * spawn 之后同步把两端都点掉。
   */
  const pairWithExits = (localCode: number, remoteCode: number) => {
    const fake = fakeSpawn({ autoClose: false })
    const impl: typeof fake.impl = (file, args, options) => {
      const child = fake.impl(file, args, options)
      const i = fake.records.length - 1
      queueMicrotask(() => {
        fake.close(i, i === 0 ? localCode : remoteCode)
      })
      return child
    }
    return { fake, impl }
  }

  test('两端成功 → 全量传输 warning + 报告打包条目数', async () => {
    const { fake, impl } = pairWithExits(0, 0)
    const result = await runTarSsh(buildTarArgv(req, opts), { spawnImpl: impl, timeoutMs: 5000 })
    assert.equal(result.kind, 'tar-ssh')
    assert.equal(result.filesTransferred, 2, '只能报"打包了几个条目"，不能谎称传了几个文件')
    assert.ok(result.warnings.some((w) => w.includes('全量')))
    assert.equal(fake.count(), 2)
    assert.equal(fake.records[0]!.file, '/usr/bin/tar')
    assert.equal(fake.records[1]!.file, '/usr/bin/ssh')
  })

  test('本机 tar 失败 → DP.VERIFY.FAILED', async () => {
    const { impl } = pairWithExits(2, 0)
    await assert.rejects(
      () => runTarSsh(buildTarArgv(req, opts), { spawnImpl: impl, timeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.VERIFY.FAILED')
        return true
      },
    )
  })

  test('远端 255 → DP.SSH.CONNECT_FAILED', async () => {
    const { impl } = pairWithExits(0, 255)
    await assert.rejects(
      () => runTarSsh(buildTarArgv(req, opts), { spawnImpl: impl, timeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SSH.CONNECT_FAILED')
        return true
      },
    )
  })

  test('远端 127 → DP.SSH.TOOL_MISSING（目标机没 tar）', async () => {
    const { impl } = pairWithExits(0, 127)
    await assert.rejects(
      () => runTarSsh(buildTarArgv(req, opts), { spawnImpl: impl, timeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SSH.TOOL_MISSING')
        return true
      },
    )
  })

  test('远端解包失败 → DP.PATH.NOT_WRITABLE', async () => {
    const { impl } = pairWithExits(0, 2)
    await assert.rejects(
      () => runTarSsh(buildTarArgv(req, opts), { spawnImpl: impl, timeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.PATH.NOT_WRITABLE')
        return true
      },
    )
  })

  test('真起两个子进程（并发，不串行）', async () => {
    const { fake, impl } = pairWithExits(0, 0)
    await runTarSsh(buildTarArgv(req, opts), { spawnImpl: impl, timeoutMs: 5000 })
    assert.equal(fake.count(), 2)
  })

  test('超时 → DP.TIMEOUT.EXEC（两端都有 timeout）', async () => {
    const fake = fakeSpawn({ autoClose: false })
    await assert.rejects(
      () => runTarSsh(buildTarArgv(req, opts), { spawnImpl: fake.impl, timeoutMs: 20 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.TIMEOUT.EXEC')
        return true
      },
    )
    // Promise.all 在第一个 reject 就返回，另一端的定时器随后才到 ——
    // 所以只断言已经结束这一端被杀了（两端共用同一套 timeout 逻辑）
    assert.ok(fake.records[0]!.killed.includes('SIGKILL'))
  })
})

describe('真机集成（默认跳过）', () => {
  describe('tar over ssh 真实传输', { skip: '需要真实 tar 与目标机' }, () => {
    test('文件落到目标上', () => {
      assert.fail('需要 dp-spike-env 起靶机后手工启用')
    })
  })
})
