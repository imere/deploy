import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './index.js'
import { EXIT_CONFIG, EXIT_OK } from './output.js'

/**
 * apply 是**唯一会写目标机**的命令，所以这些测试全部用 os.tmpdir()：
 * 本机实测往用户目录写文件要 2–4 秒，一次测试写几次就够把套件拖垮。
 */
async function withWorkspace(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-cli-apply-'))
  try {
    await fs.mkdir(join(dir, 'dist', 'assets'), { recursive: true })
    await fs.writeFile(join(dir, 'dist', 'index.html'), '<h1>v1</h1>', 'utf8')
    await fs.writeFile(join(dir, 'dist', 'assets', 'app.js'), 'console.log(1)', 'utf8')
    await fs.writeFile(
      join(dir, 'deploy.config.json'),
      JSON.stringify(
        {
          hosts: { local: { local: true } },
          // release.root 必须是**绝对**路径：相对写法会按 process.cwd() 解析，
          // 于是探测会去探仓库目录而不是这个临时工作区（既慢又探错地方）。
          // 指向工作区内的子目录，产物（releases/.dp）都落在这，
          // 于是「工作区里除了配置和源目录没有别的东西」这条断言才有意义。
          projects: { web: { source: { root: './dist' }, release: { root: join(dir, 'out') } } },
        },
        null,
        2,
      ),
      'utf8',
    )
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** 走 main() 并注入 IO：不起子进程，就能直接断言退出码与 stdout 的纯度 */
async function runApply(dir: string, args: readonly string[]): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(['apply', ...args], {
    cwd: dir,
    env: {},
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    isTTY: false,
  })
  return { code, stdout: out.join(''), stderr: err.join('') }
}

/**
 * releaseId 只精确到秒（毫秒被刻意丢弃，见 release-id.ts）。
 * 连着跑两遍 apply 必须跨过一秒，否则两遍会算出同一个 id，
 * 第二遍的「上一版」就等于它自己，previousReleaseId 这条断言会变成假阳性。
 */
async function waitPastSecond(): Promise<void> {
  await new Promise((r) => setTimeout(r, 1100))
}

/** current 可能真是软链，也可能（Windows 无特权时）退化成目录复制，两种都算「指向成功」 */
async function currentPointsAt(root: string, releaseId: string): Promise<boolean> {
  const link = join(root, 'current')
  if (!existsSync(link)) return false
  const stat = await fs.lstat(link)
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(link)
    return target.includes(releaseId)
  }
  // 退化路径是目录复制，所以按复制出来的形状找文件（同样是 mode self 的 dist/ 一层）
  return existsSync(join(link, 'dist', 'index.html'))
}

describe('apply · 真执行', () => {
  it('部署后 releases/<id> 存在、current 指向它、索引记录了 current', async () => {
    await withWorkspace(async (dir) => {
      const r = await runApply(dir, ['--json'])
      assert.equal(r.code, EXIT_OK, `stderr: ${r.stderr}`)

      const parsed = JSON.parse(r.stdout) as {
        ok: boolean
        command: string
        project: string
        host: string
        releaseId: string
        filesWritten: number
        rolledBack: boolean
        steps: ReadonlyArray<{ id: string; kind: string; ok: boolean }>
        probeNotes: ReadonlyArray<string>
      }
      assert.equal(parsed.ok, true)
      assert.equal(parsed.command, 'apply')
      assert.equal(parsed.project, 'web')
      assert.equal(parsed.host, 'local')
      assert.equal(parsed.rolledBack, false)
      assert.equal(parsed.filesWritten, 2, 'dist 下两个文件都该被写入')
      assert.ok(Array.isArray(parsed.probeNotes))
      assert.ok(parsed.steps.some((s) => s.id === 'activate'), '要有 activate 步')

      const root = join(dir, 'out')
      // `source: './dist'` 是 mode self（放目录本身），所以产物里保留 dist/ 这一层 ——
      // 换成 './dist/**' 才是只放内容。这条断言同时守住上面那件事：self 模式下
      // listSourceEntries 不会给出 dist/ 本身的目录条目，CLI 必须补出来才能写进去
      assert.ok(existsSync(join(root, 'releases', parsed.releaseId, 'dist', 'index.html')), 'release 目录里应有源文件')
      assert.ok(await currentPointsAt(root, parsed.releaseId), 'current 应指向新版本')

      const index = JSON.parse(await fs.readFile(join(root, '.dp', 'index.json'), 'utf8')) as {
        current?: string
        releases: string[]
      }
      assert.equal(index.current, parsed.releaseId, '索引必须记录 current')
      assert.ok(index.releases.includes(parsed.releaseId))
    })
  })

  it('跑第二遍：previousReleaseId 有值，且仍指向新版本', async () => {
    await withWorkspace(async (dir) => {
      const first = JSON.parse((await runApply(dir, ['--json'])).stdout) as { releaseId: string }
      await waitPastSecond()
      const second = JSON.parse((await runApply(dir, ['--json'])).stdout) as {
        releaseId: string
        previousReleaseId?: string
        filesWritten: number
      }

      assert.notEqual(second.releaseId, first.releaseId, '跨秒后两版 id 必须不同，否则断言没意义')
      assert.equal(second.previousReleaseId, first.releaseId, '第二版应记着第一版是谁')
      assert.ok(await currentPointsAt(join(dir, 'out'), second.releaseId))
    })
  })
})

describe('apply · --dry-run', () => {
  it('不写入任何东西：工作区里除了配置和源目录没有任何新增', async () => {
    await withWorkspace(async (dir) => {
      const before = (await fs.readdir(dir)).sort()
      const r = await runApply(dir, ['--dry-run', '--json'])
      assert.equal(r.code, EXIT_OK, `stderr: ${r.stderr}`)

      const after = (await fs.readdir(dir)).sort()
      assert.deepEqual(after, before, '--dry-run 不允许在工作区新建任何东西')
      assert.ok(!existsSync(join(dir, 'out')), '发布根都不能被创建，更不用说写文件')

      const parsed = JSON.parse(r.stdout) as { dryRun: boolean; filesWritten: number }
      assert.equal(parsed.dryRun, true)
      assert.equal(parsed.filesWritten, 0)
    })
  })

  it('pretty 模式明说「未写入任何文件」', async () => {
    await withWorkspace(async (dir) => {
      const r = await runApply(dir, ['--dry-run'])
      assert.equal(r.code, EXIT_OK)
      assert.match(r.stdout, /未写入任何文件/)
      assert.match(r.stdout, /即将部署 web → local/)
    })
  })
})

describe('apply · --json 纯度', () => {
  it('stdout 是可被 JSON.parse 的纯 JSON（日志一律走 stderr）', async () => {
    await withWorkspace(async (dir) => {
      const r = await runApply(dir, ['--dry-run', '--json'])
      assert.equal(r.code, EXIT_OK, `stderr: ${r.stderr}`)
      // 不加任何 try 包装：stdout 里混进一行日志就必须是硬失败，而不是被吞掉
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>
      assert.equal(parsed['ok'], true)
      assert.equal(parsed['command'], 'apply')
      assert.equal(parsed['project'], 'web')
      assert.equal(parsed['host'], 'local')
      assert.ok(Array.isArray(parsed['results']), 'results 数组必须存在')
    })
  })
})

describe('apply · 失败路径', () => {
  it('空 source → 退出 3，报 DP.SOURCE.EMPTY，且没留下任何产物', async () => {
    await withWorkspace(async (dir) => {
      await fs.mkdir(join(dir, 'empty'), { recursive: true })
      await fs.writeFile(
        join(dir, 'deploy.config.json'),
        JSON.stringify({
          hosts: { local: { local: true } },
          projects: { web: { source: { root: './empty' }, release: { root: join(dir, 'out') } } },
        }),
        'utf8',
      )

      const r = await runApply(dir, ['--json'])
      assert.equal(r.code, EXIT_CONFIG, `stdout: ${r.stdout}`)
      assert.match(r.stderr, /DP\.SOURCE\.EMPTY/)
      assert.ok(!existsSync(join(dir, 'out')), '失败不得留下发布根')
    })
  })
})
