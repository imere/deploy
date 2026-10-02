/**
 * 用内存 Runner 测 static 目标。
 *
 * 为什么要有这一层：Release/切换/清理的语义与文件系统无关，
 * 把它抽出来就能在任何平台上断言，不需要真 Windows / 真 macOS 机器
 * （docs/testing.md §3.1 —— 纯函数夹具层）。
 */
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
import { deploy, prune, rollback, staticTarget, verifyRelease, type StaticTargetConfig } from './index.js'

// ------------------------------------------------------------
// 内存 Runner：把文件系统语义实现到刚好够用
// ------------------------------------------------------------

interface Node {
  kind: 'dir' | 'file' | 'link'
  content?: string
  target?: string
  mode?: number
}

class MemoryRunner implements Runner {
  readonly id = 'memory'
  readonly facts: Facts
  private readonly tree = new Map<string, Node>()

  constructor(facts: Facts) {
    this.facts = facts
    this.tree.set('/', { kind: 'dir' })
  }

  private childDir(p: string): string[] {
    const out: string[] = []
    for (const key of this.tree.keys()) {
      if (key.startsWith(`${p}/`) && !key.slice(p.length + 1).includes('/')) out.push(key)
    }
    return out
  }

  async exec(): Promise<ExecResult> {
    throw new DpError('CONFIG_INVALID', '内存 Runner 不执行命令')
  }

  async stat(path: string): Promise<FileStat | null> {
    const n = this.tree.get(path)
    if (n === undefined) return null
    return {
      isDirectory: n.kind === 'dir',
      isSymbolicLink: n.kind === 'link',
      size: n.content?.length ?? 0,
      mtimeMs: 0,
    }
  }

  async listDir(path: string): Promise<readonly string[]> {
    return this.childDir(path).map((k) => k.slice(path.length + 1))
  }

  async mkdir(path: string): Promise<void> {
    this.tree.set(path, { kind: 'dir' })
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    this.tree.set(path, {
      kind: 'file',
      content: typeof data === 'string' ? data : new TextDecoder().decode(data),
    })
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path))
  }

  async readFile(path: string): Promise<string> {
    const n = this.tree.get(path)
    if (n === undefined) throw new DpError('DP.PATH.NOT_WRITABLE', `不存在：${path}`)
    return n.content ?? ''
  }

  async remove(path: string): Promise<void> {
    for (const key of [...this.tree.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.tree.delete(key)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const nodes = [...this.tree.entries()].filter(([k]) => k === from || k.startsWith(`${from}/`))
    await this.remove(to)
    for (const [k, v] of nodes) {
      this.tree.set(to + k.slice(from.length), v)
      this.tree.delete(k)
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (!this.facts.capabilities.canSymlink) throw new DpError('DP.PATH.NOT_WRITABLE', '不支持软链')
    this.tree.set(linkPath, { kind: 'link', target })
  }

  async readlink(path: string): Promise<string | null> {
    return this.tree.get(path)?.target ?? null
  }

  async realpath(path: string): Promise<string> {
    return path
  }

  /** 测试辅助：直接读 resolved 后的 current 指向 */
  async resolvedCurrent(root: string): Promise<string | null> {
    const link = await this.readlink(`${root}/current`)
    if (link === null) return null
    return link.slice(link.lastIndexOf('/') + 1)
  }
}

function makeFacts(over: Partial<Facts> = {}): Facts {
  return {
    host: 'memory',
    platform: 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: '/home/u',
    tmpdir: '/tmp',
    env: {},
    capabilities: {
      canWrite: {},
      canChown: [],
      canSymlink: true,
      systemdScope: 'none',
      lingerEnabled: false,
      canBindPrivilegedPort: false,
      sudoAllowlist: [],
    },
    tools: {},
    ...over,
  }
}

function fileEntry(relativePath: string, content: string) {
  return { kind: 'file' as const, relativePath, read: async () => new TextEncoder().encode(content) }
}

function makeCtx(over: Partial<TargetContext> = {}): TargetContext {
  return { host: 'memory', root: '/app', releaseId: 'r1', keep: 3, ...over }
}

describe('static target · plan', () => {
  it('install / activate / verify / rollback 都有无 version 的 undo 描述', () => {
    const ctx = makeCtx({ previousReleaseId: 'r0' })
    const cfg: StaticTargetConfig = { healthcheck: { fileExists: ['index.html'] } }

    const install = staticTarget.planInstall(ctx, cfg)
    const activate = staticTarget.planActivate(ctx, cfg)
    const verify = staticTarget.planVerify(ctx, cfg)
    const rollbackPlan = staticTarget.planRollback(ctx, cfg)

    assert.equal(install.every((s) => typeof s.undo === 'string' && s.undo.length > 0), true)
    assert.equal(activate[0]!.undo, 'current 指回 releases/r0')
    assert.match(verify[0]!.title, /index\.html/)
    assert.match(rollbackPlan[0]!.title, /r0/)
  })

  it('首次部署时 activate 的 undo 不是空操作', () => {
    const steps = staticTarget.planActivate(makeCtx(), {})
    assert.equal(steps[0]!.undo, '删除 current（首次部署，无上一版）')
  })
})

describe('static target · deploy', () => {
  it('首次部署后 current 指向新版本', async () => {
    const runner = new MemoryRunner(makeFacts())
    const result = await deploy({
      runner,
      ctx: makeCtx(),
      entries: [fileEntry('index.html', '<html>')],
    })
    assert.equal(result.filesWritten, 1)
    assert.equal(await runner.resolvedCurrent('/app'), 'r1')
    assert.equal(await runner.readFile('/app/releases/r1/index.html'), '<html>')
  })

  it('第二次部署后 current 换到新版本，旧版本仍在', async () => {
    const runner = new MemoryRunner(makeFacts())
    await deploy({ runner, ctx: makeCtx(), entries: [fileEntry('a.txt', 'v1')] })
    const second = await deploy({
      runner,
      ctx: makeCtx({ releaseId: 'r2', previousReleaseId: 'r1' }),
      entries: [fileEntry('a.txt', 'v2')],
    })
    assert.equal(second.previousReleaseId, 'r1')
    assert.equal(await runner.resolvedCurrent('/app'), 'r2')
    assert.equal(await runner.readFile('/app/releases/r1/a.txt'), 'v1')
    assert.equal(await runner.readFile('/app/releases/r2/a.txt'), 'v2')
  })

  it('健康检查失败时自动回退到上一版并抛错', async () => {
    const runner = new MemoryRunner(makeFacts())
    await deploy({ runner, ctx: makeCtx(), entries: [fileEntry('index.html', 'v1')] })

    await assert.rejects(
      deploy({
        runner,
        ctx: makeCtx({ releaseId: 'r2', previousReleaseId: 'r1' }),
        entries: [fileEntry('other.txt', 'v2')],
        config: { healthcheck: { fileExists: ['index.html'] } },
      }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.VERIFY.FAILED')
        return true
      },
    )
    // 关键断言：回退后 current 仍在旧版本，服务没有悬空
    assert.equal(await runner.resolvedCurrent('/app'), 'r1')
  })

  it('source 为空时直接拒绝，并把现场收拾干净', async () => {
    const runner = new MemoryRunner(makeFacts())
    await assert.rejects(
      deploy({ runner, ctx: makeCtx(), entries: [] }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SOURCE.EMPTY')
        return true
      },
    )
    // 关键：发布空版本 = 线上变 404，所以必须零副作用地失败
    assert.equal(await runner.stat('/app/current'), null)
    assert.deepEqual(await runner.listDir('/app/releases'), [])
  })

  it('不支持软链时退化为复制，源 release 目录仍完好', async () => {
    const runner = new MemoryRunner(
      makeFacts({ capabilities: { ...makeFacts().capabilities, canSymlink: false } }),
    )
    const result = await deploy({ runner, ctx: makeCtx(), entries: [fileEntry('a.txt', 'v1')] })
    assert.match(result.warnings.join(), /DP\.LINK\.UNAVAILABLE/)
    assert.equal(await runner.readFile('/app/current/a.txt'), 'v1')
    assert.equal(
      await runner.readFile('/app/releases/r1/a.txt'),
      'v1',
      '复制不能把源目录掏空 —— 掏空了 release 就成了残疾版本',
    )
  })
})

describe('static target · prune 与 rollback', () => {
  it('保留 keep 个版本，且永不清理当前版本与上一版', async () => {
    const runner = new MemoryRunner(makeFacts())
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
      // 这里的 releases 目录要真实存在，prune 才有的可扫
      await runner.mkdir(`/app/releases/${id}`)
    }
    const kept = await prune(runner, '/app', 2, 'r5', 'r4')
    assert.ok(kept.includes('r5'), '当前版本必须保留')
    assert.ok(kept.includes('r4'), '上一版必须保留 —— 清理掉等于把回退这条路炸了')
    assert.ok(!kept.includes('r1'))
  })

  it('rollback 把 current 指回上一版', async () => {
    const runner = new MemoryRunner(makeFacts())
    await deploy({ runner, ctx: makeCtx(), entries: [fileEntry('a.txt', 'v1')] })
    await deploy({
      runner,
      ctx: makeCtx({ releaseId: 'r2', previousReleaseId: 'r1' }),
      entries: [fileEntry('a.txt', 'v2')],
    })
    const back = await rollback(runner, makeCtx({ releaseId: 'r2', previousReleaseId: 'r1' }))
    assert.equal(back, 'r1')
    assert.equal(await runner.resolvedCurrent('/app'), 'r1')
  })

  it('没有上一版时 rollback 明确报错，不做"看起来成功"的操作', async () => {
    const runner = new MemoryRunner(makeFacts())
    await assert.rejects(rollback(runner, makeCtx()), (err: unknown) => {
      assert.ok(err instanceof DpError)
      return true
    })
  })

  it('verifyRelease 能用必需文件清单判定', async () => {
    const runner = new MemoryRunner(makeFacts())
    const ctx = makeCtx()
    await runner.mkdir('/app/releases/r1')
    const cfg: StaticTargetConfig = { healthcheck: { fileExists: ['index.html'] } }
    assert.equal((await verifyRelease(runner, ctx, cfg)).ok, false)
    await runner.writeFile('/app/releases/r1/index.html', 'x')
    assert.equal((await verifyRelease(runner, ctx, cfg)).ok, true)
  })
})
