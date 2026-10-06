import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { main, VERSION } from './index.js'
import { EXIT_CONFIG, EXIT_OK, EXIT_USAGE } from './output.js'

const BIN = resolvePath(fileURLToPath(import.meta.url), '..', 'bin.js')

/**
 * 子进程兜底：铁律 0 —— 挂起 = 失败。
 *
 * 阈值取 5 分钟而不是「看起来够用」的 1 分钟，依据是实测的波动幅度：
 * 同一条命令手动跑 1.1s，但在全量测试里（覆盖率插桩 + 多文件并行）实测 60–65s，
 * 慢 50 倍以上；把测试并发从 8 降到 2 也一样慢，说明这不是争抢而是本机进程创建的性质。
 * 于是 60s 恰好卡在阈值上，隔一次红一次 —— 那不是命令超时，是阈值在掷硬币。
 *
 * 放宽不等于放弃检测：真挂起是**永久**等待，5 分钟一样抓得到，
 * 而它只在真挂起时才付出等待。真要收紧，先去把本机那 50 倍搞清楚。
 */
const CHILD_TIMEOUT_MS = 300_000

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

function runBin(args: readonly string[], cwd: string): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`子进程超时（${CHILD_TIMEOUT_MS}ms）：dp ${args.join(' ')}`))
    }, CHILD_TIMEOUT_MS)
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-cli-e2e-'))
  try {
    await fs.mkdir(join(dir, 'dist', 'assets'), { recursive: true })
    await fs.writeFile(join(dir, 'dist', 'index.html'), '<h1>hi</h1>', 'utf8')
    await fs.writeFile(join(dir, 'dist', 'assets', 'app.js'), 'console.log(1)', 'utf8')
    await fs.writeFile(
      join(dir, 'deploy.config.json'),
      JSON.stringify(
        {
          hosts: { local: { local: true } },
          // release.root 显式指向工作区本身：通用候选（~/web 等）在干净机器上
          // 未必已存在，而 plan 只做只读探测、不建目录
          projects: { web: { source: { root: './dist' }, release: { root: dir } } },
        },
        null,
        2,
      ),
      'utf8',
    )
    await fn(dir)
  } finally {
    // 清理失败**绝不许盖掉用例真正的失败原因**：finally 里抛出的错误会替换掉 body 的错误。
    // 实测踩过一次：子进程因超时被 SIGKILL，句柄还没释放，rm 报 EBUSY ——
    // 于是日志里只剩 `rmdir EBUSY`，真实的「子进程超时 60000ms」被吃掉了，看日志根本查不到。
    // 工作区在临时目录里，清不掉留给系统；用例的结论比清理重要。
    try {
      await fs.rm(dir, { recursive: true, force: true })
    } catch {
      try {
        await new Promise((r) => setTimeout(r, 200))
        await fs.rm(dir, { recursive: true, force: true })
      } catch {
        /* 仍清不掉就放弃：临时目录由系统回收，不能让它改变用例的结论 */
      }
    }
  }
}

describe('cli · 端到端冒烟（真子进程，零网络）', () => {
  it('plan --json：退出码 0，输出含预期 step', async () => {
    await withWorkspace(async (dir) => {
      const r = await runBin(['plan', '--json'], dir)
      assert.equal(r.code, EXIT_OK, `stderr: ${r.stderr}`)
      const parsed = JSON.parse(r.stdout) as {
        ok: boolean
        project: string
        host: string
        plan: { steps: ReadonlyArray<{ kind: string; id: string }>; releaseRoot: string }
      }
      assert.equal(parsed.ok, true)
      assert.equal(parsed.project, 'web')
      assert.equal(parsed.host, 'local')
      const kinds = parsed.plan.steps.map((s) => s.kind)
      for (const expected of ['prepare', 'transfer', 'install', 'activate', 'verify', 'prune']) {
        assert.ok(kinds.includes(expected), `缺少 step ${expected}，实际 ${kinds.join(',')}`)
      }
      assert.ok(parsed.plan.releaseRoot.length > 0)
    })
  })

  it('plan（pretty）：默认干跑，且明说没写任何东西', async () => {
    await withWorkspace(async (dir) => {
      const r = await runBin(['plan'], dir)
      assert.equal(r.code, EXIT_OK, `stderr: ${r.stderr}`)
      assert.match(r.stdout, /plan · 布局/)
      assert.match(r.stdout, /\[transfer\]/)
      assert.match(r.stdout, /只读干跑/)
    })
  })

  it('plan 只读：跑完没有在源目录里留下任何东西', async () => {
    await withWorkspace(async (dir) => {
      const before = await fs.readdir(join(dir, 'dist'))
      await runBin(['plan', '--json'], dir)
      const after = await fs.readdir(join(dir, 'dist'))
      assert.deepEqual(after.sort(), before.sort(), '只读命令不允许改动源目录')
      const root = await fs.readdir(dir)
      assert.deepEqual(root.sort(), ['deploy.config.json', 'dist'].sort(), '不允许在工作区新建文件')
    })
  })

  it('schema：输出合法 JSON 且带 $schema 友好的结构', async () => {
    await withWorkspace(async (dir) => {
      const r = await runBin(['schema'], dir)
      assert.equal(r.code, EXIT_OK)
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>
      assert.equal(parsed['type'], 'object')
      assert.ok(parsed['properties'] !== undefined)
    })
  })

  it('facts --host local --json：退出码 0 且是完整 Facts', async () => {
    await withWorkspace(async (dir) => {
      const r = await runBin(['facts', '--host', 'local', '--json'], dir)
      assert.equal(r.code, EXIT_OK, `stderr: ${r.stderr}`)
      const parsed = JSON.parse(r.stdout) as { ok: boolean; facts: Record<string, unknown> }
      assert.equal(parsed.ok, true)
      assert.ok(parsed.facts['capabilities'] !== undefined)
      assert.ok(typeof parsed.facts['platform'] === 'string')
    })
  })
})

describe('cli · 退出码与错误输出（走 main()，不起子进程）', () => {
  it('--help 退出 0', async () => {
    const lines: string[] = []
    assert.equal(await main(['--help'], { write: (t) => lines.push(t) }), EXIT_OK)
    assert.match(lines.join(''), /用法/)
  })

  it('help plan 等价于 plan --help', async () => {
    const a: string[] = []
    const b: string[] = []
    await main(['help', 'plan'], { write: (t) => a.push(t) })
    await main(['plan', '--help'], { write: (t) => b.push(t) })
    assert.equal(a.join(''), b.join(''))
  })

  it('--version 打印版本号', async () => {
    const lines: string[] = []
    assert.equal(await main(['--version'], { write: (t) => lines.push(t) }), EXIT_OK)
    assert.equal(lines.join('').trim(), VERSION)
  })

  it('未知命令 → 退出 2，且提示最相近的命令', async () => {
    const err: string[] = []
    const code = await main(['plans'], { write: () => {}, writeErr: (t) => err.push(t) })
    assert.equal(code, EXIT_USAGE)
    assert.match(err.join(''), /dp plan/)
  })

  it('未知选项 → 退出 2，提示 --help', async () => {
    const err: string[] = []
    assert.equal(await main(['plan', '--nope'], { write: () => {}, writeErr: (t) => err.push(t) }), EXIT_USAGE)
    assert.match(err.join(''), /--help/)
  })

  it('配置不存在 → 退出 3', async () => {
    const err: string[] = []
    const code = await main(['plan', '--config', 'nope.json'], {
      cwd: process.cwd(),
      env: {},
      write: () => {},
      writeErr: (t) => err.push(t),
    })
    assert.equal(code, EXIT_CONFIG)
    assert.match(err.join(''), /nope\.json/)
  })

  it('apply --dry-run 真的能跑通：子进程退出 0 且不落盘', async () => {
    await withWorkspace(async (dir) => {
      const r = await runBin(['apply', '--dry-run', '--json'], dir)
      assert.equal(r.code, EXIT_OK, `stderr: ${r.stderr}`)
      const parsed = JSON.parse(r.stdout) as { ok: boolean; command: string; dryRun: boolean; filesWritten: number }
      assert.equal(parsed.ok, true)
      assert.equal(parsed.command, 'apply')
      assert.equal(parsed.dryRun, true)
      assert.equal(parsed.filesWritten, 0)
      // 干跑必须是零副作用：源目录与工作区都不能多出任何东西
      assert.deepEqual((await fs.readdir(join(dir, 'dist'))).sort(), ['assets', 'index.html'])
      assert.deepEqual((await fs.readdir(dir)).sort(), ['deploy.config.json', 'dist'])
    })
  })

  it('没有任何子命令时打印根帮助并成功退出', async () => {
    const lines: string[] = []
    assert.equal(await main([], { write: (t) => lines.push(t) }), EXIT_OK)
    assert.match(lines.join(''), /命令（已实现）/)
  })
})
