import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DpError, type ExecResult } from '@dp/ports'
import { defaultFacts } from './facts.js'
import { MemoryRunner, assertExecInvariants, currentReleaseId } from './mem-runner.js'

const OK: ExecResult = { code: 0, stdout: '', stderr: '' }

describe('MemoryRunner · 文件树', () => {
  it('mkdir 递归建链、writeFile/readFile/stat/listDir 走通', async () => {
    const runner = new MemoryRunner(defaultFacts())

    await runner.mkdir('/srv/web/releases/r1/assets')
    await runner.writeFile('/srv/web/releases/r1/assets/index.html', 'v1')

    assert.equal(await runner.readFile('/srv/web/releases/r1/assets/index.html'), 'v1')
    const stat = await runner.stat('/srv/web/releases/r1/assets/index.html')
    assert.equal(stat?.isDirectory, false)
    assert.equal(stat?.size, 2)
    assert.deepEqual(await runner.listDir('/srv/web/releases/r1'), ['assets'])
    assert.equal(await runner.stat('/srv/web/nothing'), null)
  })

  it('remove 级联删子树，rename 整树搬移并覆盖目标', async () => {
    const runner = new MemoryRunner(defaultFacts())
    await runner.mkdir('/srv/a/b')
    await runner.writeFile('/srv/a/b/f.txt', 'x')

    await runner.rename('/srv/a', '/srv/c')
    assert.equal(await runner.readFile('/srv/c/b/f.txt'), 'x')
    assert.equal(await runner.stat('/srv/a'), null)

    await runner.mkdir('/srv/keep')
    await runner.writeFile('/srv/keep/old.txt', 'old')
    await runner.rename('/srv/c', '/srv/keep')
    assert.equal(await runner.readFile('/srv/keep/b/f.txt'), 'x')
    assert.equal(await runner.stat('/srv/keep/old.txt'), null, 'rename 必须先清目标')
  })

  it('readFile 目标不存在 → 报 NOT_WRITABLE 且点名路径', async () => {
    const runner = new MemoryRunner(defaultFacts())
    await assert.rejects(runner.readFile('/srv/missing'), (err: unknown) => {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.PATH.NOT_WRITABLE')
      assert.match(err.message, /\/srv\/missing/)
      return true
    })
  })

  it('canSymlink 关着时 symlink 当场拒绝；开着时读回 target', async () => {
    const off = new MemoryRunner(defaultFacts({ capabilities: { canSymlink: false } }))
    await assert.rejects(off.symlink('/srv/r1', '/srv/current'), (err: unknown) => {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.PATH.NOT_WRITABLE')
      return true
    })

    const on = new MemoryRunner(defaultFacts())
    await on.symlink('/srv/releases/r1', '/srv/current')
    assert.equal(await on.readlink('/srv/current'), '/srv/releases/r1')
    assert.equal((await on.stat('/srv/current'))?.isSymbolicLink, true)
  })

  it('peek 同步读树：文件给内容、软链给 target，目录与不存在的路径给 null', async () => {
    const runner = new MemoryRunner(defaultFacts())
    await runner.writeFile('/srv/f.txt', 'v1')
    await runner.symlink('/srv/f.txt', '/srv/current')
    await runner.mkdir('/srv/dir')

    assert.equal(runner.peek('/srv/f.txt'), 'v1')
    assert.equal(runner.peek('/srv/current'), '/srv/f.txt')
    assert.equal(runner.peek('/srv/dir'), null)
    assert.equal(runner.peek('/srv/missing'), null)
  })

  it('writeFile 缺省不查父目录；requireParentDir 打开后漏 mkdir 当场失败', async () => {
    const lax = new MemoryRunner(defaultFacts())
    await lax.writeFile('/srv/orphan.txt', 'x')
    assert.equal(await lax.readFile('/srv/orphan.txt'), 'x')
    assert.equal((await lax.stat('/srv'))?.isDirectory, true, '写进来的父链是真实目录，后续 rename 才有的搬')

    const strict = new MemoryRunner(defaultFacts(), { requireParentDir: true })
    await assert.rejects(strict.writeFile('/srv/nodir/f.txt', 'x'), (err: unknown) => {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.PATH.NOT_WRITABLE')
      return true
    })
  })

  it('rename 源没有目录或文件节点 → 当场点名，绝不造一个空目录假装成功', async () => {
    const runner = new MemoryRunner(defaultFacts())
    await assert.rejects(runner.rename('/srv/missing', '/srv/new'), (err: unknown) => {
      assert.ok(err instanceof DpError)
      assert.match(err.message, /\/srv\/missing/)
      return true
    })
  })
})

describe('MemoryRunner · exec', () => {
  it('未注册的 argv 抛错，但那一笔已进台账（报错里带得上 argv 才能指导下一步）', async () => {
    const runner = new MemoryRunner(defaultFacts())
    const missing = ['nginx', '-t']

    await assert.rejects(runner.exec(missing, { timeoutMs: 1000 }), (err: unknown) => {
      return err instanceof Error && err.message.includes(JSON.stringify(missing))
    })
    assert.equal(runner.execs.length, 1)
    assert.equal(runner.execs[0]?.options?.timeoutMs, 1000)
  })

  it('注册的应答按整段 argv 精确命中，cwd/stdin 逐项入账', async () => {
    const runner = new MemoryRunner(defaultFacts())
    runner.on(['docker', 'pull'], { code: 0, stdout: 'Pulled', stderr: '' })
    runner.on(['docker', 'push'], OK)

    assert.deepEqual(
      await runner.exec(['docker', 'pull'], { cwd: '/srv/app', timeoutMs: 500 }),
      { code: 0, stdout: 'Pulled', stderr: '' },
      '返回的就是按结尾完整 argv 命中的那份注册应答',
    )
    await runner.exec(['docker', 'push'], { timeoutMs: 500 })

    assert.deepEqual(runner.argvs(), [['docker', 'pull'], ['docker', 'push']])
    assert.equal(runner.execs[0]?.options?.cwd, '/srv/app')
    // 多出来的一个参数就让它出局 —— 「精确」指整段逐元素，共享前缀/共享后缀都不算命中
    await assert.rejects(runner.exec(['docker', 'pull', '--verbose'], { timeoutMs: 10 }), (err: unknown) => {
      return err instanceof Error && err.message.includes(JSON.stringify(['docker', 'pull', '--verbose']))
    })
    assertExecInvariants(runner)
  })

  it('defaultExec 是家族兜底：返回结果就放行，返回 undefined 照样当计划外', async () => {
    const runner = new MemoryRunner(defaultFacts(), {
      defaultExec: (argv) => (argv[0] === 'git' ? OK : undefined),
    })
    assert.deepEqual(await runner.exec(['git', 'status'], { timeoutMs: 100 }), { code: 0, stdout: '', stderr: '' })
    await assert.rejects(runner.exec(['nginx', '-t'], { timeoutMs: 100 }), (err: unknown) => {
      return err instanceof Error && err.message.includes(JSON.stringify(['nginx', '-t']))
    })
  })

  it('assertExecInvariants 让缺 timeout 的命令当场红', () => {
    const runner = new MemoryRunner(defaultFacts())
    runner.execs.push({ argv: ['ssh'], options: {} })
    assert.throws(
      () => assertExecInvariants(runner),
      (err: unknown) => err instanceof Error && err.message.includes('timeoutMs'),
    )
  })

  it('assertExecInvariants 收结构化的 exec 台账：本地测试桩不必换成 MemoryRunner', () => {
    assertExecInvariants({ execs: [{ argv: ['nginx', '-t'], options: { timeoutMs: 100 } }] })
    assert.throws(
      () => assertExecInvariants({ execs: [{ argv: ['ssh'], options: {} }] }),
      (err: unknown) => err instanceof Error && err.message.includes('timeoutMs'),
    )
  })
})

describe('currentReleaseId', () => {
  it('读 current 软链的最后一段；没有软链给 null', async () => {
    const runner = new MemoryRunner(defaultFacts())
    assert.equal(await currentReleaseId(runner, '/srv/web'), null)

    await runner.mkdir('/srv/web/releases/r1')
    await runner.writeFile('/srv/web/releases/r1/index.html', 'v1')
    await runner.symlink('/srv/web/releases/r1', '/srv/web/current')
    assert.equal(await currentReleaseId(runner, '/srv/web'), 'r1')
  })
})
