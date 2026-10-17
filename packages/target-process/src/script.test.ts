import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import {
  MANAGED_MARKER,
  graceSecondsOf,
  renderStartScript,
  renderStopScript,
  shellQuote,
  type StartScriptInput,
} from './script.js'

function makeInput(over: Partial<StartScriptInput> = {}): StartScriptInput {
  return {
    command: '/srv/app/current/bin/api',
    args: ['--port', '8080'],
    workingDirectory: '/srv/app/current',
    pidFile: '/srv/app/.dp/process.pid',
    stdoutLog: '/srv/app/.dp/process.log',
    env: {},
    ...over,
  }
}

describe('process 脚本 · 渲染', () => {
  it('启动脚本带 managed 标记，且立即返回（不把服务进程 exec 成前台进程）', () => {
    const script = renderStartScript(makeInput())
    assert.ok(script.startsWith('#!/bin/sh\n'))
    assert.ok(script.includes(MANAGED_MARKER), '缺少 managed 标记：将来无法判断这个文件是不是 dp 写的')
    // 后台启动 + exit 0：runner.exec 会等子进程结束，前台 exec 会让部署卡到超时
    assert.ok(script.includes('&'), '服务进程必须进后台')
    assert.ok(script.trimEnd().endsWith('exit 0'), '脚本必须立即返回')
  })

  it('命令与参数按单引号规则引用，值里的空格、引号、$ 都不被 shell 解释', () => {
    const script = renderStartScript(makeInput({ command: "sh -c 'echo $HOME'", args: ["a b", "it's"] }))
    assert.ok(script.includes(`'sh -c '\\''echo $HOME'\\'''`), script)
    assert.ok(script.includes(`'a b'`))
    assert.ok(script.includes(`'it'\\''s'`), script)
  })

  it('环境变量烘进脚本，且按名字排序（同一份配置两次渲染结果一致）', () => {
    const script = renderStartScript(makeInput({ env: { PORT: '8080', HOME_DIR: '/srv', NODE_ENV: 'prod' } }))
    const exports = script.split('\n').filter((line) => line.startsWith('export '))
    assert.deepEqual(exports, [`export HOME_DIR='/srv'`, `export NODE_ENV='prod'`, `export PORT='8080'`])
  })

  it('pidfile 与日志的父目录先建（发布根下的 .dp 是第一次部署才有的）', () => {
    const script = renderStartScript(makeInput())
    assert.match(script, /mkdir -p '\/srv\/app\/\.dp'/)
  })

  it('没有 setsid 时退回普通后台进程，两条分支都把 pid 写进 pidfile', () => {
    const script = renderStartScript(makeInput())
    assert.ok(script.includes('command -v setsid'), '必须先探测再分支，不能默认它有')
    const bodies = script.split('\n').filter((line) => line.includes('echo $$ >"$1"'))
    assert.equal(bodies.length, 2, 'setsid 分支与退回分支各一份')
    for (const line of bodies) assert.ok(line.includes(`'/srv/app/.dp/process.pid'`), line)
  })

  it('停止脚本：发信号 → 轮询 → 强杀 → **再确认一次**（只发 KILL 就当成功是假成功）', () => {
    const script = renderStopScript({ pidFile: '/srv/app/.dp/process.pid', stopSignal: 'SIGTERM', stopTimeoutMs: 10_000 })
    assert.match(script, /kill -s "\$DP_SIGNAL"/)
    assert.match(script, /kill -KILL "\$DP_PID"/)
    const checks = script.split('\n').filter((line) => line.includes('dp_alive "$DP_PID"'))
    assert.ok(checks.length >= 3, `强杀之后还要再查一次：${script}`)
    assert.match(script, /exit 1/, '仍活着必须报错，而不是假装停掉了')
  })

  it('优雅期烘成整秒并保底 1 秒（0 会让轮询体一次都不跑）', () => {
    assert.equal(graceSecondsOf(0), 1)
    assert.equal(graceSecondsOf(1), 1)
    assert.equal(graceSecondsOf(1500), 2)
    assert.equal(graceSecondsOf(10_000), 10)
    assert.ok(renderStopScript({ pidFile: '/x/.dp/p.pid', stopSignal: 'SIGTERM', stopTimeoutMs: 0 }).includes('DP_GRACE="1"'))
  })
})

describe('process 脚本 · 拒绝不合法的输入', () => {
  it('命令含换行 → DP.PROC.COMMAND_INVALID（一行会变成两条命令）', () => {
    assert.throws(
      () => renderStartScript(makeInput({ command: 'api\nrm -rf /' })),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.PROC.COMMAND_INVALID')
        assert.equal(err.path, 'projects.*.target.process.command')
        return true
      },
    )
  })

  it('参数含控制字符同样拒绝', () => {
    assert.throws(
      () => renderStartScript(makeInput({ args: ['--name\u0007x'] })),
      (err: unknown) => err instanceof DpError && err.code === 'DP.PROC.COMMAND_INVALID',
    )
  })

  it('环境变量名不是 shell 写得出来的形状 → 拒绝（拼进 export 那一行会变成别的语法）', () => {
    assert.throws(
      () => renderStartScript(makeInput({ env: { 'PORT; rm -rf /': '1' } })),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.PROC.COMMAND_INVALID')
        assert.equal(err.path, 'projects.*.target.process.env')
        return true
      },
    )
  })

  it('环境变量值含控制字符 → 拒绝', () => {
    assert.throws(
      () => renderStartScript(makeInput({ env: { NOTE: 'a\nb' } })),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.PROC.COMMAND_INVALID')
        assert.equal(err.path, 'projects.*.target.process.env.NOTE')
        return true
      },
    )
  })

  it('信号名含控制字符 → 拒绝', () => {
    assert.throws(
      () => renderStopScript({ pidFile: '/x/.dp/p.pid', stopSignal: 'SIG\nTERM', stopTimeoutMs: 1000 }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.PROC.COMMAND_INVALID',
    )
  })
})

describe('shellQuote', () => {
  it('单引号按 POSIX 规则转义', () => {
    assert.equal(shellQuote("it's"), `'it'\\''s'`)
    assert.equal(shellQuote('$HOME `whoami`'), `'$HOME \`whoami\`'`)
  })
})
