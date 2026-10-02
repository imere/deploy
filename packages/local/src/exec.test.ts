/**
 * 命令执行包装层的测试。
 *
 * 这里验的是**安全属性**，不是功能：不经过 shell、不交互、不无限等待。
 * 三条里任何一条破掉，部署就可能在 CI 里永久挂住或被注入。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DpError } from '@dp/ports'
import { detectPrompt, resolveTool, run } from './exec.js'

describe('exec · 命令查找', () => {
  it('能找到 node', () => {
    const exe = resolveTool('node', process.env as Record<string, string | undefined>)
    assert.ok(exe !== null && exe.length > 0)
  })

  it('找不到的工具返回 null，而不是抛异常让上层去猜', () => {
    assert.equal(
      resolveTool('definitely-not-a-real-binary-xyz', process.env as Record<string, string | undefined>),
      null,
    )
  })
})

describe('exec · 基本执行', () => {
  it('拿到 stdout 与 code', async () => {
    const res = await run(['node', '-e', 'console.log("hi")'], { timeoutMs: 15_000 })
    assert.equal(res.code, 0)
    assert.equal(res.stdout.trim(), 'hi')
  })

  it('可执行文件不存在时报出可指导下一步的错误', async () => {
    await assert.rejects(run(['nope-not-real'], { timeoutMs: 5000 }), (err: unknown) => {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'CONFIG_INVALID')
      assert.ok(err.hint !== undefined && err.hint.length > 0)
      return true
    })
  })
})

describe('exec · 永不经过 shell（命令注入的面从这里掐掉）', () => {
  it('参数里的 shell 元字符不会被解释', async () => {
    const marker = join(tmpdir(), `dp-should-not-exist-${Date.now()}`)
    // 不用 touch —— 那是 Windows 上没有的 shell 命令；改成让 node 自己建文件
    const payload = `x"; require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'pwned'); //`

    const res = await run(['node', '-e', 'console.log(process.argv[1])', payload], {
      timeoutMs: 15_000,
    })

    assert.equal(res.code, 0)
    assert.equal(res.stdout.trim(), payload, '参数必须原样到达')
    assert.equal(existsSync(marker), false, '元字符若被执行就说明经过了 shell')
  })

  it('$() 与反引号同样不被求值', async () => {
    const res = await run(['node', '-e', 'console.log(process.argv[1])', '$(id)`id`'], {
      timeoutMs: 15_000,
    })
    assert.equal(res.stdout.trim(), '$(id)`id`')
  })
})

describe('exec · 永不交互', () => {
  it('输出里出现 Password: 立刻终止并报结构化错误', async () => {
    await assert.rejects(
      run(['node', '-e', 'process.stdout.write("Password:")'], { timeoutMs: 10_000 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.INTERACTIVE_PROMPT_DETECTED')
        assert.ok(err.hint?.includes('免密'))
        return true
      },
    )
  })

  it('sudo 提示与 ssh 首次连接确认都能识别', () => {
    assert.ok(detectPrompt('[sudo] password for deploy:') !== undefined)
    assert.ok(detectPrompt('Are you sure you want to continue connecting (yes/no)?') !== undefined)
    assert.ok(detectPrompt('nothing here') === undefined)
  })

  it('detectPrompt 支持用户追加自己的模式', () => {
    // 不同发行版 su 的措辞不一样，我们不穷举，留给使用者扩展
    const extra = [/^\s*请输入密码/im]
    assert.ok(detectPrompt('请输入密码：', extra) !== undefined)
    assert.equal(detectPrompt('请输入密码：'), undefined)
  })
})

describe('exec · 永不无限等待', () => {
  it('超时即失败，而不是挂在那里', async () => {
    await assert.rejects(
      run(['node', '-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 400 }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.TIMEOUT.EXEC')
        return true
      },
    )
  })
})
