import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DpError, type DpErrorCode, type Facts, type Runner } from '@dp/ports'
import { FakeSshDriver } from './fake-driver.js'
import { createSshRunner, isUnder, normalizeRemotePath } from './runner.js'

const FACTS: Facts = {
  host: 'dp-target',
  platform: 'linux',
  arch: 'x64',
  init: 'systemd',
  homedir: '/home/deploy',
  tmpdir: '/tmp',
  env: {},
  capabilities: {
    canWrite: { '/srv/app': true },
    canChown: [],
    canSymlink: true,
    systemdScope: 'user',
    lingerEnabled: false,
    canBindPrivilegedPort: false,
    sudoAllowlist: [],
  },
  tools: { ssh: '/usr/bin/ssh', base64: '/usr/bin/base64' },
}

function makeRunner(driver = new FakeSshDriver(), allowedRoots?: readonly string[]): Runner {
  return createSshRunner({ driver, facts: FACTS, allowedRoots, timeoutMs: 5000 })
}

/** 断言抛出的 DpError.code 正是期望的那个 */
function expectCode(fn: () => Promise<unknown>, code: DpErrorCode): Promise<void> {
  return fn().then(
    () => assert.fail(`本该抛 ${code}，却成功了`),
    (err: unknown) => {
      assert.ok(err instanceof DpError, `不是 DpError：${String(err)}`)
      assert.equal(err.code, code)
    },
  )
}

// ------------------------------------------------------------
// 身份与事实
// ------------------------------------------------------------

describe('SshRunner —— 身份', () => {
  it('id 反映驱动 kind 与主机', () => {
    const driver = new FakeSshDriver({ kind: 'native-ssh' })
    const runner = makeRunner(driver)
    assert.equal(runner.id, 'ssh:dp-target')
    assert.equal(runner.facts.host, 'dp-target')
    assert.equal(driver.kind, 'native-ssh')
  })
})

// ------------------------------------------------------------
// exec
// ------------------------------------------------------------

describe('SshRunner.exec', () => {
  it('原样把 argv 交给驱动（不拼字符串、不进 shell）', async () => {
    const driver = new FakeSshDriver({ responses: { 'systemctl is-active nginx': { code: 0, stdout: 'active' } } })
    const res = await makeRunner(driver).exec(['systemctl', 'is-active', 'nginx'])
    assert.deepEqual(res, { code: 0, stdout: 'active', stderr: '' })
    assert.deepEqual(driver.calls[0]!.argv, ['systemctl', 'is-active', 'nginx'])
  })

  it('**没有 execShell** —— 接口层就掐掉了字符串入口', () => {
    const runner = makeRunner() as unknown as Record<string, unknown>
    assert.equal(runner['execShell'], undefined)
    assert.equal(typeof runner['exec'], 'function')
  })

  it('非 0 退出码**不抛**（由调用方决定）', async () => {
    const driver = new FakeSshDriver({
      responses: { 'false': { code: 1, stdout: '', stderr: 'boom' } },
    })
    const res = await makeRunner(driver).exec(['false'])
    assert.equal(res.code, 1)
    assert.equal(res.stderr, 'boom')
  })

  it('空 argv 拒绝', async () => {
    await expectCode(() => makeRunner().exec([]), 'DP.CONFIG.INVALID')
  })
})

// ------------------------------------------------------------
// 路径校验
// ------------------------------------------------------------

describe('路径校验 —— 发出之前的两道关', () => {
  it('相对路径拒绝（cwd 随环境而变，部署必须可重复）', () => {
    assert.throws(() => normalizeRemotePath('srv/app', { platform: 'linux' }), (e: unknown) => {
      assert.ok(e instanceof DpError && e.code === 'DP.PATH.ILLEGAL_CHAR')
      return true
    })
  })

  it('NUL 字节拒绝', () => {
    assert.throws(() => normalizeRemotePath('/srv/a\0b', { platform: 'linux' }), (e: unknown) => {
      assert.ok(e instanceof DpError, `不是 DpError：${String(e)}`)
      assert.equal(e.code, 'DP.PATH.ILLEGAL_CHAR')
      return true
    })
  })

  it('归一化 . 与 ..', () => {
    assert.equal(normalizeRemotePath('/srv/./app', { platform: 'linux' }), '/srv/app')
    assert.equal(normalizeRemotePath('/srv/x/../app', { platform: 'linux' }), '/srv/app')
    assert.equal(normalizeRemotePath('/srv//app//', { platform: 'linux' }), '/srv/app')
  })

  it('越过根往上走拒绝', () => {
    assert.throws(() => normalizeRemotePath('/../../etc/passwd', { platform: 'linux' }), (e: unknown) => {
      assert.ok(e instanceof DpError, `不是 DpError：${String(e)}`)
      assert.equal(e.code, 'DP.PATH.ILLEGAL_CHAR')
      // 与「不是绝对路径」是同一条码，靠消息才分得开是哪一条守卫拦的
      assert.match(e.message, /逃出根目录/)
      return true
    })
  })

  it('允许根之外的路径拒绝（路径穿越）', () => {
    assert.throws(
      () => normalizeRemotePath('/etc/passwd', { platform: 'linux', allowedRoots: ['/srv/app'] }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.PATH.ILLEGAL_CHAR',
    )
  })

  it('允许根本身与其子路径都接受', () => {
    const o = { platform: 'linux' as const, allowedRoots: ['/srv/app'] }
    assert.equal(normalizeRemotePath('/srv/app', o), '/srv/app')
    assert.equal(normalizeRemotePath('/srv/app/releases/1', o), '/srv/app/releases/1')
  })

  it('isUnder 按路径段比较（/srv/appx 冒充不了 /srv/app）', () => {
    assert.equal(isUnder('/srv/app', '/srv/app'), true)
    assert.equal(isUnder('/srv/app/x', '/srv/app'), true)
    assert.equal(isUnder('/srv/appx', '/srv/app'), false)
    assert.equal(isUnder('/anything', '/'), true)
  })

  it('每个 Runner 方法都用同一道校验（不是只有 writeFile 有）', async () => {
    const runner = makeRunner(undefined, ['/srv/app'])
    await expectCode(() => runner.stat('../etc'), 'DP.PATH.ILLEGAL_CHAR')
    await expectCode(() => runner.listDir('/etc'), 'DP.PATH.ILLEGAL_CHAR')
    await expectCode(() => runner.readFile('/etc/shadow'), 'DP.PATH.ILLEGAL_CHAR')
    await expectCode(() => runner.remove('/etc/hosts'), 'DP.PATH.ILLEGAL_CHAR')
    await expectCode(() => runner.mkdir('/etc/x'), 'DP.PATH.ILLEGAL_CHAR')
  })
})

// ------------------------------------------------------------
// stat
// ------------------------------------------------------------

describe('SshRunner.stat', () => {
  it('文件：size 与 mtime', async () => {
    const driver = new FakeSshDriver()
    driver.files.set('/srv/app/a.txt', new Uint8Array([1, 2, 3, 4, 5]))
    const s = await makeRunner(driver).stat('/srv/app/a.txt')
    assert.deepEqual(s, { isDirectory: false, isSymbolicLink: false, size: 5, mtimeMs: 100_000 })
  })

  it('目录', async () => {
    const driver = new FakeSshDriver()
    driver.dirs.add('/srv/app')
    const s = await makeRunner(driver).stat('/srv/app')
    assert.equal(s?.isDirectory, true)
  })

  it('软链：isSymbolicLink 而不是跟到目标', async () => {
    const driver = new FakeSshDriver()
    driver.links.set('/srv/app/current', '/srv/app/releases/1')
    const s = await makeRunner(driver).stat('/srv/app/current')
    assert.equal(s?.isSymbolicLink, true)
    assert.equal(s?.isDirectory, false)
  })

  it('不存在返回 null（不抛）', async () => {
    assert.equal(await makeRunner().stat('/srv/app/nope'), null)
  })

  it('远端输出无法解析 → DP.PATH.NOT_WRITABLE 而不是猜', async () => {
    const driver = new FakeSshDriver()
    driver.queue.push({ code: 0, stdout: 'garbage from a broken remote' })
    await expectCode(() => makeRunner(driver).stat('/srv/app/a'), 'DP.PATH.NOT_WRITABLE')
  })
})

// ------------------------------------------------------------
// listDir
// ------------------------------------------------------------

describe('SshRunner.listDir', () => {
  it('列出直接子项（不递归）', async () => {
    const driver = new FakeSshDriver()
    driver.dirs.add('/srv/app')
    driver.dirs.add('/srv/app/releases')
    driver.files.set('/srv/app/a.txt', new Uint8Array())
    driver.files.set('/srv/app/releases/b.txt', new Uint8Array())
    assert.deepEqual([...(await makeRunner(driver).listDir('/srv/app'))].sort(), ['a.txt', 'releases'])
  })

  it('不存在返回 []（与本机 Runner 契约一致）', async () => {
    assert.deepEqual(await makeRunner().listDir('/srv/app/nope'), [])
  })

  it('权限失败 → DP.PATH.NOT_WRITABLE', async () => {
    const driver = new FakeSshDriver()
    driver.denied.add('/srv/secret')
    driver.dirs.add('/srv/secret')
    await expectCode(() => makeRunner(driver).listDir('/srv/secret'), 'DP.PATH.NOT_WRITABLE')
  })
})

// ------------------------------------------------------------
// 写
// ------------------------------------------------------------

describe('SshRunner 写操作', () => {
  it('mkdir 建目录', async () => {
    const driver = new FakeSshDriver()
    await makeRunner(driver).mkdir('/srv/app/releases/1')
    assert.ok(driver.dirs.has('/srv/app/releases/1'))
  })

  it('writeFile 文本 → readFile 读回一致', async () => {
    const driver = new FakeSshDriver()
    const runner = makeRunner(driver)
    await runner.writeFile('/srv/app/conf.txt', 'hello 世界\n')
    assert.equal(await runner.readFile('/srv/app/conf.txt'), 'hello 世界\n')
  })

  it('writeFile 二进制 → readBinary 字节完全一致，且返回 Uint8Array 而非 Buffer', async () => {
    const driver = new FakeSshDriver()
    const runner = makeRunner(driver)
    // 全部 256 个字节：含 NUL、反斜杠、引号、回车 —— echo/printf 一定会毁掉其中一部分
    const data = new Uint8Array(256)
    for (let i = 0; i < 256; i++) data[i] = i

    await runner.writeFile('/srv/app/blob.bin', data)
    const back = await runner.readBinary('/srv/app/blob.bin')

    assert.equal(back instanceof Uint8Array, true)
    assert.equal(Buffer.isBuffer(back), false, '越过 Runner 边界不能是 Buffer')
    assert.equal(back.length, 256)
    for (let i = 0; i < 256; i++) assert.equal(back[i], i, `第 ${i} 字节不一致`)
  })

  it('二进制往返不经过 shell 字符串（脚本里是 base64）', async () => {
    const driver = new FakeSshDriver()
    await makeRunner(driver).writeFile('/srv/app/x.bin', new Uint8Array([0, 10, 92, 34]))
    const script = driver.calls[0]!.argv[2]!
    assert.ok(script.includes('base64 -d'), script)
    assert.ok(script.includes('printf %s'), '必须用 printf %s 而不是 echo')
  })

  it('writeFile 权限失败 → DP.PATH.NOT_WRITABLE', async () => {
    const driver = new FakeSshDriver()
    driver.denied.add('/etc/secret')
    await expectCode(() => makeRunner(driver).writeFile('/etc/secret/a', 'x'), 'DP.PATH.NOT_WRITABLE')
  })

  it('远端没有 base64 → DP.SSH.TOOL_MISSING 并给出替代方案', async () => {
    const driver = new FakeSshDriver()
    driver.queue.push({ code: 6, stderr: 'base64: not found' })
    const err = await makeRunner(driver)
      .readFile('/srv/app/a')
      .then(() => null, (e: unknown) => e)
    assert.ok(err instanceof DpError)
    assert.equal(err.code, 'DP.SSH.TOOL_MISSING')
    assert.ok(err.hint !== undefined && err.hint.length > 0)
  })

  it('remove 幂等：删不存在的目录不报错', async () => {
    const driver = new FakeSshDriver()
    await makeRunner(driver).remove('/srv/app/never-existed')
    assert.ok(driver.closed === false)
  })

  it('rename 搬运内容（原子发布依赖它）', async () => {
    const driver = new FakeSshDriver()
    const runner = makeRunner(driver)
    await runner.writeFile('/srv/app/releases/1/index.html', 'v1')
    await runner.rename('/srv/app/releases/1', '/srv/app/releases/2')
    assert.equal(await runner.readFile('/srv/app/releases/2/index.html'), 'v1')
    assert.equal(await runner.stat('/srv/app/releases/1/index.html'), null)
  })

  it('rename 源不存在 → DP.PATH.NOT_WRITABLE', async () => {
    await expectCode(() => makeRunner().rename('/srv/app/nope', '/srv/app/x'), 'DP.PATH.NOT_WRITABLE')
  })
})

// ------------------------------------------------------------
// 链接
// ------------------------------------------------------------

describe('SshRunner 链接', () => {
  it('symlink + readlink 往返', async () => {
    const driver = new FakeSshDriver()
    const runner = makeRunner(driver)
    await runner.symlink('/srv/app/releases/1', '/srv/app/current')
    assert.equal(await runner.readlink('/srv/app/current'), '/srv/app/releases/1')
  })

  it('readlink 非软链返回 null（不抛）', async () => {
    const driver = new FakeSshDriver()
    driver.files.set('/srv/app/plain.txt', new Uint8Array())
    assert.equal(await makeRunner(driver).readlink('/srv/app/plain.txt'), null)
  })

  it('readlink 不存在返回 null', async () => {
    assert.equal(await makeRunner().readlink('/srv/app/nope'), null)
  })

  it('symlink 落点不可写 → DP.PATH.NOT_WRITABLE 且带 hint', async () => {
    const driver = new FakeSshDriver()
    driver.denied.add('/etc')
    const err = await makeRunner(driver)
      .symlink('/srv/app/x', '/etc/link')
      .then(() => null, (e: unknown) => e)
    assert.ok(err instanceof DpError)
    assert.equal(err.code, 'DP.PATH.NOT_WRITABLE')
    assert.ok(err.hint !== undefined && err.hint.length > 0)
  })

  it('symlink 的**目标**允许相对路径（软链本来就常用相对形式）', async () => {
    const driver = new FakeSshDriver()
    await makeRunner(driver).symlink('releases/1', '/srv/app/current')
    assert.equal(driver.links.get('/srv/app/current'), 'releases/1')
  })
})

// ------------------------------------------------------------
// realpath
// ------------------------------------------------------------

describe('SshRunner.realpath', () => {
  it('解析出归一化的绝对路径', async () => {
    const driver = new FakeSshDriver()
    driver.dirs.add('/srv/app/releases/1')
    assert.equal(await makeRunner(driver).realpath('/srv/app/releases/1/./'), '/srv/app/releases/1')
  })

  it('解析结果落在允许根之外 → 拒绝（软链逃逸的防线）', async () => {
    const driver = new FakeSshDriver()
    driver.dirs.add('/etc')
    await expectCode(() => makeRunner(driver, ['/srv/app']).realpath('/etc'), 'DP.PATH.ILLEGAL_CHAR')
  })
})

// ------------------------------------------------------------
// 超时与 prompt
// ------------------------------------------------------------

describe('SshRunner —— 超时与交互式 prompt', () => {
  it('超时 → DP.TIMEOUT.EXEC', async () => {
    const driver = new FakeSshDriver()
    driver.hangOn = 'sleep'
    const err = await makeRunner(driver)
      .exec(['sleep', '100'])
      .then(() => null, (e: unknown) => e)
    assert.ok(err instanceof DpError)
    assert.equal(err.code, 'DP.TIMEOUT.EXEC')
    assert.ok(err.hint !== undefined && err.hint.length > 0)
  })

  it('读文件时超时也是 DP.TIMEOUT.EXEC', async () => {
    const driver = new FakeSshDriver()
    driver.hangOn = 'base64'
    await expectCode(() => makeRunner(driver).readFile('/srv/app/a'), 'DP.TIMEOUT.EXEC')
  })

  const promptCases: readonly [string, string][] = [
    ['password 提示', 'dp@target: Permission denied\nPassword:'],
    ['sudo 提示', '[sudo] password for deploy:'],
    ['无 tty 的 sudo', 'sudo: no tty present and no askpass program specified'],
    ['指纹确认', 'The authenticity of host ... cannot be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?'],
  ]

  for (const [name, text] of promptCases) {
    it(`prompt 命中 → DP.INTERACTIVE_PROMPT_DETECTED：${name}`, async () => {
      const driver = new FakeSshDriver()
      driver.promptText = text
      const err = await makeRunner(driver)
        .exec(['systemctl', 'restart', 'nginx'])
        .then(() => null, (e: unknown) => e)
      assert.ok(err instanceof DpError, String(err))
      assert.equal(err.code, 'DP.INTERACTIVE_PROMPT_DETECTED')
      assert.ok(err.hint !== undefined && err.hint.length > 0, '必须有 hint 指导下一步')
    })
  }

  it('prompt 错误**不含**凭据字面量', async () => {
    const driver = new FakeSshDriver()
    driver.promptText = 'Password: hunter2'
    const err = await makeRunner(driver)
      .exec(['id'])
      .then(() => null, (e: unknown) => e)
    assert.ok(err instanceof DpError)
    assert.doesNotMatch(err.message, /hunter2/)
  })
})

// ------------------------------------------------------------
// 输出截断
// ------------------------------------------------------------

describe('SshRunner —— 输出上限', () => {
  it('超大输出被截断并带标记（防炸内存）', async () => {
    const driver = new FakeSshDriver({
      responses: { 'huge': { code: 0, stdout: 'x'.repeat(3 * 1024 * 1024) } },
    })
    const res = await makeRunner(driver).exec(['huge'])
    assert.ok(res.stdout.length < 3 * 1024 * 1024, '不该原样返回 3MiB')
    assert.match(res.stdout, /truncated \d+ bytes/)
  })
})
