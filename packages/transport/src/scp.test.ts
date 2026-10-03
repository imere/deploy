/**
 * scp argv 与执行。
 *
 * 重点：scp 是最后手段，它**明确拒绝**两件它做不到的事（--delete、远端提权），
 * 而不是静默忽略 —— 静默忽略会让用户以为远端被清干净了。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'
import { buildScpArgv, runScp } from './scp.js'
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
  scpPath: '/usr/bin/scp',
  rsh: { sshPath: '/usr/bin/ssh', authKind: 'key' as const, knownHostsMode: 'strict' as const },
  remoteTarget: 'dp-user@dp-target',
}

describe('buildScpArgv', () => {
  test('递归 + 保留时间戳 + 强制传统协议 -O', () => {
    const argv = buildScpArgv(req, opts)
    assert.equal(argv[0], '/usr/bin/scp')
    assert.ok(argv.includes('-r'))
    assert.ok(argv.includes('-p'))
    // OpenSSH 9+ 的 scp 默认走 sftp，显式 -O 让行为确定
    assert.ok(argv.includes('-O'))
  })

  test('不含 --delete / -rsh 之外的怪东西，argv-only 不经过 shell', () => {
    const argv = buildScpArgv(req, opts)
    assert.ok(!argv.includes('--delete'))
    assert.ok(!argv.some((a) => a.includes(';') || a.includes('&&') || a.includes('|') || a.includes('`')))
  })

  test('远端目标 path 走 quoteArg', () => {
    const argv = buildScpArgv({ ...req, remoteRoot: '/srv/my app' }, opts)
    assert.equal(argv[argv.length - 1], "dp-user@dp-target:'/srv/my app/'")
  })

  test('deleteExtraneous → 显式拒绝（scp 没这个能力）', () => {
    assert.throws(
      () => buildScpArgv({ ...req, deleteExtraneous: true }, opts),
      (err: unknown) => err instanceof DpError && err.code === 'DP.PREF.UNSUPPORTED',
    )
  })

  test('带 become → 显式拒绝并指向 rsync/tar 的等价做法', () => {
    assert.throws(
      () => buildScpArgv({ ...req, become: { type: 'sudo' } }, opts),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.match(err.hint ?? '', /--rsync-path/)
        return true
      },
    )
  })

  test('空源 → DP.SOURCE.EMPTY', () => {
    assert.throws(
      () => buildScpArgv({ ...req, entries: [] }, opts),
      (err: unknown) => err instanceof DpError && err.code === 'DP.SOURCE.EMPTY',
    )
  })

  test('每个源条目一个独立 argv', () => {
    const argv = buildScpArgv(req, opts)
    assert.ok(argv.includes('/work/dist/index.html'))
    assert.ok(argv.includes('/work/dist/assets/app.js'))
  })
})

describe('runScp', () => {
  test('成功 → 带上"最后手段"warning', async () => {
    const fake = fakeSpawn({ exitCode: 0 })
    const result = await runScp(['/usr/bin/scp', '-r'], { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(result.kind, 'scp')
    assert.ok(result.warnings.some((w) => w.includes('最后手段')))
  })

  test('255 → DP.SSH.CONNECT_FAILED', async () => {
    const fake = fakeSpawn({ exitCode: 255, stderr: 'ssh: connect to host dp-target: No route to host' })
    await assert.rejects(
      () => runScp(['/usr/bin/scp'], { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.SSH.CONNECT_FAILED',
    )
  })

  test('目标不存在 → DP.PATH.NOT_WRITABLE', async () => {
    const fake = fakeSpawn({ exitCode: 1, stderr: '/srv/www/current: No such file or directory' })
    await assert.rejects(
      () => runScp(['/usr/bin/scp'], { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.PATH.NOT_WRITABLE',
    )
  })

  test('超时 → 杀进程树', async () => {
    const fake = fakeSpawn({ autoClose: false })
    await assert.rejects(
      () => runScp(['/usr/bin/scp'], { spawnImpl: fake.impl, timeoutMs: 20 }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.TIMEOUT.EXEC',
    )
    assert.deepEqual([...fake.records[0]!.killed], ['SIGKILL'])
  })
})

describe('真机集成（默认跳过）', () => {
  describe('scp over ssh 真实传输', { skip: '需要真实 scp 与目标机' }, () => {
    test('文件落到目标上', () => {
      assert.fail('需要 dp-spike-env 起靶机后手工启用')
    })
  })
})
