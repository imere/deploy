/**
 * 能力缺口告警。
 *
 * 告警与错误是两种出口：能力缺口（如未开 linger）不阻断部署，只提前告知。
 * 判据不成立（0 命中、并列）才抛错 —— 把两者混在一起会让「换个终端登录再试」
 * 这种可自己处理的事变成一次失败部署。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Facts } from '@dp/ports'
import { defineProject } from '@dp/schema'
import { makePlan } from './index.js'

function factsWith(over: { systemdScope?: 'none' | 'system' | 'user'; lingerEnabled?: boolean }): Facts {
  return {
    host: 'test-host',
    platform: 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: '/home/deploy',
    tmpdir: '/tmp',
    env: {},
    capabilities: {
      canWrite: { '/srv/web': true, '/home/deploy/apps/web': true, '/home/deploy/.local/share/web': true },
      canChown: [],
      canSymlink: true,
      systemdScope: over.systemdScope ?? 'none',
      lingerEnabled: over.lingerEnabled ?? false,
      canBindPrivilegedPort: false,
      sudoAllowlist: [],
    },
    tools: {},
  }
}

const baseInput = {
  name: 'web',
  releaseId: 'r-abc123',
  sourceEntries: ['index.html'],
} as const

describe('makePlan · 能力缺口告警', () => {
  it('用户级服务未开 linger：告警但不阻断，计划照常产出', () => {
    const plan = makePlan({
      ...baseInput,
      project: defineProject({ source: { root: './dist' } }),
      facts: factsWith({ systemdScope: 'user', lingerEnabled: false }),
    })
    assert.deepEqual(plan.warnings, [
      'DP.SYSTEMD.NO_LINGER: 用户级服务未开启 linger，注销后不会存活',
    ])
    assert.equal(plan.steps.length > 0, true)
  })

  it('开了 linger 就不该再提：告警重复出现等于噪声', () => {
    const plan = makePlan({
      ...baseInput,
      project: defineProject({ source: { root: './dist' } }),
      facts: factsWith({ systemdScope: 'user', lingerEnabled: true }),
    })
    assert.deepEqual(plan.warnings, [])
  })

  it('system 级服务不受 linger 影响：判据必须带 systemdScope', () => {
    const plan = makePlan({
      ...baseInput,
      project: defineProject({ source: { root: './dist' } }),
      facts: factsWith({ systemdScope: 'system', lingerEnabled: false }),
    })
    assert.deepEqual(plan.warnings, [])
  })

  it('两阶段激活没有 healthcheck：autoPromote 退化为 never，要提前说清', () => {
    const plan = makePlan({
      ...baseInput,
      project: defineProject({ source: { root: './dist' }, activation: { mode: 'trial-promote' } }),
      facts: factsWith({}),
    })
    assert.deepEqual(plan.warnings, [
      'DP.VERIFY.NO_HEALTHCHECK: 没有 healthcheck，autoPromote 退化为 never',
    ])
  })

  it('配了 healthcheck 就不再告警', () => {
    const plan = makePlan({
      ...baseInput,
      project: defineProject({
        source: { root: './dist' },
        activation: { mode: 'trial-promote' },
        healthcheck: { http: { path: '/health' } },
      }),
      facts: factsWith({}),
    })
    assert.deepEqual(plan.warnings, [])
  })
})
