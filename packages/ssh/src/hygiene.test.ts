/**
 * 收口清理的守护测试。
 *
 * 这一组守的都是「曾经静默失效 / 误导读者」的那类问题，所以断言里刻意包含
 * 「**不再**存在」这种负向断言 —— 只测新行为的话，死代码随时会长回来。
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DpError } from '@dp/ports'
import { createLogger, createMemorySink } from '@dp/log'
import { assertNativeExecutable } from './native.js'
import { connectSsh } from './connect.js'
import { FakeSshDriver } from './fake-driver.js'
import * as barrel from './index.js'

const temps: string[] = []
after(() => {
  for (const p of temps) rmSync(p, { recursive: true, force: true })
})

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'dp-hygiene-'))
  temps.push(d)
  return d
}

// ------------------------------------------------------------
// ③ knownHosts: off 必须仍然告警
// ------------------------------------------------------------

describe('knownHosts: off 的告警没有被删掉', () => {
  it('connectSsh 发出 warn 级记录，并写明代价', async () => {
    const sink = createMemorySink()
    const logger = createLogger({ sink, level: 'debug' })
    const conn = await connectSsh(
      { host: 'dp-target', user: 'deploy', auth: { type: 'agent' }, knownHosts: 'off' },
      { driver: new FakeSshDriver(), logger },
    )
    await conn.close()
    await logger.flush()

    const warn = sink.records.find((r) => r.msg === 'ssh.known_hosts_off')
    assert.ok(warn !== undefined, 'knownHosts=off 必须告警')
    assert.equal(warn.level, 'warn')
    assert.match(String(warn.consequence), /不校验主机密钥/)
    assert.match(String(warn.remedy), /strict|tofu/)
  })

  it('非 off 时不产生这条告警', async () => {
    const sink = createMemorySink()
    const logger = createLogger({ sink, level: 'debug' })
    const conn = await connectSsh(
      { host: 'dp-target', user: 'deploy', auth: { type: 'agent' }, knownHosts: 'strict' },
      { driver: new FakeSshDriver(), logger },
    )
    await conn.close()
    await logger.flush()
    assert.equal(sink.records.some((r) => r.msg === 'ssh.known_hosts_off'), false)
  })

  it('告警里不带任何凭据', async () => {
    const sink = createMemorySink()
    const logger = createLogger({ sink, level: 'debug' })
    const conn = await connectSsh(
      {
        host: 'dp-target',
        user: 'deploy',
        auth: { type: 'password', passwordRef: 'env:X' },
        secrets: { password: 'SuperSecret123' },
        knownHosts: 'off',
      },
      { driver: new FakeSshDriver(), logger },
    )
    await conn.close()
    await logger.flush()
    for (const r of sink.records) {
      assert.doesNotMatch(JSON.stringify(r), /SuperSecret123/)
    }
  })
})

// ------------------------------------------------------------
// ④ 死代码确实没了
// ------------------------------------------------------------

describe('probe.ts 用的探测脚本没有第二个实现', () => {
  it('包不再导出 probeScript / bindProbeScript', () => {
    const names = Object.keys(barrel as Record<string, unknown>)
    assert.equal(names.includes('probeScript'), false)
    assert.equal(names.includes('bindProbeScript'), false)
  })

  it('posix.ts 源码里也不再有这两个函数（不只是没导出）', () => {
    const src = readFileSync(new URL('../src/posix.ts', import.meta.url), 'utf8')
    assert.equal(src.includes('probeScript'), false)
    assert.equal(src.includes('bindProbeScript'), false)
    assert.equal(src.includes('$RANDOM'), false, '那段非 POSIX 的探针脚本也该一起消失')
  })
  it('probe 真正用到的导出都还在（不能为了删而删掉在用的东西）', () => {
    for (const name of [
      'statScript',
      'listDirScript',
      'mkdirScript',
      'writeFileScript',
      'readFileScript',
      'removeScript',
      'renameScript',
      'symlinkScript',
      'readlinkScript',
      'realpathScript',
      'script',
      'readIntent',
    ]) {
      assert.equal(typeof (barrel as Record<string, unknown>)[name], 'function', name)
    }
  })
})

// ------------------------------------------------------------
// ⑥ resolveTool 拒绝包装脚本
// ------------------------------------------------------------

describe('assertNativeExecutable —— 包装脚本不是可执行文件', () => {
  it('.cmd / .bat / .ps1 一律拒绝', () => {
    for (const p of ['C:/tools/ssh.cmd', 'C:/tools/ssh.bat', 'C:/tools/ssh.PS1']) {
      assert.throws(
        () => assertNativeExecutable(p, 'ssh'),
        (err: unknown) => {
          assert.ok(err instanceof DpError)
          assert.equal(err.code, 'DP.SSH.TOOL_MISSING')
          assert.match(err.hint ?? '', /OpenSSH for Windows/)
          return true
        },
        p,
      )
    }
  })

  it('hint 说清了「我们不过 shell」这个根因', () => {
    assert.throws(
      () => assertNativeExecutable('x.cmd', 'ssh'),
      (err: unknown) => /shell 恒为 false/.test((err as DpError).hint ?? ''),
    )
  })

  it('.exe 与无扩展名的原生程序都接受', () => {
    assert.equal(assertNativeExecutable('C:/Windows/System32/OpenSSH/ssh.exe', 'ssh'), 'C:/Windows/System32/OpenSSH/ssh.exe')
    assert.equal(assertNativeExecutable('/usr/bin/ssh', 'ssh'), '/usr/bin/ssh')
  })

  it('真造一个带 shebang 的无扩展名脚本 → 拒绝', () => {
    const dir = tempDir()
    const p = join(dir, 'sftp')
    writeFileSync(p, '#!/bin/sh\nexec /usr/bin/sftp "$@"\n', { mode: 0o755 })
    assert.throws(
      () => assertNativeExecutable(p, 'sftp'),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SSH.TOOL_MISSING')
        assert.match(err.message, /shebang/)
        return true
      },
    )
  })

  it('真造一个无扩展名但**不是**脚本的二进制 → 接受（不能误杀）', () => {
    const dir = tempDir()
    const p = join(dir, 'sftp')
    // 'MZ' 是 Windows PE 的魔数
    writeFileSync(p, Buffer.from([0x4d, 0x5a, 0x90, 0x00]))
    assert.equal(assertNativeExecutable(p, 'sftp'), p)
  })

  it('带扩展名的 .sh 脚本不算「无扩展名」，按原样放行（POSIX 上 .sh 本身可执行）', () => {
    assert.equal(assertNativeExecutable('/usr/local/bin/sftp.sh', 'sftp'), '/usr/local/bin/sftp.sh')
  })

  it('读不动文件时不当成脚本（探测失败不该误杀合法工具）', () => {
    const missing = join(tmpdir(), 'dp-does-not-exist-sftp')
    assert.equal(existsSync(missing), false)
    assert.equal(assertNativeExecutable(missing, 'sftp'), missing)
  })
})

// ------------------------------------------------------------
// ② env 不再是静默 no-op
// ------------------------------------------------------------

describe('ssh2 路径也用同一个转义出口', () => {
  /** 只看代码，不看注释 —— 解释"为什么删掉它"的注释里出现旧名字是合理的 */
  function codeOnly(file: string): string {
    const src = readFileSync(new URL(file, import.meta.url), 'utf8')
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  }

  it('ssh2.ts 不再有裸的 argv.join 拼远端命令', () => {
    const src = codeOnly('../src/ssh2.ts')
    assert.equal(src.includes("req.argv.join(' ')"), false, '裸 join 是远端注入面')
    assert.ok(src.includes('buildRemoteCommand'), '必须走 argv.ts 的转义出口')
  })

  it('native.ts 不再往子进程环境里塞 DP_ENV_，而是把 env 交给 argv 构造器', () => {
    const src = codeOnly('../src/native.ts')
    assert.equal(src.includes('DP_ENV_'), false)
    // 真实代码路径：exec 把 req.env 传给 sshArgvBase，由它展开成 -o SetEnv=K=V
    // （argv.test.ts 里有 setEnvOptions 的行为断言；这里守的是"驱动确实传了"）
    assert.ok(src.includes('sshArgvBase(req.env)'), '远端 env 必须走 sshArgvBase → SetEnv')
  })

  it('native.ts 不再有那个没人读的 warnIfOff 死代码', () => {
    assert.equal(codeOnly('../src/native.ts').includes('warnIfOff'), false)
  })
})
