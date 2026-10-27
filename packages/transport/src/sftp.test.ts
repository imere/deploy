/**
 * sftp 的 argv、批量脚本与执行。
 *
 * 断言的重点是两条别人替不了的：**端口是大写 -P**（scp / sftp 的 -p 是保留时间戳），
 * 以及**批量脚本真的从 stdin 喂进去**（sftp 没有别的入口吃这份脚本）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ERR, DpError } from '@dp/ports'
import { buildSftpPlan, runSftp } from './sftp.js'
import { fakeSpawn } from './fake-spawn.js'
import type { TransferRequest } from './types.js'

const req: TransferRequest = {
  kind: 'remote',
  localRoot: '/work/dist',
  entries: ['index.html', 'assets/app.js'],
  remoteRoot: '/srv/app/releases/2026.incoming',
  host: 'dp-target',
}

const opts = {
  sftpPath: '/usr/bin/sftp',
  rsh: { sshPath: '/usr/bin/ssh', authKind: 'key' as const, knownHostsMode: 'strict' as const },
  remoteTarget: 'dp-user@dp-target',
}

describe('buildSftpPlan · argv', () => {
  test('批量脚本走 stdin，目标标识是末元素', () => {
    const plan = buildSftpPlan(req, opts)
    assert.equal(plan.argv[0], '/usr/bin/sftp')
    assert.deepEqual([...plan.argv.slice(1, 3)], ['-b', '-'])
    assert.equal(plan.argv[plan.argv.length - 1], 'dp-user@dp-target')
  })

  test('端口是大写 -P：scp / sftp 的 -p 是保留时间戳', () => {
    const plan = buildSftpPlan(req, { ...opts, rsh: { ...opts.rsh, port: 2222 } })
    assert.ok(plan.argv.includes('-P'), 'ssh 的 -p 必须改写成 -P')
    assert.equal(plan.argv[plan.argv.indexOf('-P') + 1], '2222')
    // 关键：小写 -p 在 sftp 上是「保留时间戳」，端口混进去会被当成另一个选项
    assert.ok(!plan.argv.includes('-p'))
  })

  test('不带 -T：它在 sftp 上不是合法选项', () => {
    const plan = buildSftpPlan(req, opts)
    assert.ok(!plan.argv.includes('-T'), 'ssh 的 -T（不分配 pty）在 sftp 上没有对应项')
  })

  test('ssh 层的选项照抄（BatchMode / 主机密钥 / 不转发 agent）', () => {
    const plan = buildSftpPlan(req, opts)
    const asString = plan.argv.join(' ')
    assert.match(asString, /BatchMode=yes/)
    assert.match(asString, /StrictHostKeyChecking=yes/)
    assert.match(asString, /ForwardAgent=no/)
    assert.match(asString, /ConnectTimeout=\d+/)
  })
})

describe('buildSftpPlan · 批量脚本', () => {
  test('先建目录再传文件，父目录排在子目录前', () => {
    const plan = buildSftpPlan(req, opts)
    const lines = plan.batch.split('\n').filter((l) => l !== '')
    const mkdirs = lines.filter((l) => l.endsWith('"') && l.startsWith('-mkdir'))
    const puts = lines.filter((l) => l.startsWith('put '))
    assert.equal(puts.length, 2)
    // 目录条：/srv、/srv/app、/srv/app/releases、…/2026.incoming、…/assets
    assert.deepEqual(mkdirs, [
      '-mkdir "/srv"',
      '-mkdir "/srv/app"',
      '-mkdir "/srv/app/releases"',
      '-mkdir "/srv/app/releases/2026.incoming"',
      '-mkdir "/srv/app/releases/2026.incoming/assets"',
    ])
    // 建目录的都在传文件之前：sftp 的 put 不会自己建父目录
    assert.ok(lines.indexOf(mkdirs[mkdirs.length - 1]!) < lines.indexOf(puts[0]!))
    // mkdir 带 `-` 前缀：目录已存在时 sftp 默认会中止整批，而重跑是常态
    assert.ok(mkdirs.every((l) => l.startsWith('-mkdir')))
    assert.ok(puts.every((l) => !l.startsWith('-')), 'put 失败不许被忽略')
  })

  test('每条 put 都给了明确的本地与远端路径', () => {
    const plan = buildSftpPlan(req, opts)
    assert.match(plan.batch, /put "\/work\/dist\/index\.html" "\/srv\/app\/releases\/2026\.incoming\/index\.html"/)
    assert.match(plan.batch, /put "\/work\/dist\/assets\/app\.js" "\/srv\/app\/releases\/2026\.incoming\/assets\/app\.js"/)
  })

  test('脚本显式 quit 收尾，不靠 stdin 到 EOF', () => {
    const plan = buildSftpPlan(req, opts)
    assert.ok(plan.batch.endsWith('quit\n'))
  })

  test('含空格的路径走 sftp 自己的引号（双引号 + 反斜杠）', () => {
    const spaced: TransferRequest = {
      ...req,
      localRoot: '/work/my dist',
      remoteRoot: '/srv/my app',
      entries: ['a b.html'],
    }
    const plan = buildSftpPlan(spaced, opts)
    assert.match(plan.batch, /-mkdir "\/srv\/my app"/)
    assert.match(plan.batch, /put "\/work\/my dist\/a b\.html" "\/srv\/my app\/a b\.html"/)
  })

  test('put 条数等于清单条数 —— 这是文件数的唯一来源', () => {
    assert.equal(buildSftpPlan(req, opts).putCount, 2)
  })
})

describe('buildSftpPlan · 做不到的事明确拒绝', () => {
  test('空源 → DP.SOURCE.EMPTY', () => {
    assert.throws(
      () => buildSftpPlan({ ...req, entries: [] }, opts),
      (err: unknown) => err instanceof DpError && err.code === ERR.SOURCE.EMPTY,
    )
  })

  test('deleteExtraneous → 显式拒绝（要先知道远端多出哪些，而那需要对端递归列目录）', () => {
    assert.throws(
      () => buildSftpPlan({ ...req, deleteExtraneous: true }, opts),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.PREF.UNSUPPORTED)
        assert.match(err.hint ?? '', /rsync/)
        return true
      },
    )
  })

  test('远端提权 → 显式拒绝（子系统由 sshd 以登录用户身份起，没有包装命令的位置）', () => {
    assert.throws(
      () => buildSftpPlan({ ...req, become: { type: 'sudo' } }, opts),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.PREF.UNSUPPORTED)
        assert.match(err.hint ?? '', /rsync-ssh|tar-ssh/)
        return true
      },
    )
  })
})

describe('runSftp', () => {
  test('成功 → 文件数取 put 条数，并带上"没有增量"的 warning', async () => {
    const fake = fakeSpawn({ exitCode: 0 })
    const plan = buildSftpPlan(req, opts)
    const result = await runSftp(plan, { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(result.kind, 'sftp')
    assert.equal(result.filesTransferred, 2)
    assert.ok(result.warnings.some((w) => w.includes('没有增量')))
  })

  test('批量脚本真的写进 stdin —— sftp 只有这一个入口吃它', async () => {
    const fake = fakeSpawn({ exitCode: 0 })
    const plan = buildSftpPlan(req, opts)
    await runSftp(plan, { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(fake.count(), 1)
    assert.deepEqual([...(fake.records[0]?.stdin ?? [])], [plan.batch])
  })

  test('dry-run 不起进程 —— sftp 没有服务端干跑', async () => {
    const fake = fakeSpawn({ exitCode: 0 })
    const plan = buildSftpPlan(req, opts)
    const result = await runSftp(plan, { spawnImpl: fake.impl, timeoutMs: 5000, dryRun: true })
    assert.equal(fake.count(), 0, 'dry-run 不许起 sftp')
    assert.equal(result.filesTransferred, 0)
    assert.equal(result.dryRun, true)
    assert.ok(result.warnings.some((w) => w.includes('没被验证')), '必须说清这次什么都没验证')
  })

  test('255 → DP.SSH.CONNECT_FAILED', async () => {
    const fake = fakeSpawn({ exitCode: 255, stderr: 'ssh: connect to host dp-target port 22: Connection refused' })
    await assert.rejects(
      () => runSftp(buildSftpPlan(req, opts), { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => err instanceof DpError && err.code === ERR.SSH.CONNECT_FAILED,
    )
  })

  test('目标目录建不出来 → DP.PATH.NOT_WRITABLE', async () => {
    const fake = fakeSpawn({ exitCode: 1, stderr: "Couldn't create directory: Permission denied" })
    await assert.rejects(
      () => runSftp(buildSftpPlan(req, opts), { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => err instanceof DpError && err.code === ERR.PATH.NOT_WRITABLE,
    )
  })

  test('其它非 0 退出码 → DP.VERIFY.FAILED', async () => {
    const fake = fakeSpawn({ exitCode: 2, stderr: 'Connection closed' })
    await assert.rejects(
      () => runSftp(buildSftpPlan(req, opts), { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => err instanceof DpError && err.code === ERR.VERIFY.FAILED,
    )
  })

  test('超时 → 杀进程树', async () => {
    const fake = fakeSpawn({ autoClose: false })
    await assert.rejects(
      () => runSftp(buildSftpPlan(req, opts), { spawnImpl: fake.impl, timeoutMs: 20 }),
      (err: unknown) => err instanceof DpError && err.code === ERR.TIMEOUT.EXEC,
    )
    assert.deepEqual([...(fake.records[0]?.killed ?? [])], ['SIGKILL'])
  })

  test('输出里出现密码提示 → 立刻终止（铁律 0）', async () => {
    const fake = fakeSpawn({ autoClose: false })
    const pending = runSftp(buildSftpPlan(req, opts), { spawnImpl: fake.impl, timeoutMs: 5000 })
    fake.emit(0, 'stderr', "dp-user@dp-target's password: ")
    await assert.rejects(pending, (err: unknown) => {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, ERR.INTERACTIVE_PROMPT_DETECTED)
      return true
    })
  })
})
