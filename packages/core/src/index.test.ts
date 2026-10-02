import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DpError, type Facts, type Platform } from '@dp/ports'
import { defineProject } from '@dp/schema'
import {
  checkSourcePaths,
  deriveLayout,
  expandTemplate,
  makePlan,
  pickReleaseRoot,
} from './index.js'

// ------------------------------------------------------------
// Facts 夹具：注入，不含任何 IO
// ------------------------------------------------------------

function makeFacts(over: {
  platform?: Platform
  canWrite?: Readonly<Record<string, boolean>>
  sudoAllowlist?: readonly string[]
  homedir?: string
}): Facts {
  return {
    host: 'test-host',
    platform: over.platform ?? 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: over.homedir ?? '/home/deploy',
    tmpdir: '/tmp',
    env: {},
    capabilities: {
      canWrite: over.canWrite ?? {},
      canChown: [],
      canSymlink: true,
      systemdScope: 'none',
      lingerEnabled: false,
      canBindPrivilegedPort: false,
      sudoAllowlist: over.sudoAllowlist ?? [],
    },
    tools: {},
  }
}

// ------------------------------------------------------------
// 模板展开
// ------------------------------------------------------------

test('expandTemplate: 展开 home 与 <name>', () => {
  assert.equal(
    expandTemplate('~/apps/<name>', { name: 'web', homedir: '/home/deploy', env: {} }),
    '/home/deploy/apps/web',
  )
})

test('expandTemplate: XDG 未设置时回落到 ~/.local', () => {
  assert.equal(
    expandTemplate('$XDG_DATA_HOME/<name>', { name: 'web', homedir: '/home/deploy', env: {} }),
    '/home/deploy/.local/share/web',
  )
  assert.equal(
    expandTemplate('$XDG_DATA_HOME/<name>', {
      name: 'web',
      homedir: '/home/deploy',
      env: { XDG_DATA_HOME: '/data' },
    }),
    '/data/web',
  )
})

test('expandTemplate: Windows 变量', () => {
  assert.equal(
    expandTemplate('%LOCALAPPDATA%/<name>', {
      name: 'web',
      homedir: 'C:/Users/deploy',
      env: {},
    }),
    'C:/Users/deploy/AppData/Local/web',
  )
  assert.equal(
    expandTemplate('%ProgramFiles%/<name>', { name: 'web', homedir: 'C:/Users/deploy', env: {} }),
    'C:/Program Files/web',
  )
})

// ------------------------------------------------------------
// 布局推导
// ------------------------------------------------------------

test('deriveLayout: 系统目录可写 → system', () => {
  assert.equal(deriveLayout(makeFacts({ canWrite: { '/var/lib': true } })), 'system')
})

test('deriveLayout: 有 sudo 白名单 → hybrid', () => {
  assert.equal(deriveLayout(makeFacts({ sudoAllowlist: ['systemctl daemon-reload'] })), 'hybrid')
})

test('deriveLayout: 什么都没有 → user（不假设 root）', () => {
  assert.equal(deriveLayout(makeFacts({})), 'user')
})

// ------------------------------------------------------------
// 发布目录推导
// ------------------------------------------------------------

test('pickReleaseRoot: 取候选序列中首个可写者，并记录跳过原因', () => {
  const choice = pickReleaseRoot({
    facts: makeFacts({ platform: 'linux', canWrite: { '/opt/web': true } }),
    layout: 'system',
    name: 'web',
  })
  assert.equal(choice.root, '/opt/web')
  assert.equal(choice.explicit, false)
  assert.equal(choice.candidates.length, 3)
  assert.equal(choice.candidates[0]?.writable, false)
  assert.match(choice.candidates[0]?.reason ?? '', /不可写/)
})

test('pickReleaseRoot: user 布局落在 home 下', () => {
  const choice = pickReleaseRoot({
    facts: makeFacts({ platform: 'linux', canWrite: { '/home/deploy/apps/web': true } }),
    layout: 'user',
    name: 'web',
  })
  assert.equal(choice.root, '/home/deploy/apps/web')
})

test('pickReleaseRoot: 显式 root 优先，但仍要实证', () => {
  assert.equal(
    pickReleaseRoot({
      facts: makeFacts({ canWrite: { '/custom': true } }),
      layout: 'user',
      name: 'web',
      explicitRoot: '/custom',
    }).root,
    '/custom',
  )

  assert.throws(
    () =>
      pickReleaseRoot({
        facts: makeFacts({}),
        layout: 'user',
        name: 'web',
        explicitRoot: '/custom',
      }),
    (e: unknown) => e instanceof DpError && e.code === 'DP.PATH.NOT_WRITABLE',
  )
})

test('pickReleaseRoot: 全部不可写 → 报错且 hint 列出候选', () => {
  try {
    pickReleaseRoot({ facts: makeFacts({ platform: 'linux' }), layout: 'system', name: 'web' })
    assert.fail('应当抛错')
  } catch (e) {
    assert.ok(e instanceof DpError)
    assert.equal(e.code, 'DP.PATH.NOT_WRITABLE')
    assert.match(e.hint ?? '', /\/srv\/web/)
  }
})

// ------------------------------------------------------------
// 跨平台路径校验（本机即可查）
// ------------------------------------------------------------

test('checkSourcePaths: Windows 保留名', () => {
  assert.throws(
    () => checkSourcePaths(['dist/NUL'], 'win32'),
    (e: unknown) => e instanceof DpError && e.code === 'DP.PATH.RESERVED_NAME',
  )
  assert.throws(
    () => checkSourcePaths(['dist/aux.txt'], 'win32'),
    (e: unknown) => e instanceof DpError && e.code === 'DP.PATH.RESERVED_NAME',
  )
  // 同样的名字在 linux 上完全合法
  checkSourcePaths(['dist/NUL'], 'linux')
})

test('checkSourcePaths: 仅大小写不同 → 不敏感平台上冲突', () => {
  assert.throws(
    () => checkSourcePaths(['a.js', 'A.js'], 'win32'),
    (e: unknown) => e instanceof DpError && e.code === 'DP.PATH.CASE_COLLISION',
  )
  assert.throws(
    () => checkSourcePaths(['a.js', 'A.js'], 'darwin'),
    (e: unknown) => e instanceof DpError && e.code === 'DP.PATH.CASE_COLLISION',
  )
  // linux 大小写敏感，不冲突
  checkSourcePaths(['a.js', 'A.js'], 'linux')
})

test('checkSourcePaths: 非法字符与长度', () => {
  assert.throws(
    () => checkSourcePaths(['dist/a|b.js'], 'win32'),
    (e: unknown) => e instanceof DpError && e.code === 'DP.PATH.ILLEGAL_CHAR',
  )
  assert.throws(
    () => checkSourcePaths([`dist/${'x'.repeat(300)}.js`], 'win32'),
    (e: unknown) => e instanceof DpError && e.code === 'DP.PATH.TOO_LONG',
  )
})

// ------------------------------------------------------------
// plan
// ------------------------------------------------------------

test('makePlan: 纯函数产出完整计划', () => {
  const plan = makePlan({
    name: 'web',
    project: defineProject({ source: { root: './dist' } }),
    facts: makeFacts({ platform: 'linux', canWrite: { '/var/lib': true, '/srv/web': true } }),
    releaseId: 'r-abc123',
    sourceEntries: ['index.html', 'assets/app.js'],
  })

  assert.equal(plan.layout, 'system')
  assert.equal(plan.releaseRoot, '/srv/web')
  assert.deepEqual(
    plan.steps.map((s) => s.id),
    ['prepare', 'stage', 'transfer', 'install', 'activate', 'verify', 'promote', 'prune'],
  )
  assert.ok(plan.steps.find((s) => s.id === 'activate')?.undo, 'activate 必须有补偿动作')
})

test('makePlan: 无 healthcheck 时告警 autoPromote 退化', () => {
  const plan = makePlan({
    name: 'web',
    project: defineProject({ source: { root: './dist' }, activation: { mode: 'trial-promote' } }),
    facts: makeFacts({ platform: 'linux', canWrite: { '/var/lib': true, '/srv/web': true } }),
    releaseId: 'r-1',
    sourceEntries: ['index.html'],
  })
  assert.ok(plan.warnings.some((w) => w.includes('DP.VERIFY.NO_HEALTHCHECK')))
})

test('makePlan: 源里有保留名时在计划阶段就失败（零副作用）', () => {
  assert.throws(
    () =>
      makePlan({
        name: 'web',
        project: defineProject({ source: { root: './dist' } }),
        facts: makeFacts({ platform: 'win32', canWrite: { 'C:/ProgramData/web': true } }),
        releaseId: 'r-1',
        sourceEntries: ['CON'],
      }),
    (e: unknown) => e instanceof DpError && e.code === 'DP.PATH.RESERVED_NAME',
  )
})
