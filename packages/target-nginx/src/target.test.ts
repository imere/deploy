/**
 * Target 契约。
 *
 * 断言的是**顺序与补偿**，不是某几个字段的值：顺序错了会产出「先 reload 再校验」
 * 这种看起来能跑、实际把坏 conf 推上线的计划，而 Step 是纯数据，只能在测试里钉住。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError, type Step, type TargetContext } from '@dp/ports'
import { nginxTarget } from './target.js'
import type { NginxTargetConfig } from './types.js'

const CTX: TargetContext = { host: 'web-01', root: '/srv/web', releaseId: 'r-7f3a', keep: 5 }
const CTX_PREV: TargetContext = { ...CTX, previousReleaseId: 'r-2b1c' }

const CONFIG: NginxTargetConfig = {
  confd: '/etc/nginx/conf.d',
  render: { project: 'web', env: 'prod', release: { id: 'r-7f3a', current: '/srv/web/current' } },
  server: { serverName: ['web.example.com'], root: '${release.current}' },
}

function ids(steps: readonly Step[]): readonly string[] {
  return steps.map((s) => s.id)
}

function allSteps(ctx: TargetContext = CTX_PREV, config: NginxTargetConfig = CONFIG): readonly Step[] {
  return [
    ...nginxTarget.planInstall(ctx, config),
    ...nginxTarget.planActivate(ctx, config),
    ...nginxTarget.planVerify(ctx, config),
  ]
}

describe('nginxTarget', () => {
  it('type 是 nginx', () => {
    assert.equal(nginxTarget.type, 'nginx')
  })

  it('生效顺序：写候选 → shadow 校验 → 备份 → 原子替换 → 复验 → reload', () => {
    assert.deepEqual(ids(allSteps()), [
      'nginx.render',
      'nginx.write-candidate',
      'nginx.validate-shadow',
      'nginx.backup',
      'nginx.replace',
      'nginx.validate-live',
      'nginx.reload',
      'nginx.verify-conf',
    ])
  })

  it('两步 -t 都在 argv 里，且候选校验走 -c <临时主配置>', () => {
    const install = nginxTarget.planInstall(CTX, CONFIG)
    const shadow = install.find((s) => s.id === 'nginx.validate-shadow')!
    const live = nginxTarget.planActivate(CTX, CONFIG).find((s) => s.id === 'nginx.validate-live')!
    assert.deepEqual(shadow.detail?.['argv'], ['nginx', '-t', '-c', '/etc/nginx/conf.d/.dp-shadow/r-7f3a/nginx.shadow.conf'])
    assert.deepEqual(live.detail?.['argv'], ['nginx', '-t'])
  })

  it('候选路径在影子目录里，不在 confd 顶层（写上去就还没生效，等于没验）', () => {
    const install = nginxTarget.planInstall(CTX, CONFIG)
    const candidate = install.find((s) => s.id === 'nginx.write-candidate')!.detail!['candidate'] as string
    assert.equal(candidate, '/etc/nginx/conf.d/.dp-shadow/r-7f3a/web.conf')
    assert.equal(candidate.startsWith('/etc/nginx/conf.d/web.conf'), false)
  })

  it('shadow 校验显式排除旧文件：候选与旧文件同时被 include 会撞出 conflicting server name', () => {
    const step = nginxTarget.planInstall(CTX, CONFIG).find((s) => s.id === 'nginx.validate-shadow')!
    assert.equal(step.detail?.['exclude'], '/etc/nginx/conf.d/web.conf')
  })

  it('文件名默认取项目名，可被覆盖', () => {
    const install = nginxTarget.planInstall(CTX, CONFIG)
    assert.equal(install[0]?.detail?.['file'], '/etc/nginx/conf.d/web.conf')
    const named = nginxTarget.planInstall(CTX, { ...CONFIG, filename: 'site.conf' })
    assert.equal(named[0]?.detail?.['file'], '/etc/nginx/conf.d/site.conf')
  })

  it('filename 支持变量 —— 默认值是 `<项目名>.conf`，照着写必须得到同一个文件', () => {
    // 不渲染的话，用户照默认值的写法显式写一遍就会得到另一个文件名：
    // 旧的那个从此不再更新，而且没有任何报错提示这件事发生过。
    const named = nginxTarget.planInstall(CTX, { ...CONFIG, filename: '${project}.conf' })
    assert.equal(named[0]?.detail?.['file'], '/etc/nginx/conf.d/web.conf')
    const byEnv = nginxTarget.planInstall(CTX, { ...CONFIG, filename: '${project}-${env}.conf' })
    assert.equal(byEnv[0]?.detail?.['file'], '/etc/nginx/conf.d/web-prod.conf')
  })

  it('filename 渲染出来的路径分隔符同样被拒', () => {
    assert.throws(
      () => nginxTarget.planInstall(CTX, {
        ...CONFIG,
        filename: '${env}/evil.conf',
        render: { ...CONFIG.render, env: 'a/b' },
      }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
    )
  })

  it('filename 不接受路径：它只是 confd 里的一个名字', () => {
    for (const bad of ['../evil.conf', 'sub/site.conf', '..', '']) {
      assert.throws(
        () => nginxTarget.planInstall(CTX, { ...CONFIG, filename: bad }),
        (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
        `filename=${JSON.stringify(bad)} 必须被拒`,
      )
    }
  })

  it('每一步都有 undo：没有 undo 就等于没人说得清失败后怎么收场', () => {
    for (const step of allSteps()) {
      assert.ok((step.undo ?? '').trim() !== '', `${step.id} 缺 undo`)
    }
  })

  it('有副作用的步骤的 undo 必须指名道姓，不能只说"回滚"', () => {
    const replace = nginxTarget.planActivate(CTX, CONFIG).find((s) => s.id === 'nginx.replace')!
    assert.match(replace.undo ?? '', /dp-backup|删除/)
    const restore = nginxTarget.planRollback(CTX_PREV, CONFIG).find((s) => s.id === 'nginx.restore-backup')!
    assert.match(restore.undo ?? '', /planInstall/)
  })

  it('首次部署：replace 的 undo 说清「没有备份可还原」', () => {
    const replace = nginxTarget.planActivate(CTX, CONFIG).find((s) => s.id === 'nginx.replace')!
    assert.match(replace.undo ?? '', /首次部署/)
  })

  it('reload: false → 留一条明说的「没重载」，不静默省略（用户看不到就会以为 reload 过了）', () => {
    const step = nginxTarget.planActivate(CTX, { ...CONFIG, reload: false }).find((s) => s.id === 'nginx.reload')!
    assert.match(step.title, /已禁用/)
    assert.equal(step.detail, undefined)
    assert.equal(ids(nginxTarget.planRollback(CTX_PREV, { ...CONFIG, reload: false })).includes('nginx.reload-rollback'), false)
  })

  it('reload 可覆盖成 systemctl 形式，且始终是 argv[]', () => {
    const step = nginxTarget.planActivate(CTX, { ...CONFIG, reload: ['systemctl', 'reload', 'nginx'] }).find(
      (s) => s.id === 'nginx.reload',
    )!
    assert.deepEqual(step.detail?.['argv'], ['systemctl', 'reload', 'nginx'])
  })

  it('reload 含 shell 元字符 → 报 DP.NGX.RELOAD_CMD_INVALID，不照传', () => {
    for (const bad of [['nginx', '-s', 'reload; rm -rf /'], ['sh', '-c', 'nginx -s reload'], ['nginx', '-s', 'reload && reboot'], ['']]) {
      assert.throws(
        () => nginxTarget.planActivate(CTX, { ...CONFIG, reload: bad }),
        (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.RELOAD_CMD_INVALID',
        `reload=${JSON.stringify(bad)} 必须被拒`,
      )
    }
  })

  it('planRollback 还原 conf 而不是回退 release，并在 reload 前先复验', () => {
    const steps = nginxTarget.planRollback(CTX_PREV, CONFIG)
    assert.deepEqual(ids(steps), ['nginx.restore-backup', 'nginx.validate-rollback', 'nginx.reload-rollback'])
    assert.match(steps[0]!.title, /r-2b1c|上一份 conf/)
    assert.equal(steps[0]!.detail?.['from'], '/etc/nginx/conf.d/web.conf.dp-backup')
  })

  it('首次部署 planRollback 抛错，不返回「回滚成功」这种假结果', () => {
    try {
      nginxTarget.planRollback(CTX, CONFIG)
      throw new Error('期望抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.NGX.NO_PREVIOUS')
      assert.ok((err.hint ?? '') !== '')
    }
  })

  it('渲染出错在 plan 期就抛，不产出步骤（否则会拿着一份渲染失败的配置上机器）', () => {
    assert.throws(
      () => nginxTarget.planInstall(CTX, { ...CONFIG, server: { root: '/srv', locations: [{ path: 'api/', extra: ['return 204;'] }] } }),
      (e: unknown) => e instanceof DpError && e.code === 'DP.NGX.CONF_INVALID',
    )
  })

  it('计划里不出现待渲染的 ${x} 原文', () => {
    const out = JSON.stringify(allSteps())
    assert.equal(out.includes('${release.current}'), false)
  })
})
