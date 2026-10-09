import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { deriveLayout, pickReleaseRoot } from '@dp/core'
import { DpError, type Facts, type Platform } from '@dp/ports'
import { EXIT_CONFIG, EXIT_OK } from '../output.js'
import { collectProjectFacts } from '../project-facts.js'
import { releaseRootCandidates } from '../facts-source.js'
import { runDeploy, type DeployFlags } from './deploy.js'
import { createContext } from '../run.js'
import { main } from '../index.js'
import { defaultApplyDeps, type ApplyDeps } from '../deps.js'

/**
 * 零配置**读的是真实磁盘**：源根、条目、package.json 全是文件系统的结论。
 * 拿一份内存夹具去断言它等于什么都没验 —— 而这里最该验的恰恰是
 * 「它看到的与盘上的是不是同一批东西」（node_modules 排没排掉、
 * 分隔符有没有归一、坏 JSON 有没有报错）。
 */
async function withProject(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-deploy-'))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function caught(fn: () => unknown): DpError {
  try {
    fn()
  } catch (err) {
    if (err instanceof DpError) return err
    throw new Error(`期望 DpError，实际是 ${String(err)}`)
  }
  throw new Error('期望抛错，但没有')
}

async function caughtAsync(p: Promise<unknown>): Promise<DpError> {
  try {
    await p
  } catch (err) {
    if (err instanceof DpError) return err
    throw new Error(`期望 DpError，实际是 ${String(err)}`)
  }
  throw new Error('期望抛错，但没有')
}

async function writeSource(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'))
    await fs.mkdir(join(abs, '..'), { recursive: true })
    await fs.writeFile(abs, body, 'utf8')
  }
}

/**
 * 铺一棵 N 个文件的树，**有限并发**。
 *
 * 上限那条断言只有真文件才有意义，所以压的是并发度而不是文件数：串行同步写
 * 2001 个文件实测 25s（Windows 上每个新建文件都要过一遍杀软），64 路并发
 * 把它压到几秒；无上限的 `Promise.all` 反而会因为同时 open 几千个句柄而更慢。
 */
async function writeManyFiles(dir: string, count: number): Promise<void> {
  const CONCURRENCY = 64
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next
      next += 1
      if (i >= count) return
      await fs.writeFile(join(dir, `f${i}.js`), 'x', 'utf8')
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
}

describe('collectProjectFacts · 源根与清单', () => {
  it('四个候选按 dist > build > out > public 挑第一个存在的', async () => {
    await withProject(async (dir) => {
      for (const name of ['dist', 'build', 'out', 'public']) {
        await fs.mkdir(join(dir, name))
        await fs.writeFile(join(dir, name, `${name}.html`), 'x', 'utf8')
      }
      assert.deepEqual(collectProjectFacts(dir).entries, ['dist.html'])

      await fs.rm(join(dir, 'dist'), { recursive: true })
      assert.deepEqual(collectProjectFacts(dir).entries, ['build.html'])
    })
  })

  it('existingDirs 只读一层，且排掉 node_modules 与 .git', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/index.html': 'x', 'dist/assets/app.js': 'y' })
      await fs.mkdir(join(dir, 'node_modules', 'left-pad'), { recursive: true })
      await fs.mkdir(join(dir, '.git'), { recursive: true })
      await fs.mkdir(join(dir, 'src'), { recursive: true })

      const facts = collectProjectFacts(dir)
      assert.deepEqual([...facts.existingDirs].sort(), ['dist', 'src'])

      // node_modules 里真的有 index.html（真实存在的包都带），不排掉就会
      // 造出一条与本项目无关的 static 证据
      await writeSource(dir, { 'node_modules/left-pad/index.html': 'module' })
      assert.deepEqual(collectProjectFacts(dir).entries, ['assets/app.js', 'index.html'])
    })
  })

  it('条目的路径分隔符统一成正斜杠，探测因此与平台无关', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/a/b/c.js': 'x' })
      const { entries } = collectProjectFacts(dir)
      assert.deepEqual(entries, ['a/b/c.js'])
      for (const e of entries) assert.ok(!e.includes('\\'), `条目里出现了反斜杠：${e}`)
    })
  })

  it('package.json 读出 scripts 键名', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/index.html': 'x' })
      await fs.writeFile(
        join(dir, 'package.json'),
        JSON.stringify({ name: 'p', scripts: { build: 'vite build', deploy: './do.sh' } }),
        'utf8',
      )
      assert.deepEqual(collectProjectFacts(dir).packageScripts, ['build', 'deploy'])
    })
  })

  it('没有 package.json 时 scripts 为空数组，不报错', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/index.html': 'x' })
      assert.deepEqual(collectProjectFacts(dir).packageScripts, [])
    })
  })

  it('package.json 坏 JSON 报错，并说清能做什么（code + path + hint）', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/index.html': 'x' })
      await fs.writeFile(join(dir, 'package.json'), '{ "scripts": { "build": }', 'utf8')
      const err = caught(() => collectProjectFacts(dir))
      assert.equal(err.code, 'DP.CONFIG.INVALID')
      assert.ok(err.path?.endsWith('package.json#scripts'), `path 不对：${err.path}`)
      // 下一条路必须写出来：不然用户不知道修好还是删掉
      assert.match(err.hint ?? '', /target\.type/)
    })
  })

  it('源条目超过上限时报错而不是静默截断', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/.keep': '' })
      await writeManyFiles(join(dir, 'dist'), 2001)
      const err = caught(() => collectProjectFacts(dir))
      assert.equal(err.code, 'DP.CONFIG.INVALID')
      assert.match(err.message, /2000/)
      assert.ok(err.path?.includes('source'), `path 不对：${err.path}`)
      assert.match(err.hint ?? '', /include|exclude/)
    })
  })

  it('源根一个都不在时 entries 为空 —— 报错由 deriveZeroConfig 出（同一张候选表）', async () => {
    await withProject(async (dir) => {
      await fs.writeFile(join(dir, 'index.html'), 'x', 'utf8')
      const facts = collectProjectFacts(dir)
      assert.deepEqual(facts.entries, [])
      assert.equal(facts.projectName, (await import('node:path')).basename(dir))
    })
  })

  it('项目名 = cwd 的 basename', async () => {
    await withProject(async (dir) => {
      const named = join(dir, 'my-site')
      await fs.mkdir(named)
      assert.equal(collectProjectFacts(named).projectName, 'my-site')
    })
  })

  it('路径里推不出项目名时报错，不拿空串当名字', () => {
    // 「basename 为空」是平台相关的：`C:\` 只在 Windows 上推不出名字，POSIX 上它就是
    // 一个普通的相对目录名（basename 是 `C:\` 本身），那里会先撞上 scandir 的 ENOENT ——
    // 那是「目录不存在」，不是这条要验的「推不出名字」。写死四个路径会让这条用例在
    // Linux runner 上恒红，而红的原因与它想守的行为无关。所以按当前平台实测筛一遍。
    const noName = ['C:\\', 'C:/', '/', '//'].filter((p) => basename(p) === '')
    // 万一哪天这个平台上一个都筛不出来，这条用例就变成空跑了 —— 那是比失败更难发现的事
    assert.ok(noName.length > 0, '当前平台上没有 basename 为空的路径，这条用例白跑了')
    for (const p of noName) {
      const err = caught(() => collectProjectFacts(p))
      assert.equal(err.code, 'DP.CONFIG.INVALID', `path=${p}`)
      assert.ok(err.hint !== undefined && err.hint.length > 0, `path=${p} 缺 hint`)
    }
  })
})

// ============================================================
// 命令契约
// ============================================================

/**
 * 发布根必须落在临时目录里，否则「默认不落盘」这条断言会去动真实的 /srv。
 *
 * `canWrite` 的键要**逐字等于**展开后的候选路径 —— 探测查 `canWrite[<path>]`
 * 而候选表是按 homedir / LOCALAPPDATA 展开的。这里把 user 布局下各平台会展开
 * 出来的形态都列上，而不是只写一个：多写的键不会被查（不可写的候选照样被跳过），
 * 少写则全部落空，报出来的错是「没有可写的发布目录」而不是真实原因。
 */
const FAKE_PLATFORM: Platform = process.platform === 'win32' ? 'win32' : 'linux'

function fakeDeps(dir: string, extraWritable: readonly string[] = []): ApplyDeps {
  const facts = fakeFacts(dir, extraWritable)
  return {
    ...defaultApplyDeps(),
    // 只桩 facts：runner 仍由 local runner 真写盘，那正是「有没有落盘」要验的东西
    acquireFacts: async () => ({ facts, probeNotes: [], close: async () => {} }),
  }
}

/**
 * canWrite 的键**必须**由 `releaseRootCandidates` 生成 —— 它就是 acquireFacts 实际
 * 展开并去探测的那批路径，一个字都不多。
 *
 * 手写 `join(homedir, 'apps', name)` 只在 POSIX 上碰巧相等：候选表走 `expandTemplate`，
 * 它按字面量拼字符串，于是 Windows 上产出的是 `~\dp-x`（正斜杠），与 `join` 的
 * `C:\...\home\dp-x` 逐字不同。键对不上 → `pickReleaseRoot` 一个候选都命中不了 →
 * 报「没有可写的发布目录」。那个错看着像实现坏了，其实只是夹具撒了个谎：
 * 真机上这批键正是 acquireFacts 亲手探测出来的。
 */
function fakeFacts(dir: string, extraWritable: readonly string[] = []): Facts {
  const homedir = join(dir, 'home')
  const name = basenameOf(dir)
  const writable: Record<string, boolean> = {}
  for (const p of [
    ...releaseRootCandidates(name, homedir, {}, FAKE_PLATFORM),
    ...extraWritable,
  ]) {
    writable[p] = true
  }

  return {
    host: 'local',
    platform: FAKE_PLATFORM,
    arch: 'x64',
    init: 'none',
    homedir,
    tmpdir: join(dir, 'tmp'),
    env: {},
    capabilities: {
      canWrite: writable,
      canChown: [],
      canSymlink: false,
      systemdScope: 'none',
      lingerEnabled: false,
      canBindPrivilegedPort: false,
      sudoAllowlist: [],
    },
    tools: {},
  }
}

/**
 * 这份夹具下 dp 会选中的发布根。
 *
 * 断言必须问生产用的那个函数要答案，而不是在这里重写一遍候选表：候选按 platform
 * 分组，写死 `home/apps/<name>` 等于把断言绑死在 linux 上 —— 而候选表在 Windows
 * 上选的是 `~/<name>`。
 */
function releaseRootOf(dir: string): string {
  const facts = fakeFacts(dir)
  return pickReleaseRoot({ facts, layout: deriveLayout(facts), name: basenameOf(dir) }).root
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]+/).filter((s) => s.length > 0)
  return parts[parts.length - 1] ?? ''
}

interface Run {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** 直接调命令：不起子进程，于是 stdout/stderr 能逐字断言 */
async function runDeployIn(
  dir: string,
  flags: Partial<DeployFlags> = {},
  deps: ApplyDeps = fakeDeps(dir),
): Promise<Run> {
  const out: string[] = []
  const err: string[] = []
  const full: DeployFlags = {
    all: false,
    json: false,
    dryRun: false,
    verbose: false,
    quiet: false,
    help: false,
    version: false,
    ...flags,
  }
  const context = createContext(full, {
    cwd: dir,
    env: {},
    write: (t) => out.push(t),
    writeErr: (t) => err.push(t),
    isTTY: false,
    deps,
  })
  const code = await runDeploy(context, full)
  return { code, stdout: out.join(''), stderr: err.join('') }
}

function releasesExist(dir: string): boolean {
  return existsSync(releaseRootOf(dir))
}

describe('dp deploy · 命令契约', () => {
  it('有配置文件 → 走 apply，零配置的 note 一条都不打印', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/index.html': '<h1>v1</h1>' })
      await fs.writeFile(
        join(dir, 'deploy.config.json'),
        JSON.stringify({
          hosts: { local: { local: true } },
          projects: { web: { source: { root: './dist' }, release: { root: join(dir, 'out') } } },
        }),
        'utf8',
      )

      const run = await runDeployIn(dir, {}, fakeDeps(dir, [join(dir, 'out')]))
      assert.equal(run.code, EXIT_OK, run.stderr)
      // 配置文件存在 → 零配置不介入：项目名是 dist 的目录名而不是 web，
      // 那些「源根：…」「主机：…」的 note 若出现就说明零配置抢跑了
      assert.ok(!run.stdout.includes('自动决定：'), `零配置 note 泄漏到 apply 路径：\n${run.stdout}`)
      assert.match(run.stdout, /web/)
    })
  })

  it('无配置文件 → 逐条打印 note，且默认不落盘', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/index.html': '<h1>v1</h1>', 'dist/assets/app.js': 'x' })
      const run = await runDeployIn(dir)
      assert.equal(run.code, EXIT_OK, run.stderr)
      // 「自动不等于静默」：每一步为什么这么定都要说清
      assert.match(run.stdout, /自动决定：/)
      assert.match(run.stdout, /源根：cwd 下存在 dist/)
      assert.match(run.stdout, /主机：零配置只造一个本机主机/)
      assert.match(run.stdout, /内存里/)
      // 干跑：目录必须一个都没建出来
      assert.equal(releasesExist(dir), false, '零配置默认干跑却落了盘')
      assert.equal(existsSync(join(dir, 'home')), false, '零配置默认干跑却建了发布根')
    })
  })

  it('无配置文件 + --yes → 真的执行，release 目录出现', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/index.html': '<h1>v1</h1>' })
      const run = await runDeployIn(dir, { yes: true })
      assert.equal(run.code, EXIT_OK, run.stderr)
      const root = releaseRootOf(dir)
      assert.equal(releasesExist(dir), true, '--yes 之后发布根仍然没出现')
      const releases = readdirSync(join(root, 'releases'))
      assert.equal(releases.length, 1)
      assert.ok(existsSync(join(root, 'current')))
    })
  })

  it('探测到 nginx → 退出码非 0，错误指向 target.nginx', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/index.html': 'x', 'dist/nginx.conf': 'server {}' })
      const err = await caughtAsync(runDeployIn(dir))
      // 零配置不造 server 块：凭空生成一份就是编造用户的意图
      assert.equal(err.code, 'DP.CONFIG.INVALID')
      assert.ok(err.path?.includes('target.nginx'), `path 不含 target.nginx：${err.path}`)
      assert.match(err.hint ?? '', /server/)
    })
  })

  it('--json 时 stdout 只有 JSON，note 走 stderr', async () => {
    await withProject(async (dir) => {
      await writeSource(dir, { 'dist/index.html': '<h1>v1</h1>' })
      const run = await runDeployIn(dir, { json: true })
      assert.equal(run.code, EXIT_OK, run.stderr)
      // 唯一硬约束：stdout 必须能被 JSON.parse 整段吃下
      const parsed = JSON.parse(run.stdout) as { command?: string; dryRun?: boolean }
      assert.equal(parsed.command, 'apply')
      assert.equal(parsed.dryRun, true)
      assert.ok(!run.stdout.includes('源根：cwd 下存在'), '人话混进了 --json 的 stdout')
      assert.match(run.stderr, /源根：cwd 下存在 dist/)
    })
  })

  it('零配置装配失败时 --json 的 stdout 仍是合法 JSON（错误走 stderr）', async () => {
    await withProject(async (dir) => {
      // 一个源根候选都没有：deriveZeroConfig 抛的是 DP.CONFIG.INVALID，
      // 它在 apply 之前发生，所以只调 runDeploy 拿不到结果文档 —— 走 main()
      // 才能验「失败时 stdout 仍然可被 JSON.parse 吃下」这条契约
      await fs.writeFile(join(dir, 'index.html'), 'x', 'utf8')
      const out: string[] = []
      const err: string[] = []
      const code = await main(['deploy', '--json'], {
        cwd: dir,
        env: {},
        write: (t) => out.push(t),
        writeErr: (t) => err.push(t),
        isTTY: false,
        deps: fakeDeps(dir),
      })
      assert.equal(code, EXIT_CONFIG)
      const stdout = out.join('')
      // 零配置装配失败时 stdout 是空的：没有结果文档可打，但**不能**是半截 JSON
      assert.equal(stdout.trim(), '', `失败时 stdout 混进了非 JSON 内容：${stdout}`)
      assert.match(err.join(''), /DP\.CONFIG\.INVALID/)
    })
  })

  it('零配置装配失败原样抛出：不包一层、不降级', async () => {
    await withProject(async (dir) => {
      // 一个源根候选都没有 → 源根报错
      await fs.writeFile(join(dir, 'index.html'), 'x', 'utf8')
      const err = await caughtAsync(runDeployIn(dir))
      assert.equal(err.code, 'DP.CONFIG.INVALID')
      assert.ok(err.path?.includes('source.root'), `path 不对：${err.path}`)
      assert.equal(err.name, 'DpError', '错误被包成了别的类型')
      assert.equal(exitCodeOf(err), EXIT_CONFIG)
    })
  })
})

function exitCodeOf(err: unknown): number {
  return err instanceof DpError ? (err.code === 'DP.CONFIG.INVALID' ? EXIT_CONFIG : 1) : 1
}
