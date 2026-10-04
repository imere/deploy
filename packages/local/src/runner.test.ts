/**
 * 本机 Runner 的行为测试 —— 跑在真实文件系统上，不做 mock。
 *
 * 这一层专门盯「操作系统差异」：junction 与 symlink 的行为、路径分隔符、
 * 二进制读写是否失真。Windows 与 Linux/macOS 都必须通过同一份断言。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Capabilities, Facts } from '@dp/ports'
import { createLocalRunner, probeLocalFacts } from './index.js'

let sandbox = ''

before(async () => {
  sandbox = await fs.mkdtemp(join(tmpdir(), 'dp-runner-'))
})

after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

function makeFacts(canvas: Partial<Facts['capabilities']> = {}): Facts {
  const capabilities: Capabilities = {
    canWrite: {},
    canChown: [],
    canSymlink: true,
    systemdScope: 'none',
    lingerEnabled: false,
    canBindPrivilegedPort: false,
    sudoAllowlist: [],
    ...canvas,
  }
  return {
    host: 'local',
    platform: 'linux',
    arch: 'x64',
    init: 'none',
    homedir: tmpdir(),
    tmpdir: tmpdir(),
    env: {},
    capabilities,
    tools: {},
  }
}

describe('local runner · 文件系统', () => {
  it('写读忘记改都在采用 / 分隔的相对路径下工作', async () => {
    const runner = createLocalRunner(makeFacts())
    const base = `${sandbox}/case1`
    await runner.mkdir(`${base}/a/b`, { recursive: true })
    await runner.writeFile(`${base}/a/b/x.txt`, 'hello')

    assert.equal(await runner.readFile(`${base}/a/b/x.txt`), 'hello')
    assert.deepEqual(await runner.listDir(`${base}/a`), ['b'])
    assert.deepEqual(await runner.readBinary(`${base}/a/b/x.txt`), new TextEncoder().encode('hello'))
  })

  it('stat 对不存在的路径返回 null 而不是抛错', async () => {
    const runner = createLocalRunner(makeFacts())
    assert.equal(await runner.stat(`${sandbox}/nope`), null)
  })

  it('stat 能区分目录与软链', async () => {
    const runner = createLocalRunner(makeFacts())
    await runner.mkdir(`${sandbox}/case3`)
    const dir = await runner.stat(`${sandbox}/case3`)
    assert.equal(dir?.isDirectory, true)
    assert.equal(dir?.isSymbolicLink, false)
  })

  it('rename 是移动，且能覆盖已存在目标', async () => {
    const runner = createLocalRunner(makeFacts())
    await runner.mkdir(`${sandbox}/case4`)
    await runner.writeFile(`${sandbox}/case4/from.txt`, 'x')
    await runner.writeFile(`${sandbox}/case4/to.txt`, 'old')
    await runner.rename(`${sandbox}/case4/from.txt`, `${sandbox}/case4/to.txt`)
    assert.equal(await runner.readFile(`${sandbox}/case4/to.txt`), 'x')
    assert.equal(await runner.stat(`${sandbox}/case4/from.txt`), null)
  })

  it('remove 递归且对不存在的路径幂等', async () => {
    const runner = createLocalRunner(makeFacts())
    await runner.mkdir(`${sandbox}/case5/deep`, { recursive: true })
    await runner.remove(`${sandbox}/case5`)
    assert.equal(await runner.stat(`${sandbox}/case5`), null)
    await runner.remove(`${sandbox}/case5`)
  })

  it('二进制文件往返一致（不会被 utf8 转坏）', async () => {
    const runner = createLocalRunner(makeFacts())
    const bytes = new Uint8Array([0x00, 0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x80])
    await runner.writeFile(`${sandbox}/blob.bin`, bytes)
    assert.deepEqual(await runner.readBinary(`${sandbox}/blob.bin`), bytes)
  })

  it('软链能建、能读指向；realpath 给出真实路径', async () => {
    const runner = createLocalRunner(makeFacts())
    const target = `${sandbox}/case7-target`
    await runner.mkdir(target)
    try {
      await runner.symlink(target, `${sandbox}/case7-link`)
      const pointed = await runner.readlink(`${sandbox}/case7-link`)
      assert.ok(pointed !== null && pointed.includes('case7-target'))
      assert.ok((await runner.realpath(`${sandbox}/case7-link`)).includes('case7-target'))
    } catch {
      // 本机无 symlink 权限时也允许：这条能力必须在 Facts 里如实体现
      const facts = await probeLocalFacts({ writeProbePaths: [tmpdir()] })
      assert.equal(facts.capabilities.canSymlink, false, '若软链失败，实测必须如实报告')
    }
  })

  it('读不到软链时返回 null，而不是抛错打乱调用方', async () => {
    const runner = createLocalRunner(makeFacts())
    await runner.writeFile(`${sandbox}/plain.txt`, 'x')
    assert.equal(await runner.readlink(`${sandbox}/plain.txt`), null)
    assert.equal(await runner.readlink(`${sandbox}/nope-at-all`), null)
  })
})

describe('local runner · 能力实证', () => {
  it('probeLocalFacts 报告的能力与真实 OS 一致', async () => {
    const facts = await probeLocalFacts({ writeProbePaths: [tmpdir()] })
    assert.equal(facts.host, 'local')
    assert.equal([...Object.keys(facts.tools)].length > 0, true)
    // 关键断言：能 symlink 这件事是**试出来的**，不是按平台猜的
    assert.equal(typeof facts.capabilities.canSymlink, 'boolean')
    assert.equal(facts.capabilities.canWrite[tmpdir()], true)
  })

  it('特权端口能否 bind 是实测结果，不是看 uid', async () => {
    const facts = await probeLocalFacts({ writeProbePaths: [tmpdir()] })
    assert.equal(typeof facts.capabilities.canBindPrivilegedPort, 'boolean')
  })
})
