/**
 * rsync argv 与退出码映射。
 *
 * 两个重点：
 *  1. argv 里远端 path 必须过 `@dp/ssh` 的 `quoteArg`（唯一转义出口）
 *  2. 23/24 是**部分传输**，必须变成 warning 而不是成功
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'
import { buildRsyncArgv, buildRsyncPath, classifyRsyncExit, parseRsyncOutput, runRsync } from './rsync.js'
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
  rsyncPath: '/usr/bin/rsync',
  rsh: { sshPath: '/usr/bin/ssh', authKind: 'key' as const, knownHostsMode: 'strict' as const },
  remoteTarget: 'dp-user@dp-target',
}

describe('buildRsyncArgv', () => {
  test('机器可读选项齐备：itemize / human-readable=0 / out-format / stats', () => {
    const argv = buildRsyncArgv(req, opts)
    assert.ok(argv.includes('--itemize-changes'))
    assert.ok(argv.includes('--human-readable=0'))
    assert.ok(argv.includes('--out-format=%i %n'))
    assert.ok(argv.includes('--stats'))
  })

  test('-a 但默认不带 -o -g（多数部署用户没有 chown 权限）', () => {
    const argv = buildRsyncArgv(req, opts)
    assert.ok(argv.includes('-a'))
    assert.ok(!argv.includes('-o'), '不该有裸 -o；保留 owner/group 必须显式开')
    assert.deepEqual(buildRsyncArgv(req, { ...opts, preserveOwner: true }).slice(0, 5).includes('-o'), true)
  })

  test('--delete 默认关，显式开才有', () => {
    assert.ok(!buildRsyncArgv(req, opts).includes('--delete'))
    assert.ok(buildRsyncArgv({ ...req, deleteExtraneous: true }, opts).includes('--delete'))
  })

  test('dryRun 加 --dry-run', () => {
    assert.ok(buildRsyncArgv({ ...req, dryRun: true }, opts).includes('--dry-run'))
  })

  test('远端写成 user@host:path，且 path 走 quoteArg', () => {
    const argv = buildRsyncArgv({ ...req, remoteRoot: '/srv/my app' }, opts)
    const target = argv[argv.length - 1]!
    assert.equal(target, "dp-user@dp-target:'/srv/my app/'")
  })

  test('本机源是 root/entry 形式', () => {
    const argv = buildRsyncArgv(req, opts)
    assert.ok(argv.includes('/work/dist/index.html'))
    assert.ok(argv.includes('/work/dist/assets/app.js'))
  })

  test('空源 → DP.SOURCE.EMPTY（不传输空的"成功"）', () => {
    assert.throws(
      () => buildRsyncArgv({ ...req, entries: [] }, opts),
      (err: unknown) => err instanceof DpError && err.code === 'DP.SOURCE.EMPTY',
    )
  })

  test('空远端目标 → 拒绝，不猜', () => {
    assert.throws(
      () => buildRsyncArgv(req, { ...opts, remoteTarget: '  ' }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
    )
  })
})

describe('buildRsyncPath · 提权包装', () => {
  test('none/未配 → 不加 --rsync-path', () => {
    assert.equal(buildRsyncPath(undefined), undefined)
    assert.equal(buildRsyncPath({ type: 'none' }), undefined)
  })

  test('sudo → 复用 wrapCommand 的产物，含 -n（永不交互）', () => {
    const value = buildRsyncPath({ type: 'sudo', user: 'root' })
    assert.equal(value, 'sudo -n -u root -- rsync')
  })

  test('doas → doas -n', () => {
    assert.equal(buildRsyncPath({ type: 'doas' }), 'doas -n -- rsync')
  })

  test('custom 模板必须含 ${cmd}，否则 @dp/ssh 直接拒', () => {
    assert.throws(
      () => buildRsyncPath({ type: 'custom', template: 'dzdo rsync' }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
    )
  })
})

describe('classifyRsyncExit', () => {
  test('0 → 成功', () => {
    assert.equal(classifyRsyncExit(0, '').ok, true)
    assert.equal(classifyRsyncExit(0, '').partial, false)
  })

  test('23 / 24 → 部分传输：ok 但 partial，绝不当干净成功', () => {
    for (const code of [23, 24]) {
      const v = classifyRsyncExit(code, '')
      assert.equal(v.ok, true, `${code} 应算成功但带标记`)
      assert.equal(v.partial, true, `${code} 必须标成部分传输`)
    }
  })

  test('11 / 12 → DP.PATH.NOT_WRITABLE', () => {
    for (const code of [11, 12]) {
      const v = classifyRsyncExit(code, 'Permission denied')
      assert.equal(v.error?.code, 'DP.PATH.NOT_WRITABLE')
    }
  })

  test('255 → DP.SSH.*，并按 stderr 细分认证 / 主机密钥 / 连接', () => {
    assert.equal(classifyRsyncExit(255, 'Permission denied (publickey)').error?.code, 'DP.SSH.AUTH_FAILED')
    assert.equal(
      classifyRsyncExit(255, 'Host key verification failed.').error?.code,
      'DP.SSH.HOST_KEY_MISMATCH',
    )
    assert.equal(classifyRsyncExit(255, 'Connection refused').error?.code, 'DP.SSH.CONNECT_FAILED')
  })

  test('255 的 message 带上 ssh 的原话（排障需要）', () => {
    const v = classifyRsyncExit(255, 'ssh: connect to host dp-target port 22: Connection refused')
    assert.match(v.error?.message ?? '', /Connection refused/)
  })

  test('127 → 目标机没有 rsync', () => {
    assert.equal(classifyRsyncExit(127, 'rsync: command not found').error?.code, 'DP.SSH.TOOL_MISSING')
  })

  test('25 → 全部失败', () => {
    assert.equal(classifyRsyncExit(25, 'x').error?.code, 'DP.VERIFY.FAILED')
  })
})

describe('parseRsyncOutput', () => {
  const out = [
    '>f+++++++++ assets/app.js',
    'cd+++++++++ index.html',
    '',
    'Number of regular files transferred: 2',
    'Total file size: 1,024 bytes',
  ].join('\n')

  test('优先用 --stats 汇总行', () => {
    const s = parseRsyncOutput(out)
    assert.equal(s.filesTransferred, 2)
    assert.equal(s.bytes, 1024)
  })

  test('新增/删除的行被标出来', () => {
    assert.equal(parseRsyncOutput(out).vanished.length, 2)
  })

  test('没有汇总行时不崩，退回 0', () => {
    assert.equal(parseRsyncOutput('garbage').filesTransferred, 0)
  })
})

describe('runRsync · fake spawn 驱动', () => {
  test('正常退出 → 统计出文件数', async () => {
    const fake = fakeSpawn({
      exitCode: 0,
      stdout: 'Number of regular files transferred: 3\nTotal file size: 55 bytes\n',
    })
    const result = await runRsync(['/usr/bin/rsync', '-a'], { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(result.exitCode, 0)
    assert.equal(result.filesTransferred, 3)
    assert.equal(result.bytes, 55)
    assert.deepEqual([...result.warnings], [])
    // argv 原样回传，且不含凭据
    assert.deepEqual([...result.command], ['/usr/bin/rsync', '-a'])
  })

  test('退出 23 → warning 而不是静默成功', async () => {
    const fake = fakeSpawn({ exitCode: 23, stderr: 'some file vanished' })
    const result = await runRsync(['/usr/bin/rsync'], { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(result.partial, true)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0]!, /部分传输/)
  })

  test('退出 255 → 抛 DP.SSH.*，stderr 原样带出', async () => {
    const fake = fakeSpawn({ exitCode: 255, stderr: 'Permission denied (publickey,password).' })
    await assert.rejects(
      () => runRsync(['/usr/bin/rsync'], { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SSH.AUTH_FAILED')
        assert.match(err.message, /Permission denied/)
        return true
      },
    )
  })

  test('超时 → 杀进程并抛 DP.TIMEOUT.EXEC（不允许无限等）', async () => {
    const fake = fakeSpawn({ autoClose: false })
    await assert.rejects(
      () => runRsync(['/usr/bin/rsync'], { spawnImpl: fake.impl, timeoutMs: 20 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.TIMEOUT.EXEC')
        return true
      },
    )
    assert.deepEqual([...fake.records[0]!.killed], ['SIGKILL'], '超时必须杀进程树')
  })

  test('输出里出现 prompt → 立刻杀并报 DP.INTERACTIVE_PROMPT_DETECTED', async () => {
    const fake = fakeSpawn({ autoClose: false })
    const promise = runRsync(['/usr/bin/rsync'], { spawnImpl: fake.impl, timeoutMs: 5000 })
    fake.emit(0, 'stderr', '[sudo] password for dp-user: ')
    await assert.rejects(
      () => promise,
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.INTERACTIVE_PROMPT_DETECTED')
        return true
      },
    )
    assert.deepEqual([...fake.records[0]!.killed], ['SIGKILL'])
  })

  test('dryRun 结果标明 dryRun 且不报文件数', async () => {
    const fake = fakeSpawn({ exitCode: 0, stdout: 'Number of regular files transferred: 9\n' })
    const result = await runRsync(['/usr/bin/rsync'], { spawnImpl: fake.impl, timeoutMs: 5000, dryRun: true })
    assert.equal(result.dryRun, true)
    assert.equal(result.filesTransferred, 0)
  })
})

describe('真机集成（默认跳过）', () => {
  describe('rsync over ssh 真实传输', { skip: '需要真实 rsync/scp 与目标机；本机 facts.tools.rsync === null' }, () => {
    test('增量传输生效', () => {
      assert.fail('需要 dp-spike-env 起靶机后手工启用')
    })
  })
})
