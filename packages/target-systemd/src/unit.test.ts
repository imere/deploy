import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { MANAGED_MARKER, isManaged, renderUnit } from './unit.js'
import type { SystemdTargetConfig } from './types.js'

function makeConfig(over: Partial<SystemdTargetConfig> = {}): SystemdTargetConfig {
  return {
    unitDir: '/etc/systemd/system',
    execStart: '/srv/app/current/start.sh',
    render: { project: 'api', env: 'prod' },
    ...over,
  }
}

function render(config: SystemdTargetConfig, unitName = 'api.service'): string {
  return renderUnit({ config, unitName, releaseId: 'r1', path: 'projects.*.target.systemd' })
}

describe('systemd unit 渲染', () => {
  it('最小配置产出可加载的 service unit', () => {
    const text = render(makeConfig())
    assert.equal(
      text,
      [
        MANAGED_MARKER,
        '[Unit]',
        'Description=api',
        '',
        '[Service]',
        'Type=simple',
        'ExecStart=/srv/app/current/start.sh',
        'Restart=on-failure',
        '',
        '[Install]',
        'WantedBy=multi-user.target',
        '',
      ].join('\n'),
    )
  })

  it('给了的字段按固定顺序逐条输出；没给的一律不输出（不留空指令）', () => {
    const text = render(
      makeConfig({
        description: 'api server',
        after: ['network.target'],
        requires: ['network-online.target'],
        workingDirectory: '/srv/app/current',
        user: 'www-data',
        group: 'www-data',
        environment: { NODE_ENV: 'production', NOTE: 'a b' },
        restart: 'always',
        restartSec: 5,
        wantedBy: 'default.target',
      }),
    )
    assert.ok(text.includes('Description=api server'))
    assert.ok(text.includes('After=network.target'))
    assert.ok(text.includes('Requires=network-online.target'))
    assert.ok(text.includes('WorkingDirectory=/srv/app/current'))
    assert.ok(text.includes('User=www-data'))
    assert.ok(text.includes('Group=www-data'))
    // 值里带空格时 systemd 需要引号，转义只针对 " 与 \
    assert.ok(text.includes('Environment="NODE_ENV=production"'))
    assert.ok(text.includes('Environment="NOTE=a b"'))
    assert.ok(text.includes('Restart=always'))
    assert.ok(text.includes('RestartSec=5'))
    assert.ok(text.includes('WantedBy=default.target'))
    // 没给的字段不许出现
    assert.equal(text.includes('ExecReload='), false)
  })

  it('模板变量会被展开（${release.current} 一类的值来自注入的上下文）', () => {
    const text = render(
      makeConfig({
        execStart: '${release.current}/start.sh',
        workingDirectory: '${release.current}',
        render: { project: 'api', env: 'prod', release: { current: '/srv/app/current' } },
      }),
    )
    assert.ok(text.includes('ExecStart=/srv/app/current/start.sh'))
    assert.ok(text.includes('WorkingDirectory=/srv/app/current'))
  })

  it('值里含控制字符 → DP.SYSD.UNIT_INVALID（unit 是一行一条指令，换行等于注入）', () => {
    assert.throws(
      () => render(makeConfig({ execStart: 'a\nb' })),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.SYSD.UNIT_INVALID')
        assert.equal(err.path, 'projects.*.target.systemd.execStart')
        return true
      },
    )
  })

  it('extra 逐行原样输出，排在 [Install] 之后', () => {
    const text = render(makeConfig({ extra: ['# 自定义注释', 'LimitNOFILE=65535'] }))
    const lines = text.split('\n')
    assert.equal(lines.at(-1), 'LimitNOFILE=65535')
    assert.ok(text.indexOf('LimitNOFILE=65535') > text.indexOf('[Install]'))
  })

  it('extra 的行含控制字符 → 拒绝（那不是逃生舱，是指令注入口）', () => {
    assert.throws(
      () => render(makeConfig({ extra: ['ExecStart=/evil\nUser=root'] })),
      (err: unknown) => err instanceof DpError && err.code === 'DP.SYSD.UNIT_INVALID',
    )
  })
})

describe('systemd unit 的 managed 标记', () => {
  it('头部注释里带标记就算 dp 管', () => {
    assert.equal(isManaged(`${MANAGED_MARKER}\n[Unit]\n`), true)
  })

  it('不带标记或空文件都不算 —— 空串不等于「不存在」', () => {
    assert.equal(isManaged('[Unit]\nDescription=x\n'), false)
    assert.equal(isManaged(''), false)
  })
})
