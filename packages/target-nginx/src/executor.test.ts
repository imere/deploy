/**
 * 执行器 —— 用内存 Runner 跑完整流程。
 *
 * 这里的假 Runner 不是「返回固定值」的桩，它实现了三件真机器上会咬人的事：
 *  1. **`nginx -t` 真的按 include 语义展开并判冲突** —— 于是「include 清单里混进
 *     上一轮影子目录的候选」会真的报 conflicting server name，而不是靠字符串比对蒙混过关；
 *  2. **跨文件系统的 rename 报 EXDEV** —— 影子目录配到 confd 之外时，
 *     「把候选直接 rename 过去」会真的失败；
 *  3. **readFile 对不存在的文件抛错、writeFile 要求父目录存在** —— 与 @dp/local 一致，
 *     于是「忘了建影子目录」「把读失败当成不存在」这两类错改法会当场露出来。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DpError,
  type ExecOptions,
  type ExecResult,
  type Facts,
  type FileStat,
  type Runner,
  type TargetContext,
} from '@dp/ports'
import { activateNginx, installNginx, isNginxExecFailure, rollbackNginx, verifyNginx, type NginxExecFailure, type NginxExecInput } from './executor.js'
import { renderConf } from './render.js'
import type { NginxTargetConfig } from './types.js'

// ------------------------------------------------------------
// 内存 Runner
// ------------------------------------------------------------

interface Node {
  readonly kind: 'dir' | 'file' | 'link'
  readonly content?: string
  readonly target?: string
}

interface ExecCall {
  readonly argv: readonly string[]
  readonly options?: ExecOptions
}

/** 让第 n 次（从 0 起）exec 失败。用「第几次」而不是「匹配 argv」，
 * 因为影子 -t 与复验 -t 的 argv 故意长得一样，测试要能分别控制它们 */
class MemoryRunner implements Runner {
  readonly id = 'memory'
  readonly facts: Facts
  readonly execs: ExecCall[] = []
  private readonly tree = new Map<string, Node>()
  /** 模拟的挂载点：跨它 rename = 跨文件系统 = EXDEV */
  private mountPoint: string | null = null
  /** 覆盖默认的 nginx -t 判定 */
  execOverride: ((argv: readonly string[], index: number) => ExecResult | undefined) | undefined

  constructor(facts: Facts) {
    this.facts = facts
    this.tree.set('/', { kind: 'dir' })
  }

  setMountPoint(prefix: string): void {
    this.mountPoint = prefix
  }

  private straddles(from: string, to: string): boolean {
    if (this.mountPoint === null) return false
    const mp = this.mountPoint
    return (from === mp || from.startsWith(`${mp}/`)) !== (to === mp || to.startsWith(`${mp}/`))
  }

  /** 测试辅助：直接塞一棵现成的树 */
  seed(path: string, content: string): void {
    const parts = path.split('/').filter((p) => p !== '')
    for (let i = 1; i < parts.length; i++) {
      this.tree.set(`/${parts.slice(0, i).join('/')}`, { kind: 'dir' })
    }
    this.tree.set(path, { kind: 'file', content })
  }

  /** 某个目录下每个文件的路径 → 内容，用于「逐字没变」的断言 */
  snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of [...this.tree.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (v.kind === 'file' && (k === dir || k.startsWith(`${dir}/`))) out[k] = v.content ?? ''
    }
    return out
  }

  argvs(): readonly (readonly string[])[] {
    return this.execs.map((e) => e.argv)
  }

  private childrenOf(path: string): readonly Node[] {
    return [...this.tree.entries()]
      .filter(([k]) => k.startsWith(`${path}/`) && !k.slice(path.length + 1).includes('/'))
      .map(([, v]) => v)
  }

  // ---- nginx 判定：按 include 语义展开，再判冲突 ----

  private expandInclude(target: string): readonly string[] {
    const node = this.tree.get(target)
    if (node === undefined) return []
    if (node.kind === 'dir') {
      // nginx 的目录 include 会把里面的文件都拉进来（这里是刻意的简化：只展开一层，
      // 足够把「上一轮影子目录里的候选」这类错误暴露出来）
      return [...this.tree.entries()]
        .filter(([k, v]) => v.kind === 'file' && k.startsWith(`${target}/`) && !k.slice(target.length + 1).includes('/'))
        .map(([k]) => k)
        .sort()
    }
    return [target]
  }

  private serverNames(content: string): readonly string[] {
    const names: string[] = []
    for (const line of content.split('\n')) {
      const m = /^\s*server_name\s+(.+);/.exec(line)
      if (m !== null) names.push(...(m[1] ?? '').trim().split(/\s+/).filter((n) => n !== ''))
    }
    return names
  }

  /** 真实 nginx 的两种典型失败：同一份文件被 include 两次 / 两个文件抢同一个 server_name */
  private testConfTree(files: readonly string[]): ExecResult {
    const seenFiles = new Set<string>()
    const owner = new Map<string, string>()
    for (const file of files) {
      if (seenFiles.has(file)) {
        return { code: 1, stdout: '', stderr: `nginx: [emerg] duplicate config file ${file}` }
      }
      seenFiles.add(file)
      const content = this.tree.get(file)?.content ?? ''
      for (const name of this.serverNames(content)) {
        const prev = owner.get(name)
        if (prev !== undefined) {
          return {
            code: 1,
            stdout: '',
            stderr: `nginx: [emerg] conflicting server name "${name}" on 0.0.0.0:80, in ${file} and ${prev}`,
          }
        }
        owner.set(name, file)
      }
    }
    return { code: 0, stdout: 'configuration file test is successful', stderr: '' }
  }

  private defaultExec(argv: readonly string[]): ExecResult {
    const isTest = argv[0] === 'nginx' && argv[1] === '-t'
    if (!isTest) return { code: 0, stdout: '', stderr: '' }

    const cIndex = argv.indexOf('-c')
    if (cIndex >= 0 && argv[cIndex + 1] !== undefined) {
      // 影子主配置：按它自己写的 include 清单展开
      const main = argv[cIndex + 1]!
      const mainConf = this.tree.get(main)?.content
      if (mainConf === undefined) {
        return { code: 1, stdout: '', stderr: `nginx: [emerg] cannot load ${main}` }
      }
      const files: string[] = []
      for (const line of mainConf.split('\n')) {
        const m = /^\s*include\s+(.+);/.exec(line)
        if (m !== null) files.push(...this.expandInclude((m[1] ?? '').trim()))
      }
      return this.testConfTree(files)
    }

    // 生产主配置：假定是最常见的 `include <confd>/*.conf`（只匹配顶层 .conf 文件）。
    // 真实主配置长什么样我们无从得知，这里明确假设成这一种，
    // 好让测试盯住的是本包自己的逻辑而不是别人的 include 风格。
    const files = [...this.tree.entries()]
      .filter(([k, v]) => v.kind === 'file' && k.endsWith('.conf') && k.slice(1).split('/').length === 2)
      .map(([k]) => k)
      .sort()
    return this.testConfTree(files)
  }

  async exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ argv, ...(options !== undefined ? { options } : {}) })
    return this.execOverride?.(argv, this.execs.length - 1) ?? this.defaultExec(argv)
  }

  async stat(path: string): Promise<FileStat | null> {
    const n = this.tree.get(path)
    if (n === undefined) return null
    return { isDirectory: n.kind === 'dir', isSymbolicLink: n.kind === 'link', size: n.content?.length ?? 0, mtimeMs: 0 }
  }

  async listDir(path: string): Promise<readonly string[]> {
    if (this.tree.get(path) === undefined) return []
    const out: string[] = []
    for (const key of this.tree.keys()) {
      if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) {
        out.push(key.slice(path.length + 1))
      }
    }
    return out
  }

  async mkdir(path: string): Promise<void> {
    const parts = path.split('/').filter((p) => p !== '')
    for (let i = 1; i <= parts.length; i++) {
      const p = `/${parts.slice(0, i).join('/')}`
      if (this.tree.get(p) === undefined) this.tree.set(p, { kind: 'dir' })
    }
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    // 真 fs.writeFile 不建父目录：忘了 mkdir 影子目录会当场失败，不会静默成功
    const idx = path.lastIndexOf('/')
    if (this.tree.get(path.slice(0, idx)) === undefined) {
      throw new DpError('DP.PATH.NOT_WRITABLE', `ENOENT：父目录不存在 ${path.slice(0, idx)}`)
    }
    this.tree.set(path, { kind: 'file', content: typeof data === 'string' ? data : new TextDecoder().decode(data) })
  }

  async readFile(path: string): Promise<string> {
    const n = this.tree.get(path)
    if (n === undefined) throw new DpError('DP.PATH.NOT_WRITABLE', `不存在：${path}`)
    return n.content ?? ''
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
    if (this.straddles(from, to)) {
      throw new DpError('DP.PATH.NOT_WRITABLE', `EXDEV：${from} → ${to} 跨文件系统`)
    }
    if (this.tree.get(from) === undefined) {
      throw new DpError('DP.PATH.NOT_WRITABLE', `不存在：${from}`)
    }
    await this.remove(to)
    const nodes = [...this.tree.entries()].filter(([k]) => k === from || k.startsWith(`${from}/`))
    for (const [k, v] of nodes) {
      this.tree.set(to + k.slice(from.length), v)
      this.tree.delete(k)
    }
  }

  async symlink(): Promise<void> {
    throw new DpError('DP.PATH.NOT_WRITABLE', '内存 Runner 不支持软链')
  }

  async readlink(path: string): Promise<string | null> {
    return this.tree.get(path)?.target ?? null
  }

  async realpath(path: string): Promise<string> {
    return path
  }
}

function makeFacts(over: Partial<Facts> = {}): Facts {
  return {
    host: 'web-01',
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

const CONFD = '/etc/nginx/conf.d'
const TARGET = `${CONFD}/web.conf`
const BACKUP = `${TARGET}.dp-backup`
const SHADOW_MAIN = `${CONFD}/.dp-shadow/r-1/nginx.shadow.conf`

const CONFIG: NginxTargetConfig = {
  confd: CONFD,
  render: { project: 'web', env: 'prod', release: { id: 'r-1', current: '/srv/web/current' } },
  server: { serverName: ['web.example.com'], root: '${release.current}' },
}

function makeCtx(over: Partial<TargetContext> = {}): TargetContext {
  return { host: 'web-01', root: '/srv/web', releaseId: 'r-1', keep: 3, ...over }
}

function makeInput(runner: Runner, over: Partial<NginxExecInput> = {}): NginxExecInput {
  return { runner, ctx: makeCtx(), config: CONFIG, ...over }
}

const RENDERED = renderConf(CONFIG.server, CONFIG.render, { path: 'projects.web.target.nginx.server' })

/** 铁律 0 的机器化检查：每条 exec 都必须有 timeout，且永远不喂 stdin */
function assertExecInvariants(runner: MemoryRunner): void {
  for (const call of runner.execs) {
    assert.notEqual(call.options?.timeoutMs, undefined, `exec 缺 timeoutMs：${call.argv.join(' ')}`)
    assert.equal(call.options?.stdin, undefined, `exec 喂了 stdin：${call.argv.join(' ')}`)
  }
}

async function capture(p: Promise<unknown>): Promise<{ readonly error: DpError }> {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof DpError, `期望 DpError，实际：${String(err)}`)
    return { error: err }
  }
  throw new Error('期望抛错，但没有')
}

/** 失败现场。读不出来就当场失败：把读不出来的字段当成空数组，恰好是这类测试最常见的假绿 */
function failureOf(error: DpError): NginxExecFailure {
  const cause: unknown = error.cause
  if (!isNginxExecFailure(cause)) {
    throw new Error(`DpError.cause 里没有 NginxExecFailure：${error.code}`)
  }
  return cause
}

// ------------------------------------------------------------
// install
// ------------------------------------------------------------

describe('installNginx', () => {
  it('首次部署：写候选 → 影子校验，argv 顺序正确且不碰目标文件', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)

    const result = await installNginx(makeInput(runner))

    assert.equal(result.ok, true)
    assert.deepEqual(result.steps.map((s) => s.id), ['nginx.render', 'nginx.write-candidate', 'nginx.validate-shadow'])
    assert.deepEqual(runner.argvs(), [['nginx', '-t', '-c', SHADOW_MAIN]])
    // 候选写在影子目录里，目标文件此刻还不该存在
    assert.equal(await runner.readFile(`${CONFD}/.dp-shadow/r-1/web.conf`), RENDERED)
    assert.equal(await runner.stat(TARGET), null)
    assert.equal(result.ownership?.action, 'create')
    assertExecInvariants(runner)
  })

  it('影子主配置只 include 真实 confd 的其它文件 + 候选，不含目标文件自己', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(`${CONFD}/api.conf`, '# managed by dp\nserver {\n  server_name api.example.com;\n}\n')

    await installNginx(makeInput(runner))

    const main = await runner.readFile(SHADOW_MAIN)
    assert.match(main, /include \/etc\/nginx\/conf\.d\/api\.conf;/)
    assert.match(main, /include \/etc\/nginx\/conf\.d\/\.dp-shadow\/r-1\/web\.conf;/)
    // 目标文件若被 include，与候选会抢同一个 server_name —— 替换永远过不了第一步校验
    assert.equal(main.includes(`include ${TARGET};`), false)
    assertExecInvariants(runner)
  })

  it('目标文件不带标记 → NOT_MANAGED，且 confd 逐字未变', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    const handWritten = 'server {\n  server_name hand.example.com;\n}\n'
    await runner.seed(TARGET, handWritten)
    await runner.seed(`${CONFD}/api.conf`, '# managed by dp\n')
    const before = runner.snapshot(CONFD)

    const { error } = await capture(installNginx(makeInput(runner)))

    assert.equal(error.code, 'DP.NGX.NOT_MANAGED')
    assert.ok(error.hint !== undefined && error.hint.length > 0, '错误必须带 hint')
    // 判定排在任何 mkdir/writeFile 之前：影子目录默认就在 confd 之下，
    // 判定放在写候选之后就等于「已经动过 confd 才说这个文件不该动」
    assert.deepEqual(runner.snapshot(CONFD), before)
    assert.deepEqual(runner.argvs(), [])
    assertExecInvariants(runner)
  })

  it('force: true 覆盖无标记文件 → 仍先备份（不直接抹掉）', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    const handWritten = 'server {\n  server_name hand.example.com;\n}\n'
    await runner.seed(TARGET, handWritten)

    const result = await activateNginx(makeInput(runner, { config: { ...CONFIG, force: true } }))

    assert.equal(result.ownership?.action, 'replace')
    assert.equal(await runner.readFile(TARGET), RENDERED)
    assert.equal(await runner.readFile(BACKUP), handWritten)
    assertExecInvariants(runner)
  })

  it('影子校验失败 → 生产目录零改动，且错误里带 nginx 的 stderr', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    const existing = '# managed by dp\nserver {\n  server_name web.example.com;\n  root /old;\n}\n'
    await runner.seed(TARGET, existing)
    const before = runner.snapshot(CONFD)
    runner.execOverride = () => ({ code: 1, stdout: '', stderr: 'nginx: [emerg] unknown directive "retr"' })

    const { error } = await capture(installNginx(makeInput(runner)))

    assert.equal(error.code, 'DP.NGX.TEST_FAILED')
    // 只报「校验失败」等于让用户自己上机器重跑一遍才知道原因
    assert.match(String(error.cause ? JSON.stringify(error.cause) : ''), /unknown directive/)
    assert.match(error.message, /nginx/)
    const cause = failureOf(error)
    assert.match(cause.output ?? '', /unknown directive "retr"/)
    // 影子目录必须被撤掉，confd 回到调用前的样子
    assert.deepEqual(runner.snapshot(CONFD), before)
    assertExecInvariants(runner)
  })

  it('第二次部署的 include 清单不含上一轮影子目录里的候选（否则撞 conflicting）', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await installNginx(makeInput(runner))
    await activateNginx(makeInput(runner))

    // 换 releaseId 走第二轮。上一轮的影子目录还留在 confd 下面，
    // 它的候选与本轮候选抢同一个 server_name —— 漏排除就必然报 conflicting
    const second = { ...CONFIG, render: { ...CONFIG.render, release: { id: 'r-2', current: '/srv/web/current' } } }
    const result = await installNginx(
      makeInput(runner, { ctx: makeCtx({ releaseId: 'r-2', previousReleaseId: 'r-1' }), config: second }),
    )

    assert.equal(result.ok, true)
    const main = await runner.readFile(`${CONFD}/.dp-shadow/r-2/nginx.shadow.conf`)
    assert.equal(main.includes('r-1'), false, '影子主配置把上一轮影子目录拉进来了')
    assertExecInvariants(runner)
  })

  it('dryRun：跑完真影子校验，但不留任何东西在 confd、不发 reload', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(`${CONFD}/api.conf`, '# managed by dp\nserver {\n  server_name api.example.com;\n}\n')
    const before = runner.snapshot(CONFD)

    const result = await installNginx(makeInput(runner, { dryRun: true }))

    assert.equal(result.dryRun, true)
    // 影子校验真的跑了（否则「dry-run 通过」就是没验过）
    assert.deepEqual(runner.argvs(), [['nginx', '-t', '-c', SHADOW_MAIN]])
    assert.deepEqual(runner.snapshot(CONFD), before)
    assertExecInvariants(runner)
  })

  it('dryRun 撤销要连影子目录本身一起收掉，不留空目录在 confd', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(`${CONFD}/api.conf`, '# managed by dp\nserver {\n  server_name api.example.com;\n}\n')

    await installNginx(makeInput(runner, { dryRun: true }))

    // snapshot 只收文件，抓不到空目录 —— 这里必须单独问目录在不在。
    // 留一个空的 .dp-shadow 在 confd 里，等于 dry-run 之后 confd 与调用前不一样
    assert.equal(await runner.stat(`${CONFD}/.dp-shadow`), null, 'dryRun 撤销只删了最里面那级，.dp-shadow 留下了')
    assert.equal(await runner.stat(`${CONFD}/.dp-shadow/r-1`), null)
  })

  it('dryRun 撤销不许连上一轮其它 release 的影子目录一起删', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    // 上一轮（r-0）的影子目录留在现场 —— 本轮撤销只许收掉本轮建的那一支
    await runner.mkdir(`${CONFD}/.dp-shadow/r-0`)
    await runner.seed(`${CONFD}/.dp-shadow/r-0/nginx.shadow.conf`, 'events {}\n')

    await installNginx(makeInput(runner, { dryRun: true }))

    assert.notEqual(await runner.stat(`${CONFD}/.dp-shadow/r-0/nginx.shadow.conf`), null, '把上一轮的候选删了')
    // .dp-shadow 这一级是上一轮建的，本轮不该动它
    assert.notEqual(await runner.stat(`${CONFD}/.dp-shadow`), null)
    assert.equal(await runner.stat(`${CONFD}/.dp-shadow/r-1`), null, '本轮建的那一支没收掉')
  })

  it('confd 都是本轮刚建出来的时候，撤销也只收到 .dp-shadow —— 不删 nginx 自己的目录', async () => {
    const runner = new MemoryRunner(makeFacts())
    // 故意不 mkdir(CONFD)：让整条链都由本轮建出来
    await runner.mkdir('/etc/nginx')

    await installNginx(makeInput(runner, { dryRun: true }))

    assert.notEqual(await runner.stat(CONFD), null, '撤销把 confd 自己删了 —— 那是 nginx 的目录')
    assert.equal(await runner.stat(`${CONFD}/.dp-shadow`), null, 'confd 之下该收干净')
  })

  it('dryRun 也照样做所有权判定 —— 那正是 dry-run 最该告诉用户的事', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, 'server {\n  server_name hand.example.com;\n}\n')
    const before = runner.snapshot(CONFD)

    const { error } = await capture(installNginx(makeInput(runner, { dryRun: true })))

    assert.equal(error.code, 'DP.NGX.NOT_MANAGED')
    assert.deepEqual(runner.snapshot(CONFD), before)
  })
})

// ------------------------------------------------------------
// activate
// ------------------------------------------------------------

describe('activateNginx', () => {
  it('完整生效：备份 → 替换 → 复验 → reload，argv 序列正确', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    const old = '# managed by dp\nserver {\n  server_name web.example.com;\n  root /old;\n}\n'
    await runner.seed(TARGET, old)

    const result = await activateNginx(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) }))

    assert.deepEqual(
      result.steps.map((s) => s.id),
      ['nginx.backup', 'nginx.replace', 'nginx.validate-live', 'nginx.reload'],
    )
    assert.deepEqual(runner.argvs(), [['nginx', '-t'], ['nginx', '-s', 'reload']])
    assert.equal(result.reloaded, true)
    assert.equal(await runner.readFile(TARGET), RENDERED)
    assert.equal(await runner.readFile(BACKUP), old)
    // 中间文件用完即走，不能留在 confd 里
    assert.equal(await runner.stat(`${TARGET}.dp-new`), null)
    assertExecInvariants(runner)
  })

  it('带标记的同名文件走备份 + 替换', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, '# managed by dp\n# 我自己加的注释\nserver {\n  root /old;\n}\n')

    const result = await activateNginx(makeInput(runner))

    assert.equal(result.ownership?.action, 'replace')
    assert.equal(result.ownership?.backup, true)
    assert.match(await runner.readFile(BACKUP), /我自己加的注释/)
    assert.equal(await runner.readFile(TARGET), RENDERED)
  })

  it('影子目录在 confd 之外（模拟另一个文件系统）时替换仍然成功', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.mkdir('/var/lib/dp-shadow')
    runner.setMountPoint('/var/lib/dp-shadow')
    const config: NginxTargetConfig = { ...CONFIG, shadowDir: '/var/lib/dp-shadow' }
    await runner.seed(TARGET, '# managed by dp\nserver {\n  root /old;\n}\n')

    // 若执行器走「把候选 rename 过去」，这里会真的撞上 EXDEV
    const result = await activateNginx(makeInput(runner, { config, ctx: makeCtx({ previousReleaseId: 'r-0' }) }))

    assert.equal(result.ok, true)
    assert.equal(await runner.readFile(TARGET), RENDERED)
    // 替换全程在 confd 内完成，没有跨文件系统地搬运任何东西
    assert.deepEqual(runner.snapshot('/var/lib/dp-shadow'), {})
    assertExecInvariants(runner)
  })

  it('复验失败 → conf 被还原成原状，reload 没有被调用', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    const old = '# managed by dp\nserver {\n  server_name web.example.com;\n  root /old;\n}\n'
    await runner.seed(TARGET, old)

    runner.execOverride = () => ({ code: 1, stdout: '', stderr: 'nginx: [emerg] conflicting server name "web.example.com"' })

    const { error } = await capture(activateNginx(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) })))

    assert.equal(error.code, 'DP.NGX.TEST_FAILED')
    assert.equal(await runner.readFile(TARGET), old, 'conf 没有被还原')
    // activate 本身没有影子 -t：复验 1 次 + 还原后确认回到原状 1 次
    assert.deepEqual(runner.argvs(), [
      ['nginx', '-t'],
      ['nginx', '-t'],
    ])
    assert.equal(await runner.stat(BACKUP), null, '备份被还原回原位了')
    const cause = failureOf(error)
    assert.ok(cause.compensated.length > 0, '没有记录任何补偿动作')
    assertExecInvariants(runner)
  })

  it('reload 失败不回滚：盘上的 conf 已通过 -t，回滚只会制造第二次不一致', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, '# managed by dp\nserver {\n  root /old;\n}\n')

    runner.execOverride = (argv) =>
      argv[1] === '-s' ? { code: 1, stdout: '', stderr: 'nginx: invalid PID number' } : undefined

    const { error } = await capture(activateNginx(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) })))

    assert.equal(error.code, 'DP.NGX.RELOAD_FAILED')
    assert.equal(await runner.readFile(TARGET), RENDERED, '好文件被换回旧的了')
    assertExecInvariants(runner)
  })

  it('reload: false → 不发任何重载命令，但仍产出「已禁用」那条步骤', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, '# managed by dp\nserver {\n  root /old;\n}\n')

    const result = await activateNginx(makeInput(runner, { config: { ...CONFIG, reload: false } }))

    assert.deepEqual(result.steps.map((s) => s.id), ['nginx.backup', 'nginx.replace', 'nginx.validate-live', 'nginx.reload'])
    assert.deepEqual(runner.argvs(), [['nginx', '-t']])
    assert.equal(result.reloaded, false)
  })

  it('dryRun：不写 confd、不 rename、不 reload，判定照样给出', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, '# managed by dp\nserver {\n  root /old;\n}\n')
    const before = runner.snapshot(CONFD)

    const result = await activateNginx(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }), dryRun: true }))

    assert.equal(result.ownership?.action, 'replace')
    assert.deepEqual(runner.argvs(), [])
    assert.deepEqual(runner.snapshot(CONFD), before)
    // 备份 / 替换 / 复验 / reload 四步全是 skipped。备份尤其不能记成 ran：
    // 报告「已备份」而磁盘上没有，比压根不做备份更难发现
    const skipped = result.steps.filter((s) => s.skipped).map((s) => s.id)
    assert.deepEqual(skipped, ['nginx.backup', 'nginx.replace', 'nginx.validate-live', 'nginx.reload'])
    assertExecInvariants(runner)
  })

  it('dryRun 的备份不记成已执行 —— 报告了没发生的副作用比不做更难查', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, '# managed by dp\nserver {\n  root /old;\n}\n')

    const result = await activateNginx(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }), dryRun: true }))

    const backup = result.steps.find((s) => s.id === 'nginx.backup')
    assert.equal(backup?.skipped, true, 'dryRun 下备份没有真的发生，就不许记成 ran')
    // 备份确实没有发生：盘上没有多出备份文件
    assert.equal((await runner.stat(BACKUP)) === null, true)
  })
})

// ------------------------------------------------------------
// verify / rollback
// ------------------------------------------------------------

describe('verifyNginx', () => {
  it('内容一致 → 通过', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, RENDERED)

    const result = await verifyNginx(makeInput(runner))

    assert.deepEqual(result.warnings, [])
    assert.deepEqual(result.steps.map((s) => s.id), ['nginx.verify-conf'])
  })

  it('内容漂移 → 报警告而不是回滚（那份内容本身可能完全合法）', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, `${RENDERED}# 有人在部署之后手改过\n`)

    const result = await verifyNginx(makeInput(runner))

    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0] ?? '', /DP.VERIFY.FAILED/)
  })

  it('文件缺失 → 直接失败', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)

    const { error } = await capture(verifyNginx(makeInput(runner)))

    assert.equal(error.code, 'DP.VERIFY.FAILED')
  })
})

describe('rollbackNginx', () => {
  it('还原备份 → 复验 → reload', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    const old = '# managed by dp\nserver {\n  server_name web.example.com;\n  root /old;\n}\n'
    await runner.seed(TARGET, RENDERED)
    await runner.seed(BACKUP, old)

    const result = await rollbackNginx(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) }))

    assert.equal(await runner.readFile(TARGET), old)
    assert.deepEqual(runner.argvs(), [['nginx', '-t'], ['nginx', '-s', 'reload']])
    assert.equal(result.reloaded, true)
    assertExecInvariants(runner)
  })

  it('没有备份 → NO_PREVIOUS，且不报「回滚成功」这种假结果', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, RENDERED)
    const before = runner.snapshot(CONFD)

    const { error } = await capture(rollbackNginx(makeInput(runner, { ctx: makeCtx({ previousReleaseId: 'r-0' }) })))

    assert.equal(error.code, 'DP.NGX.NO_PREVIOUS')
    assert.deepEqual(runner.snapshot(CONFD), before)
    assert.deepEqual(runner.argvs(), [])
  })

  it('previousReleaseId 缺失 → 动手之前就报错', async () => {
    const runner = new MemoryRunner(makeFacts())
    await runner.mkdir(CONFD)
    await runner.seed(TARGET, RENDERED)
    await runner.seed(BACKUP, '# managed by dp\n')

    const { error } = await capture(rollbackNginx(makeInput(runner)))

    assert.equal(error.code, 'DP.NGX.NO_PREVIOUS')
    assert.deepEqual(runner.argvs(), [])
  })
})
