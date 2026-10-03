import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError, type Facts, type Step } from '@dp/ports'
import type { Plan } from '@dp/core'
import { CliUsageError } from './args.js'
import {
  EXIT_CONFIG,
  EXIT_FAILURE,
  EXIT_MISSING_DEPENDENCY,
  EXIT_OK,
  EXIT_USAGE,
  EXIT_VERIFY_FAILED,
  describeError,
  exitCodeFor,
  renderErrorJson,
  renderErrorPretty,
  renderFactsJson,
  renderFactsPretty,
  renderPlanJson,
  renderPlanPretty,
} from './output.js'

/** 固定夹具：Plan 是纯数据，黄金快照才有意义 */
const STEPS: readonly Step[] = [
  { id: 'prepare', kind: 'prepare', title: '预检：连接 · 权限实证', host: 'local' },
  { id: 'transfer', kind: 'transfer', title: '传输到 /srv/web/releases/r1.incoming', host: 'local', undo: '删除 /srv/web/releases/r1.incoming' },
  { id: 'prune', kind: 'prune', title: '保留 5 个历史版本', host: 'local' },
]

const PLAN: Plan = {
  layout: 'system',
  releaseRoot: '/srv/web',
  candidates: [
    { path: '/srv/web', writable: true },
    { path: '/opt/web', writable: false, reason: '不可写（只读挂载 / 权限不足 / SELinux）' },
  ],
  steps: STEPS,
  warnings: ['DP.SYSTEMD.NO_LINGER: 用户级服务未开启 linger'],
}

describe('output · 退出码映射（纯函数）', () => {
  it('0 成功', () => assert.equal(EXIT_OK, 0))

  it('2 = 用法/参数错', () => {
    assert.equal(exitCodeFor(new CliUsageError('未知选项', { hint: 'x' })), EXIT_USAGE)
    // 用法错用的是 CONFIG_INVALID 这个码，靠类型而不是码来区分 —— 这正是
    // 需要 CliUsageError 的原因：同一个码对应两种完全不同的失败
    assert.equal(new CliUsageError('x').code, 'CONFIG_INVALID')
  })

  it('3 = 配置错', () => {
    for (const code of ['CONFIG_INVALID', 'DP.SOURCE.EMPTY', 'DP.PATH.RESERVED_NAME', 'DP.LAYOUT.UNSUPPORTED'] as const) {
      assert.equal(exitCodeFor(new DpError(code, 'x')), EXIT_CONFIG, code)
    }
  })

  it('4 = 环境缺依赖', () => {
    for (const code of ['DP.SSH.TOOL_MISSING', 'DP.SSH.DRIVER_UNAVAILABLE', 'DP.PREF.UNSUPPORTED', 'DP.LINK.UNAVAILABLE', 'DP.SSH.AUTH_FAILED'] as const) {
      assert.equal(exitCodeFor(new DpError(code, 'x')), EXIT_MISSING_DEPENDENCY, code)
    }
  })

  it('2 = 验证失败且已回滚：DP.VERIFY.FAILED 独立于「部署失败已回滚」的 1', () => {
    //：CI 要能对验证失败单独发通知，所以它不能和 1 混同
    assert.equal(exitCodeFor(new DpError('DP.VERIFY.FAILED', '健康检查未通过')), EXIT_VERIFY_FAILED)
    assert.equal(exitCodeFor(new DpError('DP.VERIFY.NO_HEALTHCHECK', 'x')), EXIT_FAILURE)
    // 而「其余部署失败但已完整回滚」仍然是 1
    assert.equal(exitCodeFor(new DpError('DP.PATH.NOT_WRITABLE', 'x')), EXIT_CONFIG)
    assert.equal(exitCodeFor(new Error('普通异常')), EXIT_FAILURE)
  })

  it('2 号码承载两种语义：靠 error.code 而不是退出码区分', () => {
    // 验证失败与用法错同码，但 JSON 里的 code 不同 —— 刻意不新造退出码
    const verify = renderErrorJson(new DpError('DP.VERIFY.FAILED', 'x'), false)
    const usage = renderErrorJson(new CliUsageError('x'), false)
    assert.equal(exitCodeFor(new DpError('DP.VERIFY.FAILED', 'x')), EXIT_USAGE)
    assert.equal(exitCodeFor(new CliUsageError('x')), EXIT_USAGE)
    assert.match(verify, /DP\.VERIFY\.FAILED/)
    assert.notEqual(
      (JSON.parse(verify) as { error: { code: string } }).error.code,
      (JSON.parse(usage) as { error: { code: string } }).error.code,
    )
  })

  it('其余 DpError → 1，不编造新码', () => {
    // DP.VERIFY.FAILED 已从这条移走：它有了专属映射（→ 2），
    // 不再属于「其余」。断言的是行为契约，契约改了断言就得跟着改。
    assert.equal(exitCodeFor(new DpError('DP.TIMEOUT.EXEC', 'x')), EXIT_FAILURE)
    assert.equal(exitCodeFor(new DpError('DP.PERM.ELEVATION_REQUIRED', 'x')), EXIT_FAILURE)
  })

  it('未知错误 → 1，且带一句可执行建议', () => {
    assert.equal(exitCodeFor(new Error('boom')), EXIT_FAILURE)
    assert.equal(exitCodeFor('字符串错误'), EXIT_FAILURE)
    assert.equal(exitCodeFor(undefined), EXIT_FAILURE)
    const report = describeError(new Error('boom'))
    assert.equal(report.code, 'DP.CLI.INTERNAL')
    assert.match(report.hint ?? '', /--verbose/, '未知错误也要告诉用户下一步')
  })
})

describe('output · 错误渲染', () => {
  it('pretty 逐字：code + message + path + hint 全部出现', () => {
    const err = new DpError('DP.PATH.NOT_WRITABLE', '没有可写的发布目录', { path: 'release.root', hint: '显式指定 release.root' })
    const text = renderErrorPretty(err, false)
    assert.equal(
      text,
      [
        '错误 [DP.PATH.NOT_WRITABLE]：没有可写的发布目录',
        '  出错位置：release.root',
        '  下一步：显式指定 release.root',
        '  （--verbose 可打印完整 stack）',
      ].join('\n'),
    )
  })

  it('非 verbose 不打印裸 stack，verbose 才打印', () => {
    const err = new Error('boom')
    assert.ok(!renderErrorPretty(err, false).includes('at '), '非 verbose 不得含 stack 帧')
    assert.ok(renderErrorPretty(err, true).includes('boom'))
  })

  it('json 形状固定：ok=false + error + exitCode', () => {
    const err = new DpError('CONFIG_INVALID', '找不到配置', { hint: '放一个 deploy.config.json' })
    const parsed = JSON.parse(renderErrorJson(err, false)) as Record<string, unknown>
    assert.equal(parsed['ok'], false)
    assert.equal(parsed['exitCode'], EXIT_CONFIG)
    const e = parsed['error'] as Record<string, unknown>
    assert.equal(e['code'], 'CONFIG_INVALID')
    assert.equal(e['message'], '找不到配置')
    assert.equal(e['hint'], '放一个 deploy.config.json')
  })
})

describe('output · Plan 渲染（黄金快照）', () => {
  it('pretty 逐字一致', () => {
    assert.equal(
      renderPlanPretty(PLAN, { probeNotes: ['ssh: 用 native-ssh 驱动'] }),
      [
        'plan · 布局 system · 发布根 /srv/web · 3 步',
        '',
        '  1. [prepare] 预检：连接 · 权限实证',
        '     host: local',
        '  2. [transfer] 传输到 /srv/web/releases/r1.incoming',
        '     host: local',
        '     undo: 删除 /srv/web/releases/r1.incoming',
        '  3. [prune] 保留 5 个历史版本',
        '     host: local',
        '',
        '发布根候选（实证可写性，不靠 uid 推断）',
        '  ✓ /srv/web',
        '  ✗ /opt/web —— 不可写（只读挂载 / 权限不足 / SELinux）',
        '',
        '告警',
        '  ! DP.SYSTEMD.NO_LINGER: 用户级服务未开启 linger',
        '',
        '探测说明',
        '  - ssh: 用 native-ssh 驱动',
        '',
        '（只读干跑：没有创建任何目录，也没有写任何文件）',
      ].join('\n'),
    )
  })

  it('两位数序号不会把列挤歪', () => {
    const many: Plan = { ...PLAN, steps: Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, kind: 'prepare', title: `步骤 ${i}`, host: 'local' })) }
    const text = renderPlanPretty(many)
    assert.match(text, / {2}9\. \[prepare\] 步骤 8/)
    assert.match(text, / {1}10\. \[prepare\] 步骤 9/)
  })

  it('没有告警/探测说明时那几段整体不出现', () => {
    const text = renderPlanPretty({ ...PLAN, warnings: [] })
    assert.ok(!text.includes('告警'))
    assert.ok(!text.includes('探测说明'))
  })

  it('json 是完整结构，不裁剪', () => {
    const parsed = JSON.parse(renderPlanJson(PLAN, { project: 'web', host: 'local', releaseId: 'r1' })) as Record<string, unknown>
    assert.equal(parsed['ok'], true)
    assert.equal(parsed['project'], 'web')
    assert.deepEqual(parsed['plan'], PLAN)
    assert.deepEqual(parsed['probeNotes'], [])
  })
})

describe('output · Facts 渲染', () => {
  const FACTS: Facts = {
    host: 'local',
    platform: 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: '/home/u',
    tmpdir: '/tmp',
    env: { PATH: '/usr/bin' },
    capabilities: {
      canWrite: { '/srv': true, '/opt': false },
      canChown: ['root'],
      canSymlink: true,
      systemdScope: 'system',
      lingerEnabled: false,
      canBindPrivilegedPort: true,
      sudoAllowlist: ['ALL'],
    },
    tools: { ssh: '/usr/bin/ssh', rsync: null },
  }

  it('pretty 含能力、可写性、工具', () => {
    const text = renderFactsPretty(FACTS)
    assert.match(text, /facts · host local · linux\/x64 · init systemd/)
    assert.match(text, /canSymlink: true/)
    assert.match(text, /✓ \/srv/)
    assert.match(text, /✗ \/opt/)
    assert.match(text, /\/usr\/bin\/ssh {2}ssh/)
    assert.match(text, /（未找到） {2}rsync/)
  })

  it('sudoAllowlist 为空时显示「（无）」而不是空行', () => {
    const text = renderFactsPretty({ ...FACTS, capabilities: { ...FACTS.capabilities, sudoAllowlist: [] } })
    assert.match(text, /sudoAllowlist: （无）/)
  })

  it('json 含完整 facts 与 probeNotes', () => {
    const parsed = JSON.parse(renderFactsJson(FACTS, ['note'])) as Record<string, unknown>
    assert.equal(parsed['ok'], true)
    assert.deepEqual(parsed['facts'], FACTS)
    assert.deepEqual(parsed['probeNotes'], ['note'])
  })
})
