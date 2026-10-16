import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError, type TargetContext } from '@dp/ports'
import {
  aliveArgv,
  previousStartArgv,
  processPaths,
  processTarget,
  releaseDirOf,
  startArgv,
  stopArgv,
} from './target.js'
import type { ProcessTargetConfig } from './types.js'

function makeConfig(over: Partial<ProcessTargetConfig> = {}): ProcessTargetConfig {
  return {
    command: '/srv/app/current/bin/api',
    render: { project: 'api', env: 'prod', release: { current: '/srv/app/current' } },
    ...over,
  }
}

function makeCtx(over: Partial<TargetContext> = {}): TargetContext {
  return { host: 'fake', root: '/srv/app', releaseId: 'r2', keep: 3, ...over }
}

describe('process target · 落点', () => {
  it('脚本跟着版本目录，pid 与日志落在发布根下的固定位置', () => {
    const paths = processPaths(makeCtx(), makeConfig())
    assert.equal(paths.startScript, '/srv/app/releases/r2/.dp/start.sh')
    assert.equal(paths.stopScript, '/srv/app/releases/r2/.dp/stop.sh')
    assert.equal(paths.pidFile, '/srv/app/.dp/process.pid')
    assert.equal(paths.stdoutLog, '/srv/app/.dp/process.log')
  })

  it('工作目录默认 current 软链，模板变量在这里展开', () => {
    assert.equal(processPaths(makeCtx(), makeConfig()).workingDirectory, '/srv/app/current')
    assert.equal(
      processPaths(makeCtx(), makeConfig({ workingDirectory: '${release.current}/run' })).workingDirectory,
      '/srv/app/current/run',
    )
  })

  it('pidfile 逃出发布根 → DP.PROC.COMMAND_INVALID（那是一条任意文件写入）', () => {
    for (const value of ['/etc/passwd', '../outside.pid']) {
      assert.throws(
        () => processPaths(makeCtx(), makeConfig({ pidFile: value })),
        (err: unknown) => {
          assert.ok(err instanceof DpError)
          assert.equal(err.code, 'DP.PROC.COMMAND_INVALID')
          assert.equal(err.path, 'projects.*.target.process.pidFile')
          return true
        },
        `应当拒绝 ${value}`,
      )
    }
  })

  it('反斜杠写法也拒：它在 POSIX 路径里是合法字符，会让同一个文件有两种写法', () => {
    assert.throws(
      () => processPaths(makeCtx(), makeConfig({ stdoutLog: '.dp\\out.log' })),
      (err: unknown) => err instanceof DpError && err.code === 'DP.PROC.COMMAND_INVALID',
    )
  })

  it('command / args 里的 ${...} 在这里展开：dp 的字符串配置值没有例外', () => {
    const paths = processPaths(makeCtx(), makeConfig({ command: '${release.current}/bin/api', args: ['--conf', '${release.current}/api.conf'] }))
    assert.equal(paths.command, '/srv/app/current/bin/api')
    assert.deepEqual([...paths.args], ['--conf', '/srv/app/current/api.conf'])
  })

  it('args 里缺变量 → 报错定位到那一项的下标', () => {
    assert.throws(
      () => processPaths(makeCtx(), makeConfig({ args: ['ok', '${nope}'] })),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.path, 'projects.*.target.process.args[1]')
        return true
      },
    )
  })

  it('默认值取自同一组常量：改默认值只改一处', () => {
    const paths = processPaths(makeCtx(), makeConfig())
    assert.equal(paths.stopSignal, 'SIGTERM')
    assert.equal(paths.stopTimeoutMs, 10_000)
  })
})

describe('process target · argv', () => {
  it('启动只有一个脚本路径：命令与落点都在渲染期烘进脚本了', () => {
    assert.deepEqual(startArgv(processPaths(makeCtx(), makeConfig())), ['sh', '/srv/app/releases/r2/.dp/start.sh'])
  })

  it('停止同样只有一个脚本路径', () => {
    assert.deepEqual(stopArgv(processPaths(makeCtx(), makeConfig())), ['sh', '/srv/app/releases/r2/.dp/stop.sh'])
  })

  it('回滚跑的是**上一版目录里**那份启动脚本，与当前版本目录无关', () => {
    assert.deepEqual(previousStartArgv(makeCtx(), 'r1'), ['sh', '/srv/app/releases/r1/.dp/start.sh'])
  })

  it('存活断言走 sh -c：kill 常常是 shell 内建，磁盘上未必有可执行文件', () => {
    assert.deepEqual(aliveArgv('4242'), ['sh', '-c', 'kill -0 "$1"', 'sh', '4242'])
  })

  it('版本目录只有一份拼法', () => {
    assert.equal(releaseDirOf(makeCtx(), 'r9'), '/srv/app/releases/r9')
    assert.equal(releaseDirOf({ ...makeCtx(), root: '/srv/app/' }, 'r9'), '/srv/app/releases/r9')
  })
})

describe('process target · plan', () => {
  it('四个阶段都有步骤，每步都写清 undo', () => {
    const ctx = makeCtx({ previousReleaseId: 'r1' })
    const config = makeConfig()
    for (const plan of [
      processTarget.planInstall(ctx, config),
      processTarget.planActivate(ctx, config),
      processTarget.planVerify(ctx, config),
      processTarget.planRollback(ctx, config),
    ]) {
      assert.ok(plan.length > 0)
      for (const step of plan) assert.ok((step.undo ?? '').length > 0, step.id)
    }
  })

  it('install 不启动任何进程（没有 activate 步骤）', () => {
    const plan = processTarget.planInstall(makeCtx(), makeConfig())
    assert.equal(plan.some((s) => s.kind === 'activate'), false)
  })

  it('activate 顺序是 先停旧的 → 再起新的（反了会让两个实例抢同一个端口）', () => {
    const plan = processTarget.planActivate(makeCtx(), makeConfig())
    assert.deepEqual(plan.map((s) => s.id), ['process.stop-current', 'process.start-new'])
  })

  it('每步的 argv 都发布在 detail 里：执行器不许自己另写一份', () => {
    const plan = processTarget.planActivate(makeCtx(), makeConfig())
    for (const step of plan) {
      assert.ok(Array.isArray(step.detail?.['argv']), `${step.id} 没有 detail.argv`)
    }
  })

  it('verify 只发布 pidfile：pid 要等执行期读到才知道', () => {
    const plan = processTarget.planVerify(makeCtx(), makeConfig())
    assert.equal(plan[0]?.detail?.['argv'], undefined)
    assert.equal(plan[0]?.detail?.['pidFile'], '/srv/app/.dp/process.pid')
  })

  it('没有上一版时计划在规划期就拒（DP.PROC.NO_PREVIOUS），而不是跑起来才发现', () => {
    assert.throws(
      () => processTarget.planRollback(makeCtx(), makeConfig()),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.PROC.NO_PREVIOUS')
        return true
      },
    )
  })

  it('回滚的启动步骤指向上一版目录，与当前版本目录不同', () => {
    const plan = processTarget.planRollback(makeCtx({ previousReleaseId: 'r1' }), makeConfig())
    const start = plan.find((s) => s.id === 'process.start-previous')
    assert.deepEqual(start?.detail?.['argv'], ['sh', '/srv/app/releases/r1/.dp/start.sh'])
    assert.equal(start?.detail?.['previousReleaseId'], 'r1')
  })
})
