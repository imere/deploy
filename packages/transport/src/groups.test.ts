/**
 * 分组与「远端建目录」前奏。
 *
 * 分组的依据是真机实测：rsync / scp 的「多源一目的」只保每个文件的 basename，
 * 混在一组会把 `assets/app.js` 拍平成 `<dest>/app.js`。前奏的依据同样来自实测：
 * 目的串缺中间层时 rsync 直接 exit 11，而它只肯建最后一段。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { buildSshMkdirArgv, groupByParentDir, nestedDirs } from './groups.js'

describe('groupByParentDir', () => {
  test('平铺清单只有一组，dir 是空串（目的目录就是 remoteRoot 本身）', () => {
    assert.deepEqual(groupByParentDir(['index.html', 'app.js']), [
      { dir: '', files: ['index.html', 'app.js'] },
    ])
  })

  test('嵌套条目按父目录分开，父链写全（不只取最后一段）', () => {
    assert.deepEqual(groupByParentDir(['a/b/c.js', 'a/d.js', 'top.js']), [
      { dir: 'a/b', files: ['a/b/c.js'] },
      { dir: 'a', files: ['a/d.js'] },
      { dir: '', files: ['top.js'] },
    ])
  })

  test('同目录的多个文件合并成一组，顺序按清单', () => {
    assert.deepEqual(groupByParentDir(['assets/a.js', 'assets/b.js']), [
      { dir: 'assets', files: ['assets/a.js', 'assets/b.js'] },
    ])
  })

  test('空清单 → 没有组（空清单由调用方拒绝，这里不替它猜）', () => {
    assert.deepEqual(groupByParentDir([]), [])
  })
})

describe('nestedDirs', () => {
  test('只列嵌套目录：remoteRoot 自己不算，它那一段 rsync / scp 会建', () => {
    assert.deepEqual(
      [...nestedDirs({ entries: ['index.html', 'assets/app.js'], remoteRoot: '/srv/www/current' })],
      ['/srv/www/current/assets'],
    )
  })

  test('多层级各自列出来，靠 mkdir -p 一次补齐', () => {
    assert.deepEqual(
      [...nestedDirs({ entries: ['a/b/c.js', 'a/d.js'], remoteRoot: '/srv/x' })],
      ['/srv/x/a/b', '/srv/x/a'],
    )
  })

  test('去重：同一父目录下的多个文件只出一个目录', () => {
    assert.deepEqual(
      [...nestedDirs({ entries: ['assets/a.js', 'assets/b.js'], remoteRoot: '/srv/x' })],
      ['/srv/x/assets'],
    )
  })

  test('remoteRoot 带尾随斜杠不产生双斜杠', () => {
    assert.deepEqual([...nestedDirs({ entries: ['assets/a.js'], remoteRoot: '/srv/x/' })], ['/srv/x/assets'])
  })

  test('全平铺 → 空（不需要前奏）', () => {
    assert.deepEqual([...nestedDirs({ entries: ['index.html'], remoteRoot: '/srv/x' })], [])
  })
})

describe('buildSshMkdirArgv', () => {
  const rsh = { sshPath: '/usr/bin/ssh', authKind: 'key' as const, knownHostsMode: 'strict' as const }

  test('ssh 本体 + 连接选项 + 主机标识 + 一条 mkdir 命令', () => {
    const argv = buildSshMkdirArgv({ rsh, remoteTarget: 'dp@target', dirs: ['/srv/x/assets'] })
    assert.equal(argv[0], '/usr/bin/ssh')
    assert.equal(argv.at(-2), 'dp@target')
    assert.equal(argv.at(-1), 'mkdir -p /srv/x/assets')
  })

  test('远端命令必须是一条字符串：ssh 不壳引其余 argv，逐段 quoteArg 后 join', () => {
    const argv = buildSshMkdirArgv({ rsh, remoteTarget: 'dp@target', dirs: ['/srv/my app', '/srv/x'] })
    assert.equal(argv.at(-1), "mkdir -p '/srv/my app' /srv/x")
  })

  test('become → 提权包装整条 mkdir，-- 之后才是 mkdir', () => {
    const argv = buildSshMkdirArgv({
      rsh,
      remoteTarget: 'dp@target',
      dirs: ['/srv/x'],
      become: { type: 'sudo', user: 'root' },
    })
    assert.equal(argv.at(-1), 'sudo -n -u root -- mkdir -p /srv/x')
  })

  test('become.type=none 时不包装（写了也不该多一层 sudo）', () => {
    const argv = buildSshMkdirArgv({
      rsh,
      remoteTarget: 'dp@target',
      dirs: ['/srv/x'],
      become: { type: 'none' },
    })
    assert.equal(argv.at(-1), 'mkdir -p /srv/x')
  })
})
