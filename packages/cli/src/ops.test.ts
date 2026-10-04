/**
 * `dp status` / `dp verify` / `dp rollback` 的测试。
 *
 * 三类覆盖，缺一不可：
 *  1. **本地真链路** —— 真装配 + 真文件系统，跑 apply → status → verify → rollback。
 *     它证明的是「底层能力与 CLI 接线真的咬合」，而不是各自孤立可用。
 *  2. **远端注入** —— 假 Runner + 假 facts，全程不碰网络。
 *  3. **边界** —— 没部署过 / 只有一个版本 / --json 纯度 / --all 扇出。
 *
 * 全程零网络：本机主机的 facts 探测只读本机文件系统。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readReleaseState, type ReleaseState } from '@dp/target-static'
import {
  DpError,
  type ExecResult,
  type Facts,
  type FileStat,
  type Runner,
} from '@dp/ports'
import { main } from './index.js'
import { COMMANDS } from './help.js'
import { defaultApplyDeps, type ApplyDeps } from './deps.js'
import { EXIT_OK, EXIT_USAGE, EXIT_VERIFY_FAILED } from './output.js'

// ------------------------------------------------------------
// 夹具
// ------------------------------------------------------------

class FakeRunner implements Runner {
  readonly id = 'fake'
  readonly facts: Facts
  private readonly tree = new Map<string, string | null>()

  constructor(facts: Facts) {
    this.facts = facts
    this.tree.set('/', null)
  }

  async exec(): Promise<ExecResult> {
    throw new DpError('DP.CONFIG.INVALID', '假 Runner 不执行命令')
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

  peek(path: string): string | null {
    const v = this.tree.get(path)
    return v === undefined ? null : v
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
      canWrite: { '/srv/app': true, '/srv/api': true },
      canChown: [],
      canSymlink: true,
      systemdScope: 'system',
      lingerEnabled: false,
      canBindPrivilegedPort: false,
      sudoAllowlist: [],
    },
    tools: { ssh: '/usr/bin/ssh', rsync: '/usr/bin/rsync', tar: '/bin/tar', scp: '/usr/bin/scp' },
  }
}

/** 造一个已经部署过 N 版的远端：索引 + 每个版本目录一个文件 */
async function seedRemote(runner: FakeRunner, root: string, ids: readonly string[], current: string): Promise<void> {
  await runner.mkdir(`${root}/.dp`)
  await runner.mkdir(`${root}/releases`)
  for (const id of ids) {
    await runner.mkdir(`${root}/releases/${id}/assets`)
    await runner.writeFile(`${root}/releases/${id}/assets/index.html`, id)
  }
  await runner.writeFile(
    `${root}/.dp/index.json`,
    JSON.stringify({ current, releases: [...ids], history: ids.slice(1).map((id) => [id, ids[ids.indexOf(id) - 1] as string]) }),
  )
}

/**
 * 本机装配，但**只探测一次**。
 *
 * 真实探测是这份测试里最贵的一步（每个探测点都要建文件再删，docs 里记过 ~2.4s/个），
 * 而一条 apply → status → verify → rollback 链路会调用它好几次。按 (host, releaseRoot)
 * 记忆化后，真实探测只发生一次，其余每一步仍走真 createLocalRunner + 真文件系统。
 * 缓存是安全的：本机路径不建连接，没有 close 需要配对。
 */
function memoizedRealDeps(): ApplyDeps {
  const base = defaultApplyDeps()
  const cache = new Map<string, ReturnType<typeof base.acquireFacts>>()
  return {
    ...base,
    acquireFacts: (req) => {
      const key = `${req.hostId}|${req.releaseRoot ?? ''}`
      let hit = cache.get(key)
      if (hit === undefined) {
        hit = base.acquireFacts(req)
        cache.set(key, hit)
      }
      return hit
    },
  }
}

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** 全套共享一份：真实探测只做一次，跨用例复用 */
const LOCAL_DEPS: ApplyDeps = memoizedRealDeps()

async function runCli(
  command: string,
  dir: string,
  args: readonly string[],
  deps: ApplyDeps = LOCAL_DEPS,
): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const code = await main([command, ...args], {
    cwd: dir,
    env: {},
    deps,
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    isTTY: false,
  })
  return { code, stdout: out.join(''), stderr: err.join('') }
}

/** 本机工作区：dist 里有文件，配置指向 tmpdir 里的发布根 */
async function withLocalWorkspace(
  fn: (dir: string, releaseRoot: string) => Promise<void>,
  config?: (releaseRoot: string) => Record<string, unknown>,
): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-ops-'))
  try {
    await fs.mkdir(join(dir, 'dist'), { recursive: true })
    await fs.writeFile(join(dir, 'dist', 'index.html'), '<h1>v1</h1>', 'utf8')
    const releaseRoot = join(dir, 'rel').replace(/\\/g, '/')
    await fs.writeFile(
      join(dir, 'deploy.config.json'),
      JSON.stringify(
        config?.(releaseRoot) ?? {
          hosts: { local: { local: true } },
          projects: { web: { source: { root: './dist' }, release: { root: releaseRoot } } },
        },
        null,
        2,
      ),
      'utf8',
    )
    await fn(dir, releaseRoot)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function remoteDeps(runner: FakeRunner): ApplyDeps {
  return {
    acquireFacts: async () => ({ facts: runner.facts, probeNotes: [], close: async () => {}, runner }),
    probeLocalFacts: async () => remoteFacts('local'),
    transfer: async (req) => {
      await runner.mkdir(req.remoteRoot)
      for (const e of req.entries) {
        const parts = e.split('/')
        for (let i = 1; i < parts.length; i += 1) await runner.mkdir(`${req.remoteRoot}/${parts.slice(0, i).join('/')}`)
        await runner.writeFile(`${req.remoteRoot}/${e}`, 'payload')
      }
      return { kind: 'rsync-ssh' as const, filesTransferred: req.entries.length, command: ['rsync', '-a'], exitCode: 0, warnings: [] }
    },
  }
}

/** 两版已就绪的远端工作区 */
async function withRemoteWorkspace(fn: (runner: FakeRunner, root: string) => Promise<void>): Promise<void> {
  const runner = new FakeRunner(remoteFacts('prod'))
  await seedRemote(runner, '/srv/app', ['web-1', 'web-2'], 'web-2')
  await fn(runner, '/srv/app')
}

// ------------------------------------------------------------
// ① readReleaseState —— previous 的定义直接断言
// ------------------------------------------------------------

describe('readReleaseState', () => {
  const facts = remoteFacts('prod')

  it('previous 是 current 在 releases 里的前一个位置', async () => {
    const runner = new FakeRunner(facts)
    await seedRemote(runner, '/srv/app', ['web-1', 'web-2'], 'web-2')
    const state: ReleaseState = await readReleaseState(runner, '/srv/app')
    assert.equal(state.current, 'web-2')
    assert.equal(state.previous, 'web-1')
  })

  it('releases 不以 current 结尾时，previous 仍按位置取（不是倒数第二个）', async () => {
    // 这是规格要求的精确语义：current 夹在中间时，「倒数第二个」会算回 current 自己
    const runner = new FakeRunner(facts)
    await seedRemote(runner, '/srv/app', ['web-1', 'web-2', 'web-3'], 'web-2')
    const state = await readReleaseState(runner, '/srv/app')
    assert.equal(state.current, 'web-2')
    assert.equal(state.previous, 'web-1', '必须取位置前驱，否则会指向 current 自己')
  })

  it('索引不存在 → 空状态而不抛错（尚未部署是正常初始态）', async () => {
    const runner = new FakeRunner(facts)
    const state = await readReleaseState(runner, '/srv/nothing')
    assert.equal(state.current, undefined)
    assert.equal(state.previous, undefined)
    assert.deepEqual(state.releases, [])
  })

  it('索引损坏 → 空状态而不抛错', async () => {
    const runner = new FakeRunner(facts)
    await runner.mkdir('/srv/broken/.dp')
    await runner.writeFile('/srv/broken/.dp/index.json', '{ this is not json')
    const state = await readReleaseState(runner, '/srv/broken')
    assert.deepEqual(state.releases, [])
  })

  it('只有一个版本 → previous 为 undefined', async () => {
    const runner = new FakeRunner(facts)
    await seedRemote(runner, '/srv/app', ['web-1'], 'web-1')
    const state = await readReleaseState(runner, '/srv/app')
    assert.equal(state.current, 'web-1')
    assert.equal(state.previous, undefined)
  })
})

// ------------------------------------------------------------
// ② 本地真链路
// ------------------------------------------------------------

describe('ops · 本地真链路 apply → status → verify → rollback', () => {
  it('status 报出当前版本 / 上一版 / 版本数 / 健康', async () => {
    await withLocalWorkspace(async (dir) => {
      // releaseId 精确到秒，两次 apply 必须真的隔开一秒
      const a1 = await runCli('apply', dir, ['--json', '--host', 'local'])
      assert.equal(a1.code, EXIT_OK, `apply 失败：${a1.stderr}`)
      await new Promise((r) => setTimeout(r, 1100))
      await fs.writeFile(join(dir, 'dist', 'index.html'), '<h1>v2</h1>', 'utf8')
      const a2 = await runCli('apply', dir, ['--json', '--host', 'local'])
      assert.equal(a2.code, EXIT_OK, `apply 失败：${a2.stderr}`)

      const s = await runCli('status', dir, ['--json', '--host', 'local'])
      assert.equal(s.code, EXIT_OK, `status 失败：${s.stderr}`)
      const p = JSON.parse(s.stdout) as StatusJson
      assert.equal(p.command, 'status')
      assert.equal(p.deployed, true)
      assert.equal(p.healthy, true)
      assert.equal(p.releases.length, 2)
      assert.notEqual(p.current, null)
      assert.notEqual(p.previous, null)
      assert.notEqual(p.current, p.previous, 'current 与 previous 不能是同一个版本')
    })
  })

  it('verify 对健康的 current 退出 0', async () => {
    await withLocalWorkspace(async (dir) => {
      const a = await runCli('apply', dir, ['--json', '--host', 'local'])
      assert.equal(a.code, EXIT_OK, a.stderr)
      const v = await runCli('verify', dir, ['--json', '--host', 'local'])
      assert.equal(v.code, EXIT_OK, `verify 失败：${v.stderr}`)
      const p = JSON.parse(v.stdout) as VerifyJson
      assert.equal(p.command, 'verify')
      assert.equal(p.ok, true)
    })
  })

  it('rollback 切回上一版，并报出 from / to', async () => {
    await withLocalWorkspace(async (dir) => {
      const a1 = await runCli('apply', dir, ['--json', '--host', 'local'])
      assert.equal(a1.code, EXIT_OK, a1.stderr)
      const first = (JSON.parse(a1.stdout) as { releaseId: string }).releaseId
      await new Promise((r) => setTimeout(r, 1100))
      const a2 = await runCli('apply', dir, ['--json', '--host', 'local'])
      const second = (JSON.parse(a2.stdout) as { releaseId: string }).releaseId

      const r = await runCli('rollback', dir, ['--json', '--host', 'local'])
      assert.equal(r.code, EXIT_OK, `rollback 失败：${r.stderr}`)
      const p = JSON.parse(r.stdout) as RollbackJson
      assert.equal(p.command, 'rollback')
      assert.equal(p.from, second)
      assert.equal(p.to, first)
      assert.equal(p.needsHealing, false)

      // 切完再查：current 必须真的变了，否则「报成功」是假的
      const s = await runCli('status', dir, ['--json', '--host', 'local'])
      assert.equal((JSON.parse(s.stdout) as StatusJson).current, first)
    })
  })

  it('rollback 不删任何版本', async () => {
    await withLocalWorkspace(async (dir, releaseRoot) => {
      await runCli('apply', dir, ['--json', '--host', 'local'])
      await new Promise((r) => setTimeout(r, 1100))
      await runCli('apply', dir, ['--json', '--host', 'local'])
      await runCli('rollback', dir, ['--json', '--host', 'local'])
      const entries = await fs.readdir(join(releaseRoot, 'releases'))
      assert.equal(entries.length, 2, `回滚不得清理版本，实际：${entries.join(' | ')}`)
    })
  })
})

// ------------------------------------------------------------
// ③ 边界：没部署过 / 只有一个版本
// ------------------------------------------------------------

describe('ops · 边界', () => {
  it('没部署过：status 报 deployed:false 且退出 0', async () => {
    await withLocalWorkspace(async (dir) => {
      const s = await runCli('status', dir, ['--json', '--host', 'local'])
      assert.equal(s.code, EXIT_OK, '尚未部署是正常初始状态，不该报错')
      const p = JSON.parse(s.stdout) as StatusJson
      assert.equal(p.deployed, false)
      assert.equal(p.current, null)
      assert.equal(p.healthy, null)
      assert.ok(p.warnings.some((w) => w.includes('尚未部署')), '必须有一条说明为什么没部署')
    })
  })

  it('没部署过：verify 报 DP.VERIFY.FAILED 并给「先部署」的 hint', async () => {
    await withLocalWorkspace(async (dir) => {
      const v = await runCli('verify', dir, ['--json', '--host', 'local'])
      assert.equal(v.code, EXIT_VERIFY_FAILED, '没东西可验绝不能报成功')
      const p = JSON.parse(v.stdout) as VerifyJson
      assert.equal(p.error?.code, 'DP.VERIFY.FAILED')
      assert.match(p.error?.hint ?? '', /dp apply/)
    })
  })

  it('没部署过：rollback 报 DP.VERIFY.FAILED', async () => {
    await withLocalWorkspace(async (dir) => {
      const r = await runCli('rollback', dir, ['--json', '--host', 'local'])
      assert.equal(r.code, EXIT_VERIFY_FAILED)
      const p = JSON.parse(r.stdout) as RollbackJson
      assert.equal(p.error?.code, 'DP.VERIFY.FAILED')
    })
  })

  it('只有一个版本：rollback 明确说没有可回退的版本', async () => {
    await withLocalWorkspace(async (dir) => {
      const a = await runCli('apply', dir, ['--json', '--host', 'local'])
      assert.equal(a.code, EXIT_OK, a.stderr)
      const r = await runCli('rollback', dir, ['--json', '--host', 'local'])
      assert.equal(r.code, EXIT_VERIFY_FAILED)
      const p = JSON.parse(r.stdout) as RollbackJson
      assert.match(p.error?.message ?? '', /没有可回退的版本/)
    })
  })

  it('rollback 不接受 --dry-run（没有「演练回滚」这种半状态）', async () => {
    await withLocalWorkspace(async (dir) => {
      const r = await runCli('rollback', dir, ['--dry-run', '--host', 'local'])
      assert.equal(r.code, EXIT_USAGE)
      assert.match(r.stderr, /dry-run/)
    })
  })

  it('status / verify / rollback 都接受 --json、--all 等开关', async () => {
    await withLocalWorkspace(async (dir) => {
      for (const cmd of ['status', 'verify', 'rollback']) {
        const r = await runCli(cmd, dir, ['--all', '--json'])
        // 判据是「stdout 里有这个命令的结果」，不是退出码：EXIT_USAGE 与
        // EXIT_VERIFY_FAILED 同为 2，verify 失败时用它当判据会误判成用法错
        const p = JSON.parse(r.stdout) as { command: string }
        assert.equal(p.command, cmd, `${cmd} 不该把 --all/--json 判成用法错：${r.stderr}`)
      }
    })
  })
})

// ------------------------------------------------------------
// ④ 远端注入：全程不碰网络
// ------------------------------------------------------------

describe('ops · 远端注入', () => {
  it('status 在远端路径上读索引并报健康', async () => {
    await withRemoteWorkspace(async (runner) => {
      const dir = await makeRemoteConfigDir()
      try {
        const r = await runCli('status', dir, ['--json', '--host', 'prod', '--project', 'web'], remoteDeps(runner))
        assert.equal(r.code, EXIT_OK, r.stderr)
        const p = JSON.parse(r.stdout) as StatusJson
        assert.equal(p.host, 'prod')
        assert.equal(p.current, 'web-2')
        assert.equal(p.previous, 'web-1')
        assert.equal(p.healthy, true)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })

  it('verify 在远端路径上通过', async () => {
    await withRemoteWorkspace(async (runner) => {
      const dir = await makeRemoteConfigDir()
      try {
        const r = await runCli('verify', dir, ['--json', '--host', 'prod', '--project', 'web'], remoteDeps(runner))
        assert.equal(r.code, EXIT_OK, r.stderr)
        assert.equal((JSON.parse(r.stdout) as VerifyJson).releaseId, 'web-2')
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })

  it('rollback 在远端路径上切 current，且不碰真实网络', async () => {
    await withRemoteWorkspace(async (runner) => {
      const dir = await makeRemoteConfigDir()
      try {
        const r = await runCli('rollback', dir, ['--json', '--host', 'prod', '--project', 'web'], remoteDeps(runner))
        assert.equal(r.code, EXIT_OK, r.stderr)
        const p = JSON.parse(r.stdout) as RollbackJson
        assert.equal(p.from, 'web-2')
        assert.equal(p.to, 'web-1')
        assert.equal(runner.peek('/srv/app/current'), '/srv/app/releases/web-1', 'current 必须真的换了')
        // 两个版本都还在
        assert.notEqual(runner.peek('/srv/app/releases/web-2/assets/index.html'), null)
      } finally {
        await fs.rm(dir, { recursive: true, force: true })
      }
    })
  })

  it('当前版本目录为空 → status 如实报不健康，但退出码仍为 0', async () => {
    // 空 release = 线上 404。status 必须把它报出来，但**不能**因此让命令失败：
    // 它的职责是报告事实，让报警器因为坏消息自己变红等于把报警器关掉
    const runner = new FakeRunner(remoteFacts('prod'))
    await seedRemote(runner, '/srv/app', ['web-1', 'web-2'], 'web-2')
    await runner.remove('/srv/app/releases/web-2/assets')
    const dir = await makeRemoteConfigDir()
    try {
      const r = await runCli('status', dir, ['--json', '--host', 'prod', '--project', 'web'], remoteDeps(runner))
      assert.equal(r.code, EXIT_OK, 'status 查到坏消息不等于命令失败')
      const p = JSON.parse(r.stdout) as StatusJson
      assert.equal(p.healthy, false)
      assert.match(p.reason ?? '', /为空/)
      assert.equal(p.ok, true, '信封 ok 只看 error，坏消息本身不算命令失败')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('verify 对不健康的 current 退出 2 并带可执行 hint', async () => {
    const runner = new FakeRunner(remoteFacts('prod'))
    await seedRemote(runner, '/srv/app', ['web-1', 'web-2'], 'web-2')
    // 当前版本目录被掏空 → verifyRelease 的「release 目录为空」分支命中
    await runner.remove('/srv/app/releases/web-2/assets')
    const dir = await makeRemoteConfigDir()
    try {
      const r = await runCli('verify', dir, ['--json', '--host', 'prod', '--project', 'web'], remoteDeps(runner))
      assert.equal(r.code, EXIT_VERIFY_FAILED)
      const p = JSON.parse(r.stdout) as VerifyJson
      assert.equal(p.error?.code, 'DP.VERIFY.FAILED')
      assert.match(p.error?.hint ?? '', /dp rollback/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('current 不在 releases 末尾时：不许「报成功但一个指针都没动」', async () => {
    // 走到这个状态的路径很普通：部署 web-1/2/3 → 回滚一次 → current 落在中间。
    // 此时「上一版」有两种读法 —— CLI 按位置取（current 的前一个 = web-1），
    // 而 target-static 的 rollback() 取 releases 的倒数第二个（= web-2 = 当前版本）。
    // 两者不一致时如果照报成功，用户以为又退了一版，实际什么都没切。
    const runner = new FakeRunner(remoteFacts('prod'))
    await seedRemote(runner, '/srv/app', ['web-1', 'web-2', 'web-3'], 'web-2')
    const dir = await makeRemoteConfigDir()
    try {
      const r = await runCli('rollback', dir, ['--json', '--host', 'prod', '--project', 'web'], remoteDeps(runner))
      assert.notEqual(r.code, EXIT_OK, '目标与预期不一致时必须报错，不能报成功')
      const p = JSON.parse(r.stdout) as RollbackJson
      assert.equal(p.error?.code, 'DP.STATE.INCONSISTENT')
      // current 必须**没有被悄悄改成别的版本**
      assert.equal(runner.peek('/srv/app/current'), '/srv/app/releases/web-2', '报了错就不许顺手切走')
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('回滚到同样不健康的版本 → needsHealing + 退出 2，而不是假装成功', async () => {
    const runner = new FakeRunner(remoteFacts('prod'))
    await seedRemote(runner, '/srv/app', ['web-1', 'web-2'], 'web-2')
    // 两版都空：切过去也验不过。这正是 needsHealing 的场景
    await runner.remove('/srv/app/releases/web-1/assets')
    await runner.remove('/srv/app/releases/web-2/assets')
    const dir = await makeRemoteConfigDir()
    try {
      const r = await runCli('rollback', dir, ['--json', '--host', 'prod', '--project', 'web'], remoteDeps(runner))
      assert.equal(r.code, EXIT_VERIFY_FAILED, '坏版本被切上去不能报成功')
      const p = JSON.parse(r.stdout) as RollbackJson
      assert.equal(p.needsHealing, true)
      assert.equal(p.to, 'web-1')
      assert.match(p.error?.message ?? '', /需要人工介入/)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

// ------------------------------------------------------------
// ⑤ --json 纯度 + 扇出
// ------------------------------------------------------------

describe('ops · --json 纯度与扇出', () => {
  it('失败时 stdout 仍是恰好一个可 JSON.parse 的文档', async () => {
    await withLocalWorkspace(async (dir) => {
      // 不加 try：stdout 混进一行日志就必须硬失败
      const v = await runCli('verify', dir, ['--json', '--host', 'local'])
      const pv = JSON.parse(v.stdout) as { command: string; ok: boolean }
      assert.equal(pv.command, 'verify')
      assert.equal(pv.ok, false, 'verify 在没部署过时应当 ok=false')

      const b = await runCli('rollback', dir, ['--json', '--host', 'local'])
      const pb = JSON.parse(b.stdout) as { command: string; ok: boolean }
      assert.equal(pb.command, 'rollback')
      assert.equal(pb.ok, false)

      // status 相反：它成功**报告**了「没部署过」，那不是命令失败
      const s = await runCli('status', dir, ['--json', '--host', 'local'])
      const ps = JSON.parse(s.stdout) as { command: string; ok: boolean; deployed: boolean }
      assert.equal(ps.command, 'status')
      assert.equal(ps.ok, true)
      assert.equal(ps.deployed, false)
    })
  })

  it('--all 覆盖两个项目时三条命令都各出一份结果', async () => {
    const config = (releaseRoot: string): Record<string, unknown> => ({
      hosts: { local: { local: true } },
      projects: {
        web: { source: { root: './dist' }, release: { root: `${releaseRoot}-web` } },
        api: { source: { root: './dist' }, release: { root: `${releaseRoot}-api` } },
      },
    })
    await withLocalWorkspace(async (dir) => {
      for (const cmd of ['status', 'verify', 'rollback']) {
        const r = await runCli(cmd, dir, ['--json', '--all'])
        // 不断言退出码：verify / rollback 在没部署过时返回 2，而 EXIT_USAGE 也是 2
        // （见 output.ts 的说明），拿它当「不是用法错」的判据是错的
        const p = JSON.parse(r.stdout) as { results: { project: string; host: string }[] }
        assert.equal(p.results.length, 2, `${cmd} 应对两个项目各出一份结果`)
        assert.deepEqual([...p.results.map((x) => x.project)].sort(), ['api', 'web'])
        assert.ok(p.results.every((x) => x.host === 'local'))
      }
    }, config)
  })
})

// ------------------------------------------------------------
// ⑥ help
// ------------------------------------------------------------

describe('ops · help', () => {
  it('三条命令都是 implemented: true', () => {
    for (const name of ['status', 'verify', 'rollback']) {
      const doc = COMMANDS.find((c) => c.name === name)
      assert.ok(doc !== undefined, `help 表里应有 ${name}`)
      assert.equal(doc.implemented, true, `${name} 仍标着未实现`)
      assert.ok(!/后续回合|待实现/.test(doc.summary), `${name} 的 summary 还留着占位字样`)
      assert.ok(doc.flags.some(([f]) => f.includes('--json')), `${name} 的 flags 必须含 --json`)
    }
  })

  it('dp <cmd> --help 有输出且含用法行', async () => {
    const out: string[] = []
    await main(['status', '--help'], { write: (t) => out.push(t), writeErr: () => {}, env: {} })
    const text = out.join('')
    assert.match(text, /dp status/)
    assert.match(text, /用法/)
  })

  it('根帮助把三条命令列在「已实现」里', async () => {
    const out: string[] = []
    await main(['--help'], { write: (t) => out.push(t), writeErr: () => {}, env: {} })
    const text = out.join('')
    const doneSection = text.split('命令（后续回合')[0] ?? ''
    for (const name of ['status', 'verify', 'rollback']) {
      assert.match(doneSection, new RegExp(name), `${name} 应在已实现区`)
    }
  })
})

// ------------------------------------------------------------
// JSON 形状（仅供类型断言，不参与运行时）
// ------------------------------------------------------------

interface StatusJson {
  command: string
  ok: boolean
  host: string
  project: string
  releaseRoot: string
  current: string | null
  previous: string | null
  releases: string[]
  deployed: boolean
  healthy: boolean | null
  reason?: string
  warnings: string[]
  error?: { code: string; message: string; hint?: string }
}

interface VerifyJson {
  command: string
  ok: boolean
  host: string
  project: string
  releaseId: string | null
  warnings: string[]
  error?: { code: string; message: string; hint?: string }
}

interface RollbackJson {
  command: string
  ok: boolean
  host: string
  project: string
  from: string | null
  to: string | null
  needsHealing: boolean
  warnings: string[]
  error?: { code: string; message: string; hint?: string }
}

async function makeRemoteConfigDir(): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-ops-remote-'))
  await fs.mkdir(join(dir, 'dist'), { recursive: true })
  await fs.writeFile(join(dir, 'dist', 'index.html'), 'x', 'utf8')
  await fs.writeFile(
    join(dir, 'deploy.config.json'),
    JSON.stringify({
      hosts: { prod: { ssh: 'deployer@10.0.0.5:2222' } },
      projects: {
        web: { source: { root: './dist' }, release: { root: '/srv/app' } },
        api: { source: { root: './dist' }, release: { root: '/srv/api' } },
      },
    }),
    'utf8',
  )
  return dir
}

/**
 * 真机 e2e —— 需要一台真的机器。**永远 skip**，不许在 CI 打开。
 * 保留在仓库里是为了让「注入覆盖不到的那一段」有明确落点：真 ssh、真部署、真回滚。
 */
describe.skip('ops · 真机 e2e', () => {
  it('在真目标机上跑通 apply → status → verify → rollback', async () => {
    await withLocalWorkspace(async (dir) => {
      const r = await runCli('status', dir, ['--json', '--host', 'local'], defaultApplyDeps())
      assert.equal(r.code, EXIT_OK, r.stderr)
    })
  })
})
