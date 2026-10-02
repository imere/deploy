/**
 * 真实端到端：本机文件系统上跑一次完整发布。
 *
 * 这一层不许用 mock —— 它的价值就在于校验 ls / readlink / rename / 路径分隔符
 * 在**真实操作系统**上的行为。Windows 上尤其重要：junction / 路径长度 /
 * 保留名都会在这里暴露。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capabilities, Facts, TargetContext } from '@dp/ports'
import { createLocalRunner, listSourceEntries, normalizeSourceSpec } from '@dp/local'
import { deploy, rollback } from './index.js'

let sourceRoot = ''
let deployRoot = ''
const cleanup: string[] = []

before(async () => {
  sourceRoot = await fs.mkdtemp(join(tmpdir(), 'dp-src-'))
  deployRoot = await fs.mkdtemp(join(tmpdir(), 'dp-app-'))
  cleanup.push(sourceRoot, deployRoot)

  await fs.mkdir(join(sourceRoot, 'dist', 'assets'), { recursive: true })
  await fs.writeFile(join(sourceRoot, 'dist', 'index.html'), '<html>v1</html>')
  await fs.writeFile(join(sourceRoot, 'dist', 'assets', 'app.js'), 'console.log(1)')
})

after(async () => {
  for (const dir of cleanup) await fs.rm(dir, { recursive: true, force: true })
})

function makeFacts(over: Partial<Facts> = {}): Facts {
  const capabilities: Capabilities = {
    canWrite: { '/srv': true },
    canChown: [],
    canSymlink: process.platform !== 'win32',
    systemdScope: 'none',
    lingerEnabled: false,
    canBindPrivilegedPort: false,
    sudoAllowlist: [],
  }
  return {
    host: 'local',
    platform: process.platform === 'win32' ? 'win32' : 'linux',
    arch: 'x64',
    init: 'none',
    homedir: tmpdir(),
    tmpdir: tmpdir(),
    env: {},
    capabilities,
    tools: {},
    ...over,
  }
}

function ctx(releaseId: string, previous?: string): TargetContext {
  return {
    host: 'local',
    root: deployRoot,
    releaseId,
    ...(previous !== undefined ? { previousReleaseId: previous } : {}),
    keep: 2,
  }
}

async function entries(pattern: string) {
  const spec = normalizeSourceSpec(pattern, sourceRoot)
  return listSourceEntries(spec)
}

describe('端到端 · 本机发布', () => {
  it('source "./dist" 连目录本身一起过去，"./dist/**" 只过去内容', async () => {
    const selfEntries = await entries('./dist')
    const contentEntries = await entries('./dist/**')

    assert.ok(selfEntries.some((e) => e.relativePath === 'dist/index.html'))
    assert.ok(contentEntries.some((e) => e.relativePath === 'index.html'))
    assert.ok(!contentEntries.some((e) => e.relativePath.startsWith('dist/')))
  })

  it('尾斜杠写法被明确拒绝，而不是猜一个默认含义', () => {
    assert.throws(() => normalizeSourceSpec('./dist/', sourceRoot), /不能以路径分隔符结尾/)
  })

  it('两次发布 + current 切换 + 回滚，全部落在真实磁盘上', async () => {
    const runner = createLocalRunner(makeFacts())

    const first = await deploy({
      runner,
      ctx: ctx('20261002-000000'),
      entries: await entries('./dist/**'),
      config: { healthcheck: { fileExists: ['index.html'] } },
    })
    assert.equal(first.filesWritten, 2)

    const currentAfterFirst = await fs.readFile(join(deployRoot, 'current', 'index.html'), 'utf8')
    assert.equal(currentAfterFirst, '<html>v1</html>')

    await fs.writeFile(join(sourceRoot, 'dist', 'index.html'), '<html>v2</html>')
    const second = await deploy({
      runner,
      ctx: ctx('20261002-000001', '20261002-000000'),
      entries: await entries('./dist/**'),
      config: { healthcheck: { fileExists: ['index.html'] } },
    })
    assert.equal(second.previousReleaseId, '20261002-000000')

    assert.equal(
      await fs.readFile(join(deployRoot, 'current', 'index.html'), 'utf8'),
      '<html>v2</html>',
    )
    assert.equal(
      await fs.readFile(join(deployRoot, 'releases', '20261002-000000', 'index.html'), 'utf8'),
      '<html>v1</html>',
      '旧版本必须原样留着，否则回滚无从谈起',
    )

    const back = await rollback(runner, ctx('20261002-000001', '20261002-000000'))
    assert.equal(back, '20261002-000000')
    assert.equal(
      await fs.readFile(join(deployRoot, 'current', 'index.html'), 'utf8'),
      '<html>v1</html>',
    )
  })

  it('staging 目录不会留在发布成功后', async () => {
    const names = await fs.readdir(join(deployRoot, 'releases'))
    assert.equal(
      names.filter((n) => n.endsWith('.incoming')).length,
      0,
      '.incoming 是 staging，提交后必须消失',
    )
  })

  it('索引记录了生效版本', async () => {
    const raw = await fs.readFile(join(deployRoot, '.dp', 'index.json'), 'utf8')
    const index = JSON.parse(raw) as { current?: string; releases: string[] }
    assert.equal(index.current, '20261002-000000')
    assert.ok(index.releases.length >= 1)
  })
})
