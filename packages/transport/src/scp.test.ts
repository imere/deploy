/**
 * scp 计划与执行。
 *
 * 重点：scp 是最后手段，它**明确拒绝**两件它做不到的事（--delete、远端提权），
 * 而不是静默忽略 —— 静默忽略会让用户以为远端被清干净了。
 * 分组与 rsync 同理：多源一目的只保 basename，嵌套条目必须各用自己的目的目录。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ERR, DpError } from '@dp/ports'
import { buildScpPlan, runScpPlan } from './scp.js'
import { fakeSpawn } from './fake-spawn.js'
import type { ScpPlan } from './scp.js'
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

describe('buildScpPlan', () => {
  test('递归 + 保留时间戳 + 强制传统协议 -O', () => {
    const argv = buildScpPlan(req, opts).argvs[0]!
    assert.equal(argv[0], '/usr/bin/scp')
    assert.ok(argv.includes('-r'))
    assert.ok(argv.includes('-p'))
    // OpenSSH 9+ 的 scp 默认走 sftp，显式 -O 让行为确定
    assert.ok(argv.includes('-O'))
  })

  test('argv-only 不经过 shell：没有 --delete，也没有任何 shell 元字符', () => {
    const argv = buildScpPlan(req, opts).argvs[0]!
    assert.ok(!argv.includes('--delete'))
    assert.ok(!argv.some((a) => a.includes(';') || a.includes('&&') || a.includes('|') || a.includes('`')))
  })

  test('端口是大写 -P，且与自己的 -p（保留时间戳）不冲突', () => {
    const argv = buildScpPlan(req, { ...opts, rsh: { ...opts.rsh, port: 2222 } }).argvs[0]!
    assert.ok(argv.includes('-p'), '-p 是保留时间戳，照旧要带')
    assert.ok(argv.includes('-P'), 'ssh 的 -p 端口必须改写成 -P')
    // 照搬 ssh 的 `-p 2222`：scp 的 -p 不带参数，2222 会被当成一个源文件名
    assert.equal(argv[argv.indexOf('-P') + 1], '2222')
  })

  test('不带 -T：那是「关掉远端文件名校验」，我们没有理由关它', () => {
    assert.ok(!buildScpPlan(req, opts).argvs[0]!.includes('-T'))
  })

  test('嵌套条目按父目录分组，目的目录各自带自己的父链', () => {
    const plan = buildScpPlan(req, opts)
    assert.equal(plan.argvs.length, 2)
    assert.equal(plan.argvs[0]!.at(-1), 'dp-user@dp-target:/srv/www/current/')
    assert.equal(plan.argvs[1]!.at(-1), 'dp-user@dp-target:/srv/www/current/assets/')
    assert.deepEqual([...plan.remoteDirs], ['/srv/www/current/assets'])
    assert.equal(plan.mkdirArgv?.at(-1), 'mkdir -p /srv/www/current/assets')
  })

  test('平铺清单只有一组，且不出现 mkdirArgv 这个键', () => {
    const plan = buildScpPlan({ ...req, entries: ['index.html'] }, opts)
    assert.equal(plan.argvs.length, 1)
    assert.equal('mkdirArgv' in plan, false)
  })

  test('远端目标 path 走 quoteArg', () => {
    const plan = buildScpPlan({ ...req, remoteRoot: '/srv/my app' }, opts)
    assert.equal(plan.argvs[0]!.at(-1), "dp-user@dp-target:'/srv/my app/'")
  })

  test('deleteExtraneous → 显式拒绝（scp 没这个能力）', () => {
    assert.throws(
      () => buildScpPlan({ ...req, deleteExtraneous: true }, opts),
      (err: unknown) => err instanceof DpError && err.code === ERR.PREF.UNSUPPORTED,
    )
  })

  test('带 become → 显式拒绝并指向 rsync/tar 的等价做法', () => {
    assert.throws(
      () => buildScpPlan({ ...req, become: { type: 'sudo' } }, opts),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.match(err.hint ?? '', /--rsync-path/)
        return true
      },
    )
  })

  test('空源 → DP.SOURCE.EMPTY', () => {
    assert.throws(
      () => buildScpPlan({ ...req, entries: [] }, opts),
      (err: unknown) => err instanceof DpError && err.code === ERR.SOURCE.EMPTY,
    )
  })
})

describe('runScpPlan', () => {
  const simple: ScpPlan = { argvs: [['/usr/bin/scp', '-r']], remoteDirs: [] }

  test('成功 → 带上"最后手段"warning', async () => {
    const fake = fakeSpawn({ exitCode: 0 })
    const result = await runScpPlan(simple, { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(result.kind, 'scp')
    assert.ok(result.warnings.some((w) => w.includes('最后手段')))
    assert.deepEqual([...result.command], ['/usr/bin/scp', '-r'])
  })

  test('dry-run 不起进程：scp 没有服务端干跑，塞一个它不认识的选项等于必失败的真跑', async () => {
    const fake = fakeSpawn({ exitCode: 0 })
    const result = await runScpPlan(simple, { spawnImpl: fake.impl, timeoutMs: 5000, dryRun: true })
    assert.equal(fake.count(), 0)
    assert.equal(result.filesTransferred, 0)
    assert.equal(result.dryRun, true)
    assert.ok(result.warnings.some((w) => w.includes('没被验证')))
  })

  test('mkdir 前奏先建嵌套目录，失败 → DP.PATH.NOT_WRITABLE 且不再起 scp', async () => {
    const fake = fakeSpawn({ exitCode: 1, stderr: 'mkdir: permission denied' })
    const plan: ScpPlan = {
      argvs: [['/usr/bin/scp', '-r']],
      remoteDirs: ['/srv/www/current/assets'],
      mkdirArgv: ['/usr/bin/ssh', 'dp-user@dp-target', 'mkdir -p /srv/www/current/assets'],
    }
    await assert.rejects(
      () => runScpPlan(plan, { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => err instanceof DpError && err.code === ERR.PATH.NOT_WRITABLE,
    )
    assert.equal(fake.count(), 1)
    assert.equal(fake.records[0]!.file, '/usr/bin/ssh')
  })

  test('255 → DP.SSH.CONNECT_FAILED', async () => {
    const fake = fakeSpawn({ exitCode: 255, stderr: 'ssh: connect to host dp-target: No route to host' })
    await assert.rejects(
      () => runScpPlan(simple, { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => err instanceof DpError && err.code === ERR.SSH.CONNECT_FAILED,
    )
  })

  test('目标不存在 → DP.PATH.NOT_WRITABLE', async () => {
    const fake = fakeSpawn({ exitCode: 1, stderr: '/srv/www/current: No such file or directory' })
    await assert.rejects(
      () => runScpPlan(simple, { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => err instanceof DpError && err.code === ERR.PATH.NOT_WRITABLE,
    )
  })

  test('超时 → 杀进程树', async () => {
    const fake = fakeSpawn({ autoClose: false })
    await assert.rejects(
      () => runScpPlan(simple, { spawnImpl: fake.impl, timeoutMs: 20 }),
      (err: unknown) => err instanceof DpError && err.code === ERR.TIMEOUT.EXEC,
    )
    assert.deepEqual([...fake.records[0]!.killed], ['SIGKILL'])
  })
})
