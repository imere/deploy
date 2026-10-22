import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DpError,
  type ExecResult,
  type Facts,
  type FileStat,
  type Runner,
  type TargetContext,
} from '@dp/ports'
import { linuxFacts } from '@dp/testkit'
import {
  activateSystemd,
  installSystemd,
  isSystemdExecFailure,
  rollbackSystemd,
  verifySystemd,
  type SystemdTargetConfig,
} from './index.js'
import { unitPaths } from './target.js'
import { MANAGED_MARKER } from './unit.js'

// ------------------------------------------------------------
// 内存 Runner：把目标机的文件系统与 systemctl 行为实现到刚好够用
// ------------------------------------------------------------

class FakeRunner implements Runner {
  readonly id = 'fake'
  readonly facts: Facts
  calls: string[][] = []
  readonly dirs = new Set<string>(['/'])
  readonly files = new Map<string, string>()
  handler: (argv: readonly string[]) => ExecResult = () => ({ code: 0, stdout: '', stderr: '' })

  constructor(facts: Facts) {
    this.facts = facts
  }

  async exec(argv: readonly string[]): Promise<ExecResult> {
    this.calls.push([...argv])
    return this.handler(argv)
  }

  async stat(path: string): Promise<FileStat | null> {
    if (this.files.has(path)) {
      return { isDirectory: false, isSymbolicLink: false, size: this.files.get(path)!.length, mtimeMs: 0 }
    }
    if (this.dirs.has(path)) {
      return { isDirectory: true, isSymbolicLink: false, size: 0, mtimeMs: 0 }
    }
    return null
  }

  async listDir(path: string): Promise<readonly string[]> {
    const out: string[] = []
    for (const key of this.dirs) {
      if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) {
        out.push(key.slice(path.length + 1))
    }
    }
    for (const key of this.files.keys()) {
      if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) {
        out.push(key.slice(path.length + 1))
    }
    }
    return [...new Set(out)].sort()
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(path)
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path))
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) throw new DpError('DP.PATH.NOT_WRITABLE', `不存在：${path}`)
    return value
  }

  async remove(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.files.delete(key)
    }
    for (const key of [...this.dirs]) {
      if (key === path || key.startsWith(`${path}/`)) this.dirs.delete(key)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const value = this.files.get(from)
    this.files.delete(from)
    this.dirs.delete(from)
    if (value === undefined) this.dirs.add(to)
    else this.files.set(to, value)
  }

  async symlink(): Promise<void> {
    throw new DpError('DP.PATH.NOT_WRITABLE', '不支持软链')
  }

  async readlink(): Promise<string | null> {
    return null
  }

  async realpath(path: string): Promise<string> {
    return path
  }
}

function makeConfig(over: Partial<SystemdTargetConfig> = {}): SystemdTargetConfig {
  return {
    unitDir: '/etc/systemd/system',
    execStart: '/srv/app/current/start.sh',
    render: { project: 'api', env: 'prod', release: { current: '/srv/app/current' } },
    ...over,
  }
}

function makeCtx(over: Partial<TargetContext> = {}): TargetContext {
  return { host: 'fake', root: '/srv/app', releaseId: 'r2', keep: 3, ...over }
}

describe('systemd 执行器 · install', () => {
  it('成功时把候选写进影子目录，且**不碰**生效的 unit 文件', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    const ctx = makeCtx()
    const result = await installSystemd({ runner, ctx, config: makeConfig() })

    assert.equal(result.phase, 'install')
    assert.equal(result.file, '/etc/systemd/system/api.service')
    assert.equal(runner.files.has(unitPaths(ctx, makeConfig()).candidate), true)
    assert.equal(runner.files.has('/etc/systemd/system/api.service'), false)
    assert.deepEqual(result.steps.map((s) => s.id), [
      'systemd.render',
      'systemd.write-candidate',
      'systemd.validate-shadow',
    ])
  })

  it('影子目录落在 release 目录下而不是 unitDir 之下（unitDir 会被 systemd 递归扫描）', () => {
    const paths = unitPaths(makeCtx(), makeConfig())
    assert.ok(paths.shadowRoot.startsWith('/srv/app/releases/r2/'), paths.shadowRoot)
    assert.equal(paths.shadowRoot.startsWith('/etc/systemd/system/'), false)
  })

  it('候选过不了 systemd-analyze verify → DP.SYSD.TEST_FAILED，unitDir 未被写', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.handler = (argv) =>
      argv[0] === 'systemd-analyze'
        ? { code: 1, stdout: '', stderr: 'api.service:9: Unknown key name' }
        : { code: 0, stdout: '', stderr: '' }
    await assert.rejects(
      () => installSystemd({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SYSD.TEST_FAILED')
        assert.match(err.message, /退出码 1/)
        assert.ok(isSystemdExecFailure(err.cause))
        assert.equal(err.cause?.phase, 'install')
        assert.equal(err.cause?.step, 'systemd.validate-shadow')
        return true
      },
    )
    assert.equal(runner.files.has('/etc/systemd/system/api.service'), false)
  })

  it('生效 unit 存在但不带 managed 标记 → DP.SYSD.UNIT_NOT_MANAGED，连影子目录都不建', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set('/etc/systemd/system/api.service', '[Unit]\nDescription=hand written\n')
    await assert.rejects(
      () => installSystemd({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SYSD.UNIT_NOT_MANAGED')
        assert.match(err.message, /不带 managed 标记/)
        return true
      },
    )
    assert.equal(runner.files.has(unitPaths(makeCtx(), makeConfig()).candidate), false)
  })

  it('force 时允许覆盖，但仍然先备份', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set('/etc/systemd/system/api.service', '[Unit]\nDescription=hand written\n')
    const result = await installSystemd({ runner, ctx: makeCtx(), config: makeConfig({ force: true }) })
    assert.equal(result.ownership?.action, 'replace')
    assert.equal(result.ownership?.backup, true)
  })

  it('--dry-run 只跑只读校验：结束后不留文件与目录，也不发 daemon-reload / restart', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    const dirsBefore = new Set(runner.dirs)
    const result = await installSystemd({
      runner,
      ctx: makeCtx(),
      config: makeConfig(),
      dryRun: true,
    })
    assert.equal(result.dryRun, true)
    // 影子目录撤掉了；生效 unit 从头到尾没被碰
    assert.equal(runner.files.size, 0)
    assert.equal(runner.files.has('/etc/systemd/system/api.service'), false)
    // recursive mkdir 顺着建出来的 releases/ 与版本目录也要撤掉：留下两个空目录，
    // 「--dry-run 不碰磁盘」就只剩字面成立（目录在、索引不在，会让「部署过吗」多一层噪音）
    assert.deepEqual([...runner.dirs].sort(), [...dirsBefore].sort())
    // analyze verify 是只读的，dry-run 照跑 —— 它就是这次演练唯一想验证的东西
    assert.equal(runner.calls.length, 1)
    assert.equal(runner.calls[0]?.[0], 'systemd-analyze')
    // 走过判定但没动手的步骤记 skipped，不是「跑过了」
    assert.deepEqual(result.steps.map((s) => s.skipped), [false, true, false])
  })
})

describe('systemd 执行器 · activate', () => {
  it('备份 → 原子替换 → daemon-reload → enable → restart', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set('/etc/systemd/system/api.service', `${MANAGED_MARKER}\n[Unit]\n`)
    const result = await activateSystemd({ runner, ctx: makeCtx(), config: makeConfig() })

    assert.deepEqual(result.steps.map((s) => s.id), [
      'systemd.backup',
      'systemd.replace',
      'systemd.daemon-reload',
      'systemd.enable',
      'systemd.restart',
    ])
    // 备份走 rename，替换走「写中间文件 + rename」：任何时刻 unitDir 里都有完整的一份
    assert.equal(runner.files.has('/etc/systemd/system/api.service.dp-backup'), true)
    assert.equal(runner.files.has('/etc/systemd/system/api.service.dp-new'), false)
    assert.equal(result.reloaded, true)
    assert.equal(result.enabled, true)
    assert.equal(result.restarted, true)
  })

  it('enabled: false 时不发 enable，但服务照旧重启（关自启不等于关服务）', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    const result = await activateSystemd({ runner, ctx: makeCtx(), config: makeConfig({ enabled: false }) })
    assert.equal(result.enabled, false)
    assert.equal(result.restarted, true)
    assert.ok(!runner.calls.some((argv) => argv.includes('enable')), JSON.stringify(runner.calls))
  })

  it('enable 失败 → DP.SYSD.ENABLE_FAILED，说清「服务在跑、重启后起不来」', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set('/etc/systemd/system/api.service', `${MANAGED_MARKER}\n[Unit]\n`)
    runner.handler = (argv) =>
      argv.includes('enable') ? { code: 1, stdout: '', stderr: 'Failed to enable unit' } : { code: 0, stdout: '', stderr: '' }
    await assert.rejects(
      () => activateSystemd({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SYSD.ENABLE_FAILED')
        assert.match(String(err.hint ?? ''), /重启后/)
        return true
      },
    )
    // 不回滚：unit 是好的、服务已经起过，只为一条软链退掉一次成功发布更糟
    assert.equal(runner.files.get('/etc/systemd/system/api.service')?.includes('ExecStart='), true)
  })

  it('user scope 时 systemctl 带 --user，且范围选项排在子命令之前', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    await activateSystemd({ runner, ctx: makeCtx(), config: makeConfig({ scope: 'user' }) })
    assert.deepEqual(runner.calls[0], ['systemctl', '--user', 'daemon-reload'])
    assert.deepEqual(runner.calls[1], ['systemctl', '--user', 'enable', 'api.service'])
    assert.deepEqual(runner.calls[2], ['systemctl', '--user', 'restart', 'api.service'])
  })

  it('restart 失败 → DP.SYSD.RESTART_FAILED，且不还原 unit（为一个服务问题退掉一次成功的发布更糟）', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set('/etc/systemd/system/api.service', `${MANAGED_MARKER}\n[Unit]\n`)
    runner.handler = (argv) =>
      argv.includes('restart') ? { code: 1, stdout: '', stderr: 'Job failed' } : { code: 0, stdout: '', stderr: '' }
    await assert.rejects(
      () => activateSystemd({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SYSD.RESTART_FAILED')
        assert.ok(isSystemdExecFailure(err.cause))
        assert.equal(err.cause?.step, 'systemd.restart')
        return true
      },
    )
    // unit 已按新内容落盘（未回滚成 dp-backup 的内容）
    assert.equal(runner.files.get('/etc/systemd/system/api.service')?.includes('ExecStart='), true)
  })
})

describe('systemd 执行器 · verify', () => {
  it('is-active 退出码 0 → 通过', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    const result = await verifySystemd({ runner, ctx: makeCtx(), config: makeConfig() })
    assert.equal(result.phase, 'verify')
    assert.equal(result.steps[0]?.ok, true)
    assert.deepEqual(runner.calls[0], ['systemctl', 'is-active', 'api.service'])
  })

  it('is-active 非 0 → DP.SYSD.NOT_ACTIVE，并把读到的状态带上', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.handler = () => ({ code: 3, stdout: 'failed', stderr: '' })
    await assert.rejects(
      () => verifySystemd({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SYSD.NOT_ACTIVE')
        assert.match(err.message, /failed/)
        return true
      },
    )
  })
})

describe('systemd 执行器 · rollback', () => {
  it('没有备份 unit → DP.SYSD.NO_PREVIOUS，不返回假成功', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    await assert.rejects(
      () => rollbackSystemd({ runner, ctx: makeCtx({ previousReleaseId: 'r1' }), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SYSD.NO_PREVIOUS')
        return true
      },
    )
  })

  it('有备份时：还原 → daemon-reload → restart → 复验', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set('/etc/systemd/system/api.service.dp-backup', `${MANAGED_MARKER}\n[Unit]\nDescription=old\n`)
    const result = await rollbackSystemd({
      runner,
      ctx: makeCtx({ previousReleaseId: 'r1' }),
      config: makeConfig(),
    })

    assert.deepEqual(result.steps.map((s) => s.id), [
      'systemd.restore-backup',
      'systemd.daemon-reload-rollback',
      'systemd.restart-rollback',
      'systemd.is-active-rollback',
    ])
    // 备份被 rename 消耗，没有第二份可退
    assert.equal(runner.files.has('/etc/systemd/system/api.service.dp-backup'), false)
    assert.equal(runner.files.get('/etc/systemd/system/api.service'), `${MANAGED_MARKER}\n[Unit]\nDescription=old\n`)
    assert.equal(result.restarted, true)
  })
})
