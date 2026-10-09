import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { CliUsageError } from './args.js'
import { selectTargets } from './targets.js'
import { validateConfig } from './config-file.js'
import type { Config } from '@dp/schema'

const base = validateConfig(
  {
    hosts: {
      local: { local: true },
      web1: { ssh: 'deploy@10.0.0.1' },
    },
    projects: {
      web: { source: { root: './dist' } },
      api: { source: { root: './api/dist' }, hosts: ['local'] },
    },
  },
  'test',
)

describe('targets · 唯一候选时不追问（这不是歧义）', () => {
  it('单个主机 + 单个项目 → 直接选中', () => {
    const t = selectTargets({ config: { ...base, projects: { web: base.projects['web'] as never } } as Config, host: 'local' })
    assert.equal(t.length, 1)
    assert.equal(t[0]?.host, 'local')
  })
})

describe('targets · 歧义靠拒绝（铁律 2）', () => {
  it('多个项目没指定 → 报错并列出全部可选值', () => {
    const err = caughtThrows(() => selectTargets({ config: base, host: 'local' })) as CliUsageError
    assert.equal(err.path, '--project')
    assert.match(err.hint ?? '', /web/)
    assert.match(err.hint ?? '', /api/)
  })

  it('多个主机没指定且项目没声明 hosts → 报错并列出全部可选值', () => {
    const err = caughtThrows(() => selectTargets({ config: base, project: 'web' })) as CliUsageError
    assert.equal(err.path, '--host')
    assert.match(err.hint ?? '', /local/)
    assert.match(err.hint ?? '', /web1/)
  })

  it('项目自己声明了 hosts → 不算歧义，直接用声明的', () => {
    const t = selectTargets({ config: base, project: 'api' })
    assert.equal(t.length, 1)
    assert.equal(t[0]?.host, 'local')
  })

  it('--all 与 --host 同给 → 报错（意图冲突）', () => {
    const err = caughtThrows(() => selectTargets({ config: base, all: true, host: 'local' })) as CliUsageError
    assert.match(err.message, /不能同时给/)
  })

  it('不存在的项目 / 主机 → 报错并给出可选值', () => {
    const e1 = caughtThrows(() => selectTargets({ config: base, project: 'nope' })) as CliUsageError
    assert.match(e1.hint ?? '', /web/)
    const e2 = caughtThrows(() => selectTargets({ config: base, project: 'api', host: 'nope' })) as CliUsageError
    assert.match(e2.hint ?? '', /local/)
  })

  it('projects 为空 → 配置错（不是用法错）', () => {
    const err = caughtThrows(() => selectTargets({ config: { projects: {} } as Config, host: 'local' })) as DpError
    assert.equal(err.code, 'DP.CONFIG.INVALID')
  })

  it('没有主机 → 配置错，并说明 hosts 该怎么写', () => {
    const empty = validateConfig({ projects: { web: { source: { root: './d' } } } }, 't')
    const err = caughtThrows(() => selectTargets({ config: empty })) as DpError
    assert.equal(err.path, 'config.hosts')
    assert.match(err.hint ?? '', /local/)
  })
})

describe('targets · --all / --env', () => {
  it('--all 扇出到所有项目', () => {
    const t = selectTargets({ config: base, all: true })
    // web 覆盖两台主机（候选多于一个 → 本应歧义，但 --all 明确要全部），
    // api 声明了自己的 hosts
    assert.ok(t.length >= 2, `--all 至少应扇出 2 个目标，实际 ${t.length}`)
    assert.deepEqual([...new Set(t.map((x) => x.project))].sort(), ['api', 'web'])
  })

  it('profiles.<env>.hosts 覆盖顶层同名主机', () => {
    const withProfile = validateConfig(
      {
        hosts: { local: { local: true } },
        profiles: { prod: { hosts: { local: { ssh: 'deploy@prod' } } } },
        projects: { web: { source: { root: './dist' } } },
      },
      'test',
    )
    const t = selectTargets({ config: withProfile, project: 'web', env: 'prod' })
    assert.equal(t[0]?.hostConfig.ssh, 'deploy@prod')
  })
})

// assert.throws/rejects 在本仓的 @types/node 下返回 void，拿不到错误对象。
// 统一走这两个 helper：类型上直接是 DpError。
function caughtThrows(fn: () => unknown, ctor?: Function): DpError {
  try {
    fn()
  } catch (err) {
    // 第二个参数必须真的校验：忽略它就等于「只要抛了任何东西就算过」。
    if (ctor !== undefined) {
      assert.ok(err instanceof ctor, `期望抛 ${ctor.name}，实际是 ${(err as Error)?.name}: ${String(err)}`)
    }
    return err as DpError
  }
  throw new Error('期望抛错，但没有')
}
