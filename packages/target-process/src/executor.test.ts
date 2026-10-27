import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ERR,
  DpError,
  type ExecResult,
  type Facts,
  type FileStat,
  type Runner,
  type TargetContext,
} from '@dp/ports'
import { linuxFacts } from '@dp/testkit'
import { SCRIPT_MODE } from './script.js'
import {
  activateProcess,
  aliveArgv,
  installProcess,
  isProcessExecFailure,
  rollbackProcess,
  verifyProcess,
} from './index.js'
import type { ProcessTargetConfig } from './types.js'

// ------------------------------------------------------------
// 内存 Runner：把目标机的文件系统与 sh 行为实现到刚好够用
// ------------------------------------------------------------

class FakeRunner implements Runner {
  readonly id = 'fake'
  readonly facts: Facts
  calls: string[][] = []
  readonly dirs = new Set<string>(['/'])
  readonly files = new Map<string, string>()
  readonly modes = new Map<string, number>()
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
      if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) out.push(key.slice(path.length + 1))
    }
    for (const key of this.files.keys()) {
      if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) out.push(key.slice(path.length + 1))
    }
    return [...new Set(out)].sort()
  }

  async mkdir(path: string): Promise<void> {
    // 模拟 -p：父目录一并建出来，否则 writeFile 会「写进一个不存在的地方」
    let cur = ''
    for (const part of path.split('/').filter((p) => p !== '')) {
      cur = `${cur}/${part}`
      this.dirs.add(cur)
    }
  }

  async writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void> {
    this.files.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
    if (options?.mode !== undefined) this.modes.set(path, options.mode)
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path))
  }

  async readFile(path: string): Promise<string> {
    const value = this.files.get(path)
    if (value === undefined) throw new DpError(ERR.PATH.NOT_WRITABLE, `不存在：${path}`)
    return value
  }

  async remove(path: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) {
        this.files.delete(key)
        this.modes.delete(key)
      }
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
    throw new DpError(ERR.PATH.NOT_WRITABLE, '不支持软链')
  }

  async readlink(): Promise<string | null> {
    return null
  }

  async realpath(path: string): Promise<string> {
    return path
  }
}

function makeConfig(over: Partial<ProcessTargetConfig> = {}): ProcessTargetConfig {
  return {
    command: '/srv/app/current/bin/api',
    args: ['--port', '8080'],
    render: { project: 'api', env: 'prod', release: { current: '/srv/app/current' } },
    ...over,
  }
}

function makeCtx(over: Partial<TargetContext> = {}): TargetContext {
  return { host: 'fake', root: '/srv/app', releaseId: 'r2', keep: 3, ...over }
}

const PID_FILE = '/srv/app/.dp/process.pid'

/** 让「跑启动脚本」这件事真的写出一个 pid，后面的存活断言才有东西可查 */
function startWritesPid(runner: FakeRunner, pid = '4242'): void {
  runner.handler = (argv) => {
    if (argv[1]?.endsWith('/start.sh')) runner.files.set(PID_FILE, pid)
    return { code: 0, stdout: '', stderr: '' }
  }
}

describe('process 执行器 · install', () => {
  it('写两份脚本到版本目录、带执行位，且**一个进程都不启**', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    const result = await installProcess({ runner, ctx: makeCtx(), config: makeConfig() })

    assert.equal(result.phase, 'install')
    assert.deepEqual(result.steps.map((s) => s.id), ['process.render', 'process.write-scripts'])
    assert.equal(runner.files.has('/srv/app/releases/r2/.dp/start.sh'), true)
    assert.equal(runner.files.has('/srv/app/releases/r2/.dp/stop.sh'), true)
    assert.equal(runner.modes.get('/srv/app/releases/r2/.dp/start.sh'), SCRIPT_MODE)
    assert.equal(runner.modes.get('/srv/app/releases/r2/.dp/stop.sh'), SCRIPT_MODE)
    assert.deepEqual(runner.calls, [], 'install 只写文件，不许起进程')
  })

  it('脚本内容烘进了命令、pidfile 与日志位置', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    await installProcess({ runner, ctx: makeCtx(), config: makeConfig({ env: { PORT: '8080' } }) })
    const script = runner.files.get('/srv/app/releases/r2/.dp/start.sh') ?? ''
    assert.ok(script.includes(`'/srv/app/current/bin/api'`), script)
    assert.ok(script.includes(`'--port'`))
    assert.ok(script.includes(`export PORT='8080'`), script)
    assert.ok(script.includes(PID_FILE))
  })

  it('--dry-run 结束后磁盘上没有残留，写脚本那步记 skipped 而不是「跑过了」', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    const dirsBefore = new Set(runner.dirs)
    const result = await installProcess({ runner, ctx: makeCtx(), config: makeConfig(), dryRun: true })

    assert.equal(result.dryRun, true)
    assert.equal(runner.files.size, 0)
    // recursive mkdir 会顺着建出 releases/ 与版本目录，而它们不在旧的撤销范围内 ——
    // 留下一对空目录，「--dry-run 不碰磁盘」就只剩字面成立。它不影响下一次部署，
    // 但会让「这台机器部署过吗」的判断多一层噪音：目录在，索引不在
    assert.deepEqual([...runner.dirs].sort(), [...dirsBefore].sort(), 'dryRun 建出来的目录必须全部撤掉')
    assert.deepEqual(result.steps.map((s) => s.skipped), [false, true])
  })
})

describe('process 执行器 · activate', () => {
  it('先停旧的再起新的；两步的 argv 都取自计划', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set(PID_FILE, '1234')
    startWritesPid(runner)
    const result = await activateProcess({ runner, ctx: makeCtx(), config: makeConfig() })

    assert.deepEqual(runner.calls, [
      ['sh', '/srv/app/releases/r2/.dp/stop.sh'],
      ['sh', '/srv/app/releases/r2/.dp/start.sh'],
    ])
    assert.equal(result.stopped, true)
    assert.equal(result.started, true)
  })

  it('首次部署没有 pidfile → 停那一步记 skipped，不报错', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    startWritesPid(runner)
    const result = await activateProcess({ runner, ctx: makeCtx(), config: makeConfig() })

    assert.deepEqual(runner.calls, [['sh', '/srv/app/releases/r2/.dp/start.sh']])
    assert.equal(result.stopped, false)
    assert.equal(result.started, true)
    assert.deepEqual(result.steps.map((s) => s.skipped), [true, false])
  })

  it('--dry-run 绝不真停进程（停进程不可撤销，演练不能留下这个作用）', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set(PID_FILE, '1234')
    const result = await activateProcess({ runner, ctx: makeCtx(), config: makeConfig(), dryRun: true })

    assert.deepEqual(runner.calls, [])
    assert.equal(result.stopped, false)
    assert.equal(result.started, false)
    assert.deepEqual(result.steps.map((s) => s.skipped), [true, true])
  })

  it('旧进程停不下来 → DP.PROC.STOP_FAILED，且**不接着起新的**（两个实例会抢同一个端口）', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set(PID_FILE, '1234')
    runner.handler = () => ({ code: 1, stdout: '', stderr: 'dp: 进程 1234 在优雅期与强杀之后仍然存活' })
    await assert.rejects(
      () => activateProcess({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.PROC.STOP_FAILED)
        assert.ok(isProcessExecFailure(err.cause))
        assert.equal(err.cause?.step, 'process.stop-current')
        assert.match(String(err.hint ?? ''), /没有启动新版本/)
        return true
      },
    )
    assert.deepEqual(runner.calls, [['sh', '/srv/app/releases/r2/.dp/stop.sh']], '停失败后不许再起')
  })

  it('新进程起不来 → DP.PROC.START_FAILED，说清服务是空窗的', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set(PID_FILE, '1234')
    runner.handler = (argv) =>
      argv[1]?.endsWith('/start.sh')
        ? { code: 127, stdout: '', stderr: 'sh: /srv/app/current/bin/api: not found' }
        : { code: 0, stdout: '', stderr: '' }
    await assert.rejects(
      () => activateProcess({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.PROC.START_FAILED)
        assert.match(String(err.hint ?? ''), /空窗/)
        assert.ok(isProcessExecFailure(err.cause))
        assert.match(String(err.cause?.output ?? ''), /not found/, '子进程原话必须进错误信息')
        return true
      },
    )
  })

  it('不合法的命令在渲染期就被拒：不产出脚本，也不起进程', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    await assert.rejects(
      () => installProcess({ runner, ctx: makeCtx(), config: makeConfig({ command: 'api\nrm -rf /' }) }),
      (err: unknown) => err instanceof DpError && err.code === ERR.PROC.COMMAND_INVALID,
    )
    assert.equal(runner.files.size, 0)
    assert.deepEqual(runner.calls, [])
  })
})

describe('process 执行器 · verify', () => {
  it('pidfile 里的 pid 还活着 → 通过', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set(PID_FILE, '4242')
    const result = await verifyProcess({ runner, ctx: makeCtx(), config: makeConfig() })
    assert.equal(result.phase, 'verify')
    assert.deepEqual(runner.calls, [aliveArgv('4242')])
  })

  it('没有 pidfile → DP.PROC.NOT_RUNNING（进程没把自己记下来，通常是启动时就退了）', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    await assert.rejects(
      () => verifyProcess({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.PROC.NOT_RUNNING)
        return true
      },
    )
  })

  it('pid 还在 pidfile 里但进程没了 → DP.PROC.NOT_RUNNING', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set(PID_FILE, '4242')
    runner.handler = () => ({ code: 1, stdout: '', stderr: 'sh: kill: (4242) - No such process' })
    await assert.rejects(
      () => verifyProcess({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.PROC.NOT_RUNNING)
        assert.match(String(err.message), /4242/)
        return true
      },
    )
  })

  it('pidfile 里不是 pid → 同样判不存在（不当成一个 pid 去 kill）', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set(PID_FILE, 'not-a-pid')
    await assert.rejects(
      () => verifyProcess({ runner, ctx: makeCtx(), config: makeConfig() }),
      (err: unknown) => err instanceof DpError && err.code === ERR.PROC.NOT_RUNNING,
    )
    assert.deepEqual(runner.calls, [], '不该拿一个不是 pid 的值去发信号')
  })
})

describe('process 执行器 · rollback', () => {
  it('跑的是上一版目录里那份启动脚本，不是当前版本目录', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set('/srv/app/releases/r1/.dp/start.sh', '#!/bin/sh\n')
    runner.files.set(PID_FILE, '1234')
    startWritesPid(runner)
    const result = await rollbackProcess({
      runner,
      ctx: makeCtx({ previousReleaseId: 'r1' }),
      config: makeConfig(),
    })

    assert.deepEqual(runner.calls, [
      ['sh', '/srv/app/releases/r2/.dp/stop.sh'],
      ['sh', '/srv/app/releases/r1/.dp/start.sh'],
      aliveArgv('4242'),
    ])
    assert.equal(result.phase, 'rollback')
    assert.equal(result.started, true)
  })

  it('上一版脚本不在（被 prune 或从未部署）→ DP.PROC.NO_PREVIOUS，**不返回假成功**', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set(PID_FILE, '1234')
    await assert.rejects(
      () => rollbackProcess({ runner, ctx: makeCtx({ previousReleaseId: 'r1' }), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.PROC.NO_PREVIOUS)
        assert.ok(isProcessExecFailure(err.cause))
        assert.equal(err.cause?.step, 'process.start-previous')
        return true
      },
    )
    assert.deepEqual(runner.calls, [['sh', '/srv/app/releases/r2/.dp/stop.sh']], '没有目标时不许起任何东西')
  })

  it('上一版脚本起不来 → DP.PROC.START_FAILED（旧进程已停，服务是空窗的）', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set('/srv/app/releases/r1/.dp/start.sh', '#!/bin/sh\n')
    runner.files.set(PID_FILE, '1234')
    // 停要成功 —— 这一条要验的是「停完起不来」那个现场，不是停失败
    runner.handler = (argv) =>
      argv[1]?.endsWith('/start.sh') ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '', stderr: '' }
    await assert.rejects(
      () => rollbackProcess({ runner, ctx: makeCtx({ previousReleaseId: 'r1' }), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.PROC.START_FAILED)
        assert.equal(isProcessExecFailure(err.cause) ? err.cause.step : '', 'process.start-previous')
        return true
      },
    )
  })

  it('回滚后进程没活下来 → DP.PROC.NOT_RUNNING（上一版的服务本来就是坏的）', async () => {
    const runner = new FakeRunner(linuxFacts({ host: 'fake' }))
    runner.files.set('/srv/app/releases/r1/.dp/start.sh', '#!/bin/sh\n')
    runner.files.set(PID_FILE, '1234')
    // 存活断言那一发单独打回「进程没了」：要验的是「起完了却没活下来」这个现场
    runner.handler = (argv) =>
      argv[0] === 'sh' && String(argv[2]).includes('kill -0 "$1"')
        ? { code: 1, stdout: '', stderr: 'gone' }
        : { code: 0, stdout: '', stderr: '' }
    await assert.rejects(
      () => rollbackProcess({ runner, ctx: makeCtx({ previousReleaseId: 'r1' }), config: makeConfig() }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.PROC.NOT_RUNNING)
        assert.match(String(err.hint ?? ''), /上一版的服务本来就是坏的/)
        return true
      },
    )
  })
})
