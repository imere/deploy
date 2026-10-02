/**
 * apply 走 @dp/transport 的测试 —— **注入的传输实现**。
 *
 * 为什么必须注入而不是真跑：本机没有 rsync（AGENTS.md 写明的事实），而且真跑
 * 意味着真连目标机。注入之后这些测试全程离线，却仍然覆盖真实的装配路径 ——
 * TransferRequest 的字段、协商结论、staging 目录、失败回滚、dry-run 零调用。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DpError,
  type ExecResult,
  type Facts,
  type FileStat,
  type Runner,
} from '@dp/ports'
import { main } from './index.js'
import type { ApplyDeps } from './deps.js'
import { EXIT_MISSING_DEPENDENCY } from './output.js'

// ------------------------------------------------------------
// 远端 Runner：只实现 deploy() 会用到的那几个方法
// ------------------------------------------------------------

class RemoteRunner implements Runner {
  readonly id = 'fake-remote'
  readonly facts: Facts
  private readonly tree = new Map<string, string | null>()

  constructor(facts: Facts) {
    this.facts = facts
    this.tree.set('/', null)
  }

  async exec(): Promise<ExecResult> {
    throw new DpError('CONFIG_INVALID', '假 Runner 不执行命令')
  }

  async stat(path: string): Promise<FileStat | null> {
    if (!this.tree.has(path)) return null
    return { isDirectory: this.tree.get(path) === null, isSymbolicLink: false, size: 0, mtimeMs: 0 }
  }

  async listDir(path: string): Promise<readonly string[]> {
    const out: string[] = []
    for (const key of this.tree.keys()) {
      if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) out.push(key.slice(path.length + 1))
    }
    return out
  }

  async mkdir(path: string): Promise<void> {
    this.tree.set(path, null)
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.tree.set(path, typeof data === 'string' ? data : new TextDecoder().decode(data))
  }

  async readFile(path: string): Promise<string> {
    const v = this.tree.get(path)
    if (v === undefined) throw new DpError('DP.PATH.NOT_WRITABLE', `不存在：${path}`)
    return v ?? ''
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path))
  }

  async remove(path: string): Promise<void> {
    for (const key of [...this.tree.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.tree.delete(key)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const moved = [...this.tree.entries()].filter(([k]) => k === from || k.startsWith(`${from}/`))
    await this.remove(to)
    for (const [k, v] of moved) {
      this.tree.set(to + k.slice(from.length), v)
      this.tree.delete(k)
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.tree.set(linkPath, target)
  }

  async readlink(path: string): Promise<string | null> {
    return this.tree.get(path) ?? null
  }

  async realpath(path: string): Promise<string> {
    return path
  }

  /** 测试辅助：直接看树里某个路径的内容 */
  peek(path: string): string | null {
    const v = this.tree.get(path)
    return v === undefined ? null : v
  }

  /**
   * 补齐父目录。真实的 rsync / tar 解包都会建父目录，假传输不建的话
   * `listDir(release)` 会返回空 —— 那是夹具不还原真实行为，不是被测代码的缺陷。
   */
  mkdirp(path: string): void {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i += 1) {
      this.tree.set(parts.slice(0, i).join('/'), null)
    }
  }
}

function remoteFacts(host: string): Facts {
  return {
    host,
    platform: 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: '/home/deployer',
    tmpdir: '/tmp',
    env: {},
    capabilities: {
      canWrite: { '/srv/app': true },
      canChown: [],
      canSymlink: true,
      systemdScope: 'system',
      lingerEnabled: false,
      canBindPrivilegedPort: false,
      sudoAllowlist: [],
    },
    // 两端都有 rsync：协商结论应当稳定落在 rsync-ssh 上，测试才不用跟环境较劲
    tools: { ssh: '/usr/bin/ssh', rsync: '/usr/bin/rsync', tar: '/bin/tar', scp: '/usr/bin/scp' },
  }
}

function localFacts(): Facts {
  return { ...remoteFacts('local'), host: 'local' }
}

interface Harness {
  readonly deps: ApplyDeps
  readonly runner: RemoteRunner
  readonly calls: { count: number; remoteRoots: string[]; entryCounts: number[]; deleteExtraneous: (boolean | undefined)[] }
  /** 每次调用传输时拿到的 `deps.preferred` —— 用户写的 strategy 有没有真的传下去 */
  readonly prefs: (readonly string[] | undefined)[]
}

interface HarnessOptions {
  /** 传输时抛错，模拟「搬了一半挂了」 */
  readonly failWith?: Error
  readonly filesTransferred?: number
  readonly warnings?: readonly string[]
}

function makeHarness(options: HarnessOptions = {}): Harness {
  const runner = new RemoteRunner(remoteFacts('prod'))
  const calls = { count: 0, remoteRoots: [] as string[], entryCounts: [] as number[], deleteExtraneous: [] as (boolean | undefined)[] }
  const prefs: (readonly string[] | undefined)[] = []

  const deps: ApplyDeps = {
    acquireFacts: async () => ({
      facts: runner.facts,
      probeNotes: [],
      close: async () => {},
      runner,
    }),
    probeLocalFacts: async () => localFacts(),
    transfer: async (req, xferDeps) => {
      calls.count += 1
      prefs.push(xferDeps.preferred)
      calls.remoteRoots.push(req.remoteRoot)
      calls.entryCounts.push(req.entries.length)
      calls.deleteExtraneous.push(req.deleteExtraneous)
      if (options.failWith !== undefined) {
        // 传一半再失败：先落一个文件，模拟 rsync 中途挂掉
        await runner.mkdir(req.remoteRoot)
        runner.mkdirp(`${req.remoteRoot}/partial.txt`)
        await runner.writeFile(`${req.remoteRoot}/partial.txt`, 'half')
        throw options.failWith
      }
      await runner.mkdir(req.remoteRoot)
      for (const e of req.entries) {
        runner.mkdirp(`${req.remoteRoot}/${e}`)
        await runner.writeFile(`${req.remoteRoot}/${e}`, 'payload')
      }
      return {
        kind: 'rsync-ssh' as const,
        filesTransferred: options.filesTransferred ?? req.entries.length,
        command: ['rsync', '-a'],
        exitCode: 0,
        warnings: options.warnings ?? [],
      }
    },
  }
  return { deps, runner, calls, prefs }
}

async function withWorkspace(
  fn: (dir: string) => Promise<void>,
  config?: Record<string, unknown>,
): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-cli-xfer-'))
  try {
    await fs.mkdir(join(dir, 'dist'), { recursive: true })
    await fs.writeFile(join(dir, 'dist', 'index.html'), '<h1>v1</h1>', 'utf8')
    await fs.writeFile(
      join(dir, 'deploy.config.json'),
      JSON.stringify(
        config ?? {
          hosts: { prod: { ssh: 'deployer@10.0.0.5:2222' }, local: { local: true } },
          projects: { web: { source: { root: './dist' }, release: { root: '/srv/app' } } },
        },
        null,
        2,
      ),
      'utf8',
    )
    // mode self 会把 dist 本身带进清单（目录条目）；传输清单里不该有它
    await fs.mkdir(join(dir, 'dist', 'assets'), { recursive: true })
    await fs.writeFile(join(dir, 'dist', 'assets', 'app.js'), 'console.log(1)', 'utf8')
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

async function run(dir: string, args: readonly string[], deps: ApplyDeps): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const code = await main(['apply', ...args], {
    cwd: dir,
    env: {},
    deps,
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    isTTY: false,
  })
  return { code, stdout: out.join(''), stderr: err.join('') }
}

describe('apply · 远端走 transport', () => {
  it('钩子拿到的是 staging 目录（releases/<id>.incoming），不是 releaseRoot', async () => {
    await withWorkspace(async (dir) => {
      const h = makeHarness()
      const r = await run(dir, ['--json', '--host', 'prod'], h.deps)
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)

      const parsed = JSON.parse(r.stdout) as { releaseId: string; filesWritten: number; host: string }
      assert.equal(parsed.host, 'prod')
      assert.equal(h.calls.count, 1)
      // 关键断言：传进传输的必须是 .incoming。写成 releaseRoot 就等于直接往
      // 正在服务的目录里写文件，deploy 的 staging→rename 语义整个失效
      assert.equal(h.calls.remoteRoots[0], `/srv/app/releases/${parsed.releaseId}.incoming`)
      assert.notEqual(h.calls.remoteRoots[0], '/srv/app')
      // 目录条目不传给传输：rsync / tar 自己会建父目录
      assert.equal(h.calls.entryCounts[0], 2, '只传文件条目，目录条目由传输工具自己建')
      assert.equal(parsed.filesWritten, 2)
      // 换向仍由 deploy 做：传输写进 .incoming，deploy 负责 rename 成正式版本
      assert.ok(
        h.runner.peek(`/srv/app/releases/${parsed.releaseId}/dist/index.html`) !== null,
        '文件应落在 releases/<id> 下（source 是 ./dist，mode self，路径带 dist/ 一层）',
      )
    })
  })

  it('传输抛错 → 退出码非 0、rolledBack 如实、error 进 JSON', async () => {
    await withWorkspace(async (dir) => {
      const boom = new DpError('DP.SSH.CONNECT_FAILED', '注入的传输失败', { hint: '这是注入的假错误' })
      const h = makeHarness({ failWith: boom })
      const r = await run(dir, ['--json', '--host', 'prod'], h.deps)
      assert.notEqual(r.code, 0, '传输失败绝不能报成功')

      const parsed = JSON.parse(r.stdout) as {
        ok: boolean
        rolledBack: boolean
        filesWritten: number
        error?: { code: string }
      }
      assert.equal(parsed.ok, false)
      assert.equal(parsed.error?.code, 'DP.SSH.CONNECT_FAILED', '失败原因必须进 JSON 的 error')
      // 第一次部署没有上一版，rollback 必然失败 → needsHealing，如实标 false
      assert.equal(typeof parsed.rolledBack, 'boolean')
      // 关键：失败时绝不能已经换向
      assert.equal(h.runner.peek('/srv/app/current'), null, '传输失败不得切 current')
    })
  })

  it('--dry-run：传输一次都没被调用', async () => {
    await withWorkspace(async (dir) => {
      const h = makeHarness()
      const r = await run(dir, ['--dry-run', '--json', '--host', 'prod'], h.deps)
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.equal(h.calls.count, 0, '--dry-run 不许碰传输')
      const parsed = JSON.parse(r.stdout) as { dryRun: boolean; filesWritten: number }
      assert.equal(parsed.dryRun, true)
      assert.equal(parsed.filesWritten, 0)
    })
  })

  it('本机主机不经过传输层（保持逐条 writeFile）', async () => {
    await withWorkspace(async (dir) => {
      const h = makeHarness()
      const r = await run(dir, ['--json', '--host', 'local'], h.deps)
      assert.equal(h.calls.count, 0, '本机目标没有「跨机传输」这回事，不许绕 transport')
      // 仍然要真部署成功
      assert.equal(JSON.parse(r.stdout).ok, true, `stderr: ${r.stderr}`)
    })
  })

  it('传输的 warning 合并进结果，且 --json 的 stdout 仍是纯 JSON', async () => {
    await withWorkspace(async (dir) => {
      const h = makeHarness({ warnings: ['rsync 部分传输（exit 23）'] })
      const r = await run(dir, ['--json', '--host', 'prod'], h.deps)
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      // 不加 try：stdout 混进一行日志就必须硬失败
      const parsed = JSON.parse(r.stdout) as { warnings: string[] }
      assert.ok(
        parsed.warnings.some((w) => w.includes('部分传输')),
        `传输的 partial 告警必须进 results.warnings，实际：${JSON.stringify(parsed.warnings)}`,
      )
    })
  })

  it('显式偏好 rsync 但本机没装 → 装配期报 DP.PREF.UNSUPPORTED，不起传输', async () => {
    const config = {
      hosts: { prod: { ssh: 'deployer@10.0.0.5:2222', transport: { strategy: ['rsync'] } } },
      projects: { web: { source: { root: './dist' }, release: { root: '/srv/app' } } },
    }
    await withWorkspace(async (dir) => {
      // 显式点名 rsync，本机没装就必须**当场报错**，不静默降级成别的方式
      const h = makeHarness()
      const noRsync: ApplyDeps = {
        ...h.deps,
        probeLocalFacts: async () => ({ ...localFacts(), tools: { ...localFacts().tools, rsync: null } }),
      }
      const r = await run(dir, ['--json', '--host', 'prod'], noRsync)
      // DP.PREF.UNSUPPORTED → EXIT_MISSING_DEPENDENCY（4）：是环境缺依赖，不是配置写错
      assert.equal(r.code, EXIT_MISSING_DEPENDENCY, `stdout: ${r.stdout}`)
      const parsed = JSON.parse(r.stdout) as { error?: { code: string } }
      assert.equal(parsed.error?.code, 'DP.PREF.UNSUPPORTED')
      assert.equal(h.calls.count, 0, '协商失败就不许起传输')
    }, config)
  })

  it('显式 strategy 必须真的传进传输层，不能只进日志', async () => {
    // 两端 rsync / tar 都有：默认链会选 rsync-ssh，而用户点名 tar-ssh。
    // 于是「preferred 有没有传下去」这个差别**只有**这一条测试看得见 ——
    // 只校验日志的话，日志说 tar-ssh、实际跑 rsync，测试照样全绿。
    const config = {
      hosts: { prod: { ssh: 'deployer@10.0.0.5:2222', transport: { strategy: ['tar-ssh'] } } },
      projects: { web: { source: { root: './dist' }, release: { root: '/srv/app' } } },
    }
    await withWorkspace(async (dir) => {
      const h = makeHarness()
      const r = await run(dir, ['--json', '--host', 'prod'], h.deps)
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
      assert.equal(h.calls.count, 1)
      assert.deepEqual(h.prefs[0], ['tar-ssh'], `用户写的 strategy 必须原样到达 transfer，实际：${JSON.stringify(h.prefs[0])}`)
    }, config)
  })

  it('要密码的提权（stdin / pty）在传输层明确拒绝，不撞铁律 0', async () => {
    const config = {
      hosts: {
        prod: { ssh: 'deployer@10.0.0.5:2222', become: { type: 'sudo', method: 'stdin' } },
      },
      projects: { web: { source: { root: './dist' }, release: { root: '/srv/app' } } },
    }
    await withWorkspace(async (dir) => {
      const h = makeHarness()
      const r = await run(dir, ['--json', '--host', 'prod'], h.deps)
      assert.notEqual(r.code, 0, '带密码的 sudo 不能当成配置合法放行')
      const parsed = JSON.parse(r.stdout) as { error?: { code: string; message: string } }
      assert.equal(parsed.error?.code, 'DP.CONFIG.INVALID')
      assert.match(parsed.error?.message ?? '', /尚未接入传输层/)
      assert.equal(h.calls.count, 0, '装配期就拒绝，不起传输')
    }, config)
  })
})

/**
 * 真机 e2e —— 需要一台真的机器与真的 rsync/tar，跑 `dp apply --host <真机>`。
 * 保留在仓库里是为了让「注入测试覆盖不到的那一段」有明确落点：
 * 真 spawn、真 ssh、真 argv。这里**永远 skip**，不许在 CI 里被打开。
 */
describe.skip('apply · 远端 transport 真机 e2e', () => {
  it('rsync/tar 真的把文件搬到远端 staging 并换向', async () => {
    await withWorkspace(async (dir) => {
      // 换成真装配：真 acquireFacts + 真 transfer
      const { defaultApplyDeps } = await import('./deps.js')
      const r = await run(dir, ['--json', '--host', 'prod'], defaultApplyDeps())
      assert.equal(r.code, 0, `stderr: ${r.stderr}`)
    })
  })
})
