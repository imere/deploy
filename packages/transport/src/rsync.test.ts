/**
 * rsync 计划与退出码映射。
 *
 * 三个重点：
 *  1. 计划里远端 path 必须过 `@dp/runner-ssh` 的 `quoteArg`（唯一转义出口）
 *  2. 嵌套条目按父目录分组：rsync 的「多源一目的」只保 basename，混在一组会把路径拍平
 *  3. 23/24 是**部分传输**，必须变成 warning 而不是成功
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { ERR, DpError } from '@dp/ports'
import { buildRsyncPath, buildRsyncPlan, classifyRsyncExit, parseRsyncOutput, runRsyncPlan } from './rsync.js'
import { fakeSpawn } from './fake-spawn.js'
import type { RsyncPlan } from './rsync.js'
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

const flat: TransferRequest = { ...req, entries: ['index.html'] }

describe('buildRsyncPlan', () => {
  /**
   * `--human-readable=0` 这条曾经写在实现里，而 rsync 根本不认 ——
   * `-h` 只吃「重复次数」、不吃 `=级别`，真机上直接 `option does not take an argument` 退出 1。
   * 降到 0 的唯一写法是 `--no-h`。这条断言钉的就是「不许再写回 =0」。
   */
  test('机器可读选项齐备：itemize / no-human-readable / out-format / stats', () => {
    const plan = buildRsyncPlan(req, opts)
    for (const argv of plan.argvs) {
      assert.ok(argv.includes('--itemize-changes'))
      assert.ok(argv.includes('--no-human-readable'), '必须是 --no-human-readable；--human-readable=0 会被 rsync 拒')
      assert.equal(
        argv.some((a) => a.startsWith('--human-readable')),
        false,
        '--human-readable 的任何 = 形式都不存在，rsync 不接受它带参数',
      )
      assert.ok(argv.includes('--out-format=%i %n'))
      assert.ok(argv.includes('--stats'))
    }
  })

  test('-a 但默认不带 -o -g（多数部署用户没有 chown 权限）', () => {
    const plan = buildRsyncPlan(req, opts)
    assert.ok(plan.argvs[0]!.includes('-a'))
    assert.ok(!plan.argvs[0]!.includes('-o'), '不该有裸 -o；保留 owner/group 必须显式开')
    const kept = buildRsyncPlan(req, { ...opts, preserveOwner: true })
    assert.ok(kept.argvs[0]!.slice(0, 5).includes('-o'))
  })

  test('--delete 默认关，显式开才有', () => {
    assert.ok(!buildRsyncPlan(req, opts).argvs[0]!.includes('--delete'))
    assert.ok(buildRsyncPlan({ ...req, deleteExtraneous: true }, opts).argvs[0]!.includes('--delete'))
  })

  test('dryRun：计划标出来，且每组都带 --dry-run', () => {
    const plan = buildRsyncPlan({ ...req, dryRun: true }, opts)
    assert.equal(plan.dryRun, true)
    for (const argv of plan.argvs) assert.ok(argv.includes('--dry-run'))
  })

  /**
   * 真机实测（rsync 3.2.7）：把 `assets/app.js` 与 `index.html` 一起列进同一个目的目录，
   * 落盘出来的是 `<dest>/app.js` —— 多源一目的只保 basename。分组是这条实测的直接后果。
   */
  test('嵌套条目按父目录分组，各用自己的目的目录（不拍平路径）', () => {
    const plan = buildRsyncPlan(req, opts)
    assert.equal(plan.argvs.length, 2)
    assert.ok(plan.argvs[0]!.includes('/work/dist/index.html'))
    assert.equal(plan.argvs[0]!.at(-1), 'dp-user@dp-target:/srv/www/current/')
    assert.ok(plan.argvs[1]!.includes('/work/dist/assets/app.js'))
    assert.equal(plan.argvs[1]!.at(-1), 'dp-user@dp-target:/srv/www/current/assets/')
  })

  test('平铺清单只有一组，形态与「一个目的目录」完全一致', () => {
    const plan = buildRsyncPlan(flat, opts)
    assert.equal(plan.argvs.length, 1)
    assert.deepEqual(plan.remoteDirs, [])
  })

  test('remoteDirs 只列嵌套目录：最后一段 rsync 自己会建，缺的只是中间层', () => {
    assert.deepEqual([...buildRsyncPlan(req, opts).remoteDirs], ['/srv/www/current/assets'])
    assert.deepEqual([...buildRsyncPlan(flat, opts).remoteDirs], [])
  })

  test('mkdir 前奏是 ssh argv，建的就是那几个嵌套目录', () => {
    const plan = buildRsyncPlan(req, opts)
    const argv = plan.mkdirArgv
    assert.ok(argv !== undefined, '有嵌套目录就必须有建目录的 argv')
    assert.equal(argv[0], '/usr/bin/ssh')
    assert.equal(argv.at(-2), 'dp-user@dp-target')
    assert.equal(argv.at(-1), 'mkdir -p /srv/www/current/assets')
  })

  test('become → mkdir 前奏带提权包装，且 -- 之后才是 mkdir', () => {
    const plan = buildRsyncPlan({ ...req, become: { type: 'sudo', user: 'root' } }, opts)
    assert.equal(plan.mkdirArgv?.at(-1), 'sudo -n -u root -- mkdir -p /srv/www/current/assets')
  })

  test('无嵌套目录时 mkdirArgv 这个键根本不出现', () => {
    const plan = buildRsyncPlan(flat, opts)
    assert.equal('mkdirArgv' in plan, false, '有键而值是空数组会被当成一条空命令去 spawn')
  })

  test('远端写成 user@host:path，且 path 走 quoteArg', () => {
    const plan = buildRsyncPlan({ ...req, remoteRoot: '/srv/my app' }, opts)
    assert.equal(plan.argvs[0]!.at(-1), "dp-user@dp-target:'/srv/my app/'")
    assert.equal(plan.argvs[1]!.at(-1), "dp-user@dp-target:'/srv/my app/assets/'")
  })

  test('空源 → DP.SOURCE.EMPTY（不传输空的"成功"）', () => {
    assert.throws(
      () => buildRsyncPlan({ ...req, entries: [] }, opts),
      (err: unknown) => err instanceof DpError && err.code === ERR.SOURCE.EMPTY,
    )
  })

  test('空远端目标 → 拒绝，不猜', () => {
    assert.throws(
      () => buildRsyncPlan(req, { ...opts, remoteTarget: '  ' }),
      (err: unknown) => err instanceof DpError && err.code === ERR.CONFIG.INVALID,
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

  test('custom 模板必须含 ${cmd}，否则 @dp/runner-ssh 直接拒', () => {
    assert.throws(
      () => buildRsyncPath({ type: 'custom', template: 'dzdo rsync' }),
      (err: unknown) => err instanceof DpError && err.code === ERR.CONFIG.INVALID,
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
      assert.equal(v.error?.code, ERR.PATH.NOT_WRITABLE)
    }
  })

  test('255 → DP.SSH.*，并按 stderr 细分认证 / 主机密钥 / 连接', () => {
    assert.equal(classifyRsyncExit(255, 'Permission denied (publickey)').error?.code, ERR.SSH.AUTH_FAILED)
    assert.equal(
      classifyRsyncExit(255, 'Host key verification failed.').error?.code,
      ERR.SSH.HOST_KEY_MISMATCH,
    )
    assert.equal(classifyRsyncExit(255, 'Connection refused').error?.code, ERR.SSH.CONNECT_FAILED)
  })

  test('255 的 message 带上 ssh 的原话（排障需要）', () => {
    const v = classifyRsyncExit(255, 'ssh: connect to host dp-target port 22: Connection refused')
    assert.match(v.error?.message ?? '', /Connection refused/)
  })

  test('127 → 目标机没有 rsync', () => {
    assert.equal(classifyRsyncExit(127, 'rsync: command not found').error?.code, ERR.SSH.TOOL_MISSING)
  })

  test('25 → 全部失败', () => {
    assert.equal(classifyRsyncExit(25, 'x').error?.code, ERR.VERIFY.FAILED)
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

describe('runRsyncPlan · fake spawn 驱动', () => {
  const simple: RsyncPlan = { argvs: [['/usr/bin/rsync', '-a']], remoteDirs: [], dryRun: false }

  test('各组统计累加，command 是按组展开的全部 argv', async () => {
    const fake = fakeSpawn({
      exitCode: 0,
      stdout: 'Number of regular files transferred: 3\nTotal file size: 55 bytes\n',
    })
    const plan: RsyncPlan = { ...simple, argvs: [['/usr/bin/rsync', '-a'], ['/usr/bin/rsync', '-a']] }
    const result = await runRsyncPlan(plan, { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(result.exitCode, 0)
    assert.equal(result.filesTransferred, 6, '两组各 3 个文件，总数必须是 6 而不是最后一组的 3')
    assert.equal(result.bytes, 110)
    assert.deepEqual([...result.command], ['/usr/bin/rsync', '-a', '/usr/bin/rsync', '-a'])
  })

  test('有一组读不出字节数就不报总数：部分已知 + 部分未知 ≠ 一个总数', async () => {
    const fake = fakeSpawn({ exitCode: 0, stdout: 'Number of regular files transferred: 3\n' })
    const plan: RsyncPlan = { ...simple, argvs: [['/usr/bin/rsync'], ['/usr/bin/rsync']] }
    const result = await runRsyncPlan(plan, { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(result.filesTransferred, 6)
    assert.equal(result.bytes, undefined)
  })

  test('mkdir 前奏排在所有组之前，失败就抛 DP.PATH.NOT_WRITABLE（传输一次都没起）', async () => {
    const fake = fakeSpawn({ exitCode: 1, stderr: 'mkdir: cannot create directory: Permission denied' })
    const plan: RsyncPlan = {
      argvs: [['/usr/bin/rsync', '-a']],
      remoteDirs: ['/srv/www/current/assets'],
      mkdirArgv: ['/usr/bin/ssh', 'dp-user@dp-target', 'mkdir -p /srv/www/current/assets'],
      dryRun: false,
    }
    await assert.rejects(
      () => runRsyncPlan(plan, { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => err instanceof DpError && err.code === ERR.PATH.NOT_WRITABLE,
    )
    assert.equal(fake.count(), 1, '前奏失败后不该再起 rsync')
    assert.equal(fake.records[0]!.file, '/usr/bin/ssh')
  })

  test('dryRun 不跑 mkdir 前奏：演练不在机器上留目录', async () => {
    const fake = fakeSpawn({ exitCode: 0, stdout: 'Number of regular files transferred: 9\n' })
    const plan: RsyncPlan = {
      argvs: [['/usr/bin/rsync', '-a', '--dry-run']],
      remoteDirs: ['/srv/www/current/assets'],
      mkdirArgv: ['/usr/bin/ssh', 'dp-user@dp-target', 'mkdir -p /srv/www/current/assets'],
      dryRun: true,
    }
    const result = await runRsyncPlan(plan, { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(fake.count(), 1)
    assert.equal(fake.records[0]!.file, '/usr/bin/rsync')
    assert.equal(result.dryRun, true)
    assert.equal(result.filesTransferred, 0, '演练不报文件数：一个从清单推出来的数字会让人以为真搬了')
  })

  test('退出 23 → warning 而不是静默成功', async () => {
    const fake = fakeSpawn({ exitCode: 23, stderr: 'some file vanished' })
    const result = await runRsyncPlan(simple, { spawnImpl: fake.impl, timeoutMs: 5000 })
    assert.equal(result.partial, true)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0]!, /部分传输/)
  })

  test('退出 255 → 抛 DP.SSH.*，stderr 原样带出', async () => {
    const fake = fakeSpawn({ exitCode: 255, stderr: 'Permission denied (publickey,password).' })
    await assert.rejects(
      () => runRsyncPlan(simple, { spawnImpl: fake.impl, timeoutMs: 5000 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.SSH.AUTH_FAILED)
        assert.match(err.message, /Permission denied/)
        return true
      },
    )
  })

  test('超时 → 杀进程并抛 DP.TIMEOUT.EXEC（不允许无限等）', async () => {
    const fake = fakeSpawn({ autoClose: false })
    await assert.rejects(
      () => runRsyncPlan(simple, { spawnImpl: fake.impl, timeoutMs: 20 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.TIMEOUT.EXEC)
        return true
      },
    )
    assert.deepEqual([...fake.records[0]!.killed], ['SIGKILL'], '超时必须杀进程树')
  })

  test('输出里出现 prompt → 立刻杀并报 DP.INTERACTIVE_PROMPT_DETECTED', async () => {
    const fake = fakeSpawn({ autoClose: false })
    const promise = runRsyncPlan(simple, { spawnImpl: fake.impl, timeoutMs: 5000 })
    fake.emit(0, 'stderr', '[sudo] password for dp-user: ')
    await assert.rejects(
      () => promise,
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.INTERACTIVE_PROMPT_DETECTED)
        return true
      },
    )
    assert.deepEqual([...fake.records[0]!.killed], ['SIGKILL'])
  })
})
