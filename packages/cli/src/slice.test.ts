/**
 * 纵向切片：配置 → plan → 真实本机部署。
 *
 * 前面各包的测试都只验自己这一层；这一份验的是**它们接起来还对不对**：
 * core 推导出的 releaseRoot，target-static 能不能真的用起来；
 * schema 里写的 release.keep，prune 认不认。
 *
 * 除了虚拟的 Facts 夹具，其余全是真实磁盘操作，不做 mock。
 *
 * 为什么放在 cli 而不是 core：这一份要同时用到 core 的推导、target-static 的执行、
 * local 的真实磁盘 —— 只有最上层同时依赖这三个包。放在 core 里等于让一个「零 IO
 * 纯编排」的包在自己的测试里做真实部署，而且那两个反向引用只有在本机靠 junction
 * 把 workspace 包全链进根 node_modules 时才解析得到；pnpm 的 isolated 布局
 * （Linux runner 上就是这个）只链接声明过的依赖，于是 tsc 直接报 TS2307。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Facts } from '@dp/ports'
import { defineConfig, defineHost, defineProject } from '@dp/schema'
import { createLocalRunner, listSourceEntries, normalizeSourceSpec } from '@dp/local'
import { deploy } from '@dp/target-static'
import { makePlan } from '@dp/core'

let sourceRoot = ''
/** plan 推导出的 releaseRoot 会落在这里（user 布局 → ~/apps/<name>） */
let rootBase = ''

before(async () => {
  sourceRoot = await fs.mkdtemp(join(tmpdir(), 'dp-slice-src-'))
  rootBase = await fs.mkdtemp(join(tmpdir(), 'dp-slice-root-'))
  await fs.mkdir(join(sourceRoot, 'dist', 'assets'), { recursive: true })
  await fs.writeFile(join(sourceRoot, 'dist', 'index.html'), '<html>slice</html>')
  await fs.writeFile(join(sourceRoot, 'dist', 'assets', 'app.js'), 'export {}')
})

after(async () => {
  await fs.rm(sourceRoot, { recursive: true, force: true })
  await fs.rm(rootBase, { recursive: true, force: true })
})

const webProject = defineProject({
  source: { root: './dist/**' },
  target: { type: 'static' },
  release: { keep: 2 },
  healthcheck: { fileExists: ['index.html'] },
})

const cfg = defineConfig({
  hosts: { local: defineHost({ local: true }) },
  projects: { web: webProject },
})

describe('纵向切片 · 配置到落盘', () => {
  /** plan 内部用 `/` 拼路径（目标端不一定是同一种文件系统），键必须同源。
   *  必须是函数：rootBase 在 before() 里才拿到值 */
  const rootKey = (): string => `${rootBase}/apps/web`

  it('plan 推导出的 root 可以真的被 static target 用起来', async () => {
    const facts: Facts = {
      host: 'local',
      platform: 'linux',
      arch: 'x64',
      init: 'none',
      homedir: rootBase,
      tmpdir: tmpdir(),
      env: {},
      capabilities: {
        canWrite: { [rootKey()]: true },
        canChown: [],
        canSymlink: true,
        systemdScope: 'none',
        lingerEnabled: false,
        canBindPrivilegedPort: false,
        sudoAllowlist: [],
      },
      tools: {},
    }

    const plan = makePlan({
      name: 'web',
      project: webProject,
      facts,
      releaseId: '20261002-120000',
      sourceEntries: ['index.html', 'assets/app.js'],
      // user 布局 → 候选是 ~/apps/<name>，正好落在临时夹具里，任何平台都可跑
      layout: 'user',
    })

    const expectedRoot = join(rootBase, 'apps', 'web')
    // 分隔符不重要（`\` 与 `/` 在 Node fs 上等价），关键是 *右这段路径* 没被推导错
    assert.equal(plan.releaseRoot.replace(/\\/g, '/'), expectedRoot.replace(/\\/g, '/'))
    assert.equal(plan.layout, 'user')
    assert.ok(plan.steps.some((s) => s.kind === 'transfer'))
    assert.ok(plan.steps.some((s) => s.kind === 'verify'))

    const runner = createLocalRunner(facts)
    const result = await deploy({
      runner,
      ctx: {
        host: 'local',
        root: plan.releaseRoot,
        releaseId: '20261002-120000',
        keep: webProject.release?.keep ?? 5,
      },
      entries: await listSourceEntries(normalizeSourceSpec('./dist/**', sourceRoot)),
      config: { healthcheck: { fileExists: webProject.healthcheck?.fileExists } },
    })

    assert.equal(result.filesWritten, 2)
    assert.equal(
      await fs.readFile(join(plan.releaseRoot, 'current', 'index.html'), 'utf8'),
      '<html>slice</html>',
    )
    assert.equal(
      await fs.readFile(join(plan.releaseRoot, 'releases', '20261002-120000', 'assets', 'app.js'), 'utf8'),
      'export {}',
    )
  })

  it('第二版发布后 current 指向新版本，且首付版本保留可供回退', async () => {
    const root = rootKey()
    const facts: Facts = {
      host: 'local',
      platform: 'linux',
      arch: 'x64',
      init: 'none',
      homedir: rootBase,
      tmpdir: tmpdir(),
      env: {},
      capabilities: {
        canWrite: { [root]: true },
        canChown: [],
        canSymlink: true,
        systemdScope: 'none',
        lingerEnabled: false,
        canBindPrivilegedPort: false,
        sudoAllowlist: [],
      },
      tools: {},
    }
    const runner = createLocalRunner(facts)

    await fs.writeFile(join(sourceRoot, 'dist', 'index.html'), '<html>v2</html>')
    const second = await deploy({
      runner,
      ctx: { host: 'local', root, releaseId: '20261002-130000', previousReleaseId: '20261002-120000', keep: 2 },
      entries: await listSourceEntries(normalizeSourceSpec('./dist/**', sourceRoot)),
      config: { healthcheck: { fileExists: ['index.html'] } },
    })

    assert.equal(second.previousReleaseId, '20261002-120000')
    assert.equal(await fs.readFile(join(root, 'current', 'index.html'), 'utf8'), '<html>v2</html>')
    assert.equal(
      await fs.readFile(join(root, 'releases', '20261002-120000', 'index.html'), 'utf8'),
      '<html>slice</html>',
    )
  })
})
