import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ERR, DpError } from '@dp/ports'
import { analyzeVerifyArgv, enableArgv, systemctlArgv, systemdTarget, unitPaths } from './target.js'
import type { SystemdTargetConfig } from './types.js'

function makeConfig(over: Partial<SystemdTargetConfig> = {}): SystemdTargetConfig {
  return {
    unitDir: '/etc/systemd/system',
    execStart: '/srv/app/current/start.sh',
    render: { project: 'api', env: 'prod', release: { current: '/srv/app/current' } },
    ...over,
  }
}

function makeCtx() {
  return { host: 'fake', root: '/srv/app', releaseId: 'r2', keep: 3 }
}

describe('systemd target · plan', () => {
  it('四个阶段都有步骤，每步都带 undo（无副作用也要写清为什么不用补偿）', () => {
    const ctx = makeCtx()
    const config = makeConfig()
    for (const plan of [
      systemdTarget.planInstall(ctx, config),
      systemdTarget.planActivate(ctx, config),
      systemdTarget.planVerify(ctx, config),
      systemdTarget.planRollback(ctx, { ...config }),
    ]) {
      assert.ok(plan.length > 0)
      for (const step of plan) assert.ok((step.undo ?? '').length > 0, step.id)
    }
  })

  it('install 只碰影子目录，不含 daemon-reload / restart', () => {
    const plan = systemdTarget.planInstall(makeCtx(), makeConfig())
    const kinds = new Set(plan.map((s) => s.kind))
    assert.ok(kinds.has('prepare') && kinds.has('install'))
    assert.equal(kinds.has('activate'), false)
  })

  it('activate 顺序是 备份 → 替换 → daemon-reload → enable → restart', () => {
    const plan = systemdTarget.planActivate(makeCtx(), makeConfig())
    assert.deepEqual(plan.map((s) => s.id), [
      'systemd.backup',
      'systemd.replace',
      'systemd.daemon-reload',
      'systemd.enable',
      'systemd.restart',
    ])
  })

  it('enabled: false 时计划里就没有 enable 这一步（执行器也据此跳过）', () => {
    const plan = systemdTarget.planActivate(makeCtx(), makeConfig({ enabled: false }))
    assert.ok(!plan.some((s) => s.id === 'systemd.enable'))
    // 缺的不是「少了什么」而是「restart 仍然在」：关掉自启不能顺手把服务也关掉
    assert.ok(plan.some((s) => s.id === 'systemd.restart'))
  })

  it('enable 的 argv 带 unit 名，user scope 时 --user 在子命令之前', () => {
    const paths = unitPaths(makeCtx(), makeConfig())
    assert.deepEqual(enableArgv(paths), ['systemctl', 'enable', 'api.service'])
    assert.deepEqual(enableArgv(unitPaths(makeCtx(), makeConfig({ scope: 'user' }))), [
      'systemctl',
      '--user',
      'enable',
      'api.service',
    ])
  })

  it('system scope 时 systemctl 不带 --user', () => {
    const paths = unitPaths(makeCtx(), makeConfig())
    assert.deepEqual(systemctlArgv(paths, 'is-active', paths.unitName), [
      'systemctl',
      'is-active',
      'api.service',
    ])
  })

  it('user scope 时 --user 排在子命令之前（systemctl 的全局选项位置）', () => {
    const paths = unitPaths(makeCtx(), makeConfig({ scope: 'user' }))
    assert.deepEqual(systemctlArgv(paths, 'is-active', paths.unitName), [
      'systemctl',
      '--user',
      'is-active',
      'api.service',
    ])
    assert.deepEqual(analyzeVerifyArgv(paths, '/tmp/x/api.service'), [
      'systemd-analyze',
      '--user',
      'verify',
      '/tmp/x/api.service',
    ])
  })
})

describe('systemd target · unit 名推导', () => {
  it('省略时用 `<项目名>.service`', () => {
    assert.equal(unitPaths(makeCtx(), makeConfig()).unitName, 'api.service')
  })

  it('显式给了就用它', () => {
    assert.equal(unitPaths(makeCtx(), makeConfig({ unit: 'web.service' })).unitName, 'web.service')
  })

  it('模板里的变量会先展开', () => {
    assert.equal(
      unitPaths(makeCtx(), makeConfig({ unit: '${project}-${env}.service' })).unitName,
      'api-prod.service',
    )
  })

  it('带路径分隔符 → DP.SYSD.UNIT_INVALID（那能写到 unitDir 之外）', () => {
    assert.throws(
      () => unitPaths(makeCtx(), makeConfig({ unit: '../evil.service' })),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.SYSD.UNIT_INVALID)
        assert.equal(err.path, 'projects.*.target.systemd.unit')
        return true
      },
    )
  })

  it('不是 `.service` 结尾 → 拒绝（本包只管 service unit）', () => {
    assert.throws(
      () => unitPaths(makeCtx(), makeConfig({ unit: 'api.timer' })),
      (err: unknown) => err instanceof DpError && err.code === ERR.SYSD.UNIT_INVALID,
    )
  })

  it('unitDir 是相对路径 → 拒绝（会随工作目录漂移）', () => {
    assert.throws(
      () => unitPaths(makeCtx(), makeConfig({ unitDir: 'etc/systemd/system' })),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, ERR.SYSD.UNIT_INVALID)
        assert.equal(err.path, 'projects.*.target.systemd.unitDir')
        return true
      },
    )
  })
})
