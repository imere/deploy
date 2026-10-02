/**
 * 协商的逐分支断言。
 *
 * 断言的重点**不是**选了哪个（那是结论），而是**为什么没选别的** ——
 * `rejected` 是排障入口，丢它等于让用户去猜（transport.md §7）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'
import { chooseTransport, DEFAULT_PREFERENCE } from './availability.js'
import { LOCAL_NO_RSYNC, LOCAL_WITH_RSYNC, REMOTE_TAR_ONLY, REMOTE_WITH_RSYNC, makeFacts } from './fixtures.js'

describe('chooseTransport · local', () => {
  test('两端是同一台机器 → local-copy，且不因为没 rsync 而有任何异议', () => {
    const choice = chooseTransport({ local: LOCAL_NO_RSYNC, remote: LOCAL_NO_RSYNC, kind: 'local' })
    assert.equal(choice.kind, 'local-copy')
    assert.equal(choice.rejected.length, 0)
    assert.match(choice.reasons[0]!, /同一台机器/)
  })

  test('local 目标显式指定远程传输方式 → 抛错而不是静默忽略', () => {
    assert.throws(
      () => chooseTransport({ local: LOCAL_NO_RSYNC, remote: LOCAL_NO_RSYNC, kind: 'local', preferred: ['rsync-ssh'] }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.PREF.UNSUPPORTED')
        return true
      },
    )
  })
})

describe('chooseTransport · remote 缺省链', () => {
  test('两端都有 rsync → rsync-ssh', () => {
    const choice = chooseTransport({ local: LOCAL_WITH_RSYNC, remote: REMOTE_WITH_RSYNC, kind: 'remote' })
    assert.equal(choice.kind, 'rsync-ssh')
    assert.match(choice.reasons[0]!, /两端都检测到 rsync/)
  })

  test('本机没 rsync 但两端有 tar → tar-ssh，且理由要指名本机缺 rsync', () => {
    const choice = chooseTransport({ local: LOCAL_NO_RSYNC, remote: REMOTE_TAR_ONLY, kind: 'remote' })
    assert.equal(choice.kind, 'tar-ssh')
    assert.match(choice.reasons[0]!, /本机没有 rsync/)
  })

  test('两端都没 rsync 也没 tar，但 sftp 可用 → sftp', () => {
    const bare = makeFacts({ host: 'bare', tools: { ssh: '/usr/bin/ssh' } })
    const choice = chooseTransport({ local: bare, remote: bare, kind: 'remote' })
    assert.equal(choice.kind, 'sftp')
  })
})

describe('chooseTransport · rejected 必须逐项给出原因', () => {
  test('只有一端有 rsync → 拒绝并说明缺哪一端', () => {
    const localOnly = makeFacts({ host: 'l', tools: { ssh: '/usr/bin/ssh', tar: '/usr/bin/tar', rsync: '/usr/bin/rsync' } })
    const choice = chooseTransport({ local: localOnly, remote: REMOTE_TAR_ONLY, kind: 'remote' })
    const rsync = choice.rejected.find((r) => r.kind === 'rsync-ssh')
    assert.ok(rsync, 'rsync-ssh 必须出现在 rejected 里')
    // 关键：说清"目标机缺"，而不是含糊的"缺 rsync"
    assert.match(rsync.reason, /目标机未检测到 rsync/)
    assert.doesNotMatch(rsync.reason, /本机未检测到 rsync/)
  })

  test('两端都有 rsync 时，tar-ssh 仍在 rejected 里并说明为什么没选它', () => {
    const choice = chooseTransport({ local: LOCAL_WITH_RSYNC, remote: REMOTE_WITH_RSYNC, kind: 'remote' })
    assert.equal(choice.kind, 'rsync-ssh')
    // tar 可用时它不算"被拒"，但链上靠后的项必须被点名，否则用户不知道为什么没选
    assert.ok(choice.warnings.some((w) => w.includes('tar-ssh')))
  })

  test('sftp 不可用而两端有 scp → scp 且带"最后手段"warning', () => {
    // 刻意不给 tar：否则 tar-ssh 在链上更靠前，会先被选中（那才是正确行为）
    const noTar = makeFacts({ host: 'l', tools: { ssh: '/usr/bin/ssh', scp: '/usr/bin/scp', rsync: null } })
    const remoteNoTar = makeFacts({ host: 'r', tools: { ssh: '/usr/sbin/ssh', scp: '/usr/bin/scp', rsync: null } })
    const choice = chooseTransport({ local: noTar, remote: remoteNoTar, kind: 'remote', sftpAvailable: false })
    assert.equal(choice.kind, 'scp')
    assert.ok(choice.warnings.some((w) => w.includes('最后手段')))
  })

  test('sftp 可用时明确不选 scp，并解释 OpenSSH 9+ 的原因', () => {
    const choice = chooseTransport({ local: LOCAL_NO_RSYNC, remote: REMOTE_TAR_ONLY, kind: 'remote' })
    const scp = choice.rejected.find((r) => r.kind === 'scp')
    assert.ok(scp)
    assert.match(scp.reason, /sftp 可用/)
  })

  test('sftp 禁用但本机没 scp → scp 被拒，且说清是哪一端', () => {
    const noScp = makeFacts({ host: 'l', tools: { ssh: '/usr/bin/ssh', tar: '/usr/bin/tar' } })
    const choice = chooseTransport({ local: noScp, remote: REMOTE_TAR_ONLY, kind: 'remote', sftpAvailable: false })
    const scp = choice.rejected.find((r) => r.kind === 'scp')
    assert.ok(scp)
    assert.match(scp.reason, /本机没有 scp/)
  })
})

describe('chooseTransport · 显式偏好不可用就抛错', () => {
  test('点名 rsync-ssh 而本机没 rsync → DP.PREF.UNSUPPORTED，message 逐项列出', () => {
    assert.throws(
      () => chooseTransport({ local: LOCAL_NO_RSYNC, remote: REMOTE_WITH_RSYNC, kind: 'remote', preferred: ['rsync-ssh'] }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.PREF.UNSUPPORTED')
        // 逐项：不能只说"不支持"
        assert.match(err.message, /本机未检测到 rsync/)
        assert.ok(err.hint !== undefined && err.hint.length > 0, '必须有可执行建议')
        return true
      },
    )
  })

  test('偏好的每一项都不可用时，message 列出全部被拒项', () => {
    const bare = makeFacts({ host: 'b', tools: { ssh: '/usr/bin/ssh' } })
    assert.throws(
      () => chooseTransport({ local: bare, remote: bare, kind: 'remote', preferred: ['rsync-ssh', 'tar-ssh'], sftpAvailable: false }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.match(err.message, /rsync-ssh：/)
        assert.match(err.message, /tar-ssh：/)
        return true
      },
    )
  })

  test('偏好里给了可用的项 → 尊重偏好，不按缺省链', () => {
    const choice = chooseTransport({
      local: LOCAL_WITH_RSYNC,
      remote: REMOTE_WITH_RSYNC,
      kind: 'remote',
      preferred: ['tar-ssh', 'rsync-ssh'],
    })
    assert.equal(choice.kind, 'tar-ssh')
  })

  test('remote 请求里偏好 local-copy 被过滤掉，不参与协商', () => {
    const choice = chooseTransport({
      local: LOCAL_WITH_RSYNC,
      remote: REMOTE_WITH_RSYNC,
      kind: 'remote',
      preferred: ['local-copy', 'rsync-ssh'],
    })
    assert.equal(choice.kind, 'rsync-ssh')
    assert.equal(choice.rejected.length, 0)
  })
})

describe('DEFAULT_PREFERENCE', () => {
  test('缺省链把 scp 放在最后 —— 它是最差手段', () => {
    assert.deepEqual([...DEFAULT_PREFERENCE], ['rsync-ssh', 'tar-ssh', 'sftp', 'scp'])
  })
})
