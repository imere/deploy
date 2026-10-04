import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { targetSchema, type Config } from '@dp/schema'
import { CliUsageError } from './args.js'
import {
  deriveZeroConfig,
  resolveEnv,
  SOURCE_ROOT_CANDIDATES,
  type ZeroConfigInput,
} from './zero-config.js'

/**
 * `assert.throws` 在本仓的 @types/node 下返回 void，拿不到错误对象。
 * 统一走这个 helper：`instanceof` 收窄类型，不需要断言成具体子类
 * （`CliUsageError` 也是 `DpError`，调用点再按 name / code 区分）。
 */
function caught(fn: () => unknown): DpError {
  try {
    fn()
  } catch (err) {
    if (err instanceof DpError) return err
    throw new Error(`期望 DpError，实际是 ${String(err)}`)
  }
  throw new Error('期望抛错，但没有')
}

/** 一个项目在零配置下的最小输入：源根 dist + 只有一个 index.html */
function webInput(overrides: {
  readonly entries?: readonly string[]
  readonly existingDirs?: readonly string[]
  readonly pick?: 'auto' | 'fail'
  readonly profiles?: readonly string[]
  readonly env?: string
}): ZeroConfigInput {
  return {
    projectName: 'web',
    hostId: 'local',
    entries: overrides.entries ?? ['index.html'],
    existingDirs: overrides.existingDirs ?? ['dist'],
    ...(overrides.pick !== undefined ? { pick: overrides.pick } : {}),
    ...(overrides.profiles !== undefined ? { profiles: overrides.profiles } : {}),
    ...(overrides.env !== undefined ? { env: overrides.env } : {}),
  }
}

function projectOf(name: string, config: Config) {
  const project = config.projects[name]
  assert.ok(project !== undefined, `配置里没有项目 ${name}：${Object.keys(config.projects).join(' | ')}`)
  return project
}

describe('zero-config · 源根候选', () => {
  it('四个候选按 dist > build > out > public 取第一个存在的', () => {
    const all = deriveZeroConfig(webInput({ existingDirs: ['public', 'out', 'build', 'dist'] }))
    assert.equal(projectOf('web', all.config).source.root, './dist/**')

    const noDist = deriveZeroConfig(webInput({ existingDirs: ['public', 'out', 'build'] }))
    assert.equal(projectOf('web', noDist.config).source.root, './build/**')

    const onlyPublic = deriveZeroConfig(webInput({ existingDirs: ['public'] }))
    assert.equal(projectOf('web', onlyPublic.config).source.root, './public/**')
  })

  it('一个都不在 → 报错，并列出它看了哪几个目录 + 指向 --config', () => {
    const err = caught(() => deriveZeroConfig(webInput({ existingDirs: ['src', 'node_modules'] })))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.path, 'projects.web.source.root')
    for (const dir of SOURCE_ROOT_CANDIDATES) {
      assert.match(err.hint ?? '', new RegExp(dir), `hint 里应当列出候选 ${dir}`)
    }
    assert.match(err.hint ?? '', /--config/)
  })

  it('existingDirs 没给 → 同样报错（没依据时不知道该传什么）', () => {
    const err = caught(() => deriveZeroConfig({ projectName: 'web', hostId: 'local', entries: ['index.html'] }))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
  })

  it('源根是产物目录本身的内容（contents 形态），不是目录本身', () => {
    // 写成 './dist' 会把 dist 这一层也传上去，compose 文件相对 release 目录就差一级
    const r = deriveZeroConfig(webInput({ existingDirs: ['dist'] }))
    assert.equal(projectOf('web', r.config).source.root, './dist/**')
  })
})

describe('zero-config · 目标类型', () => {
  it('docker：装配出 target.docker，files 就是探测给出的证据', () => {
    const r = deriveZeroConfig(
      webInput({ entries: ['docker-compose.yml', 'index.html'], existingDirs: ['dist'] }),
    )
    assert.equal(r.detected.kind, 'docker')
    const target = projectOf('web', r.config).target
    assert.ok(target !== undefined, 'docker 必须写出 target 段')
    assert.deepEqual([...target.type], ['docker'])
    const docker = target.docker
    assert.ok(docker !== undefined)
    assert.deepEqual([...docker.compose.files], ['docker-compose.yml'])
    assert.equal(docker.compose.projectName, 'web')
    // mode / pull / wait 由 schema 的默认值补齐 —— 手写一个半成品会在这里红
    assert.equal(docker.mode, 'remote-cli')
    assert.equal(docker.compose.pull, true)
    assert.equal(docker.compose.wait, true)
  })

  it('docker：换个 compose 文件名，files 跟着变（证据不是写死的）', () => {
    const r = deriveZeroConfig(webInput({ entries: ['compose.yaml'], existingDirs: ['dist'] }))
    const docker = projectOf('web', r.config).target?.docker
    assert.ok(docker !== undefined)
    assert.deepEqual([...docker.compose.files], ['compose.yaml'])
  })

  it('nginx：报错，不凭空造 server 块', () => {
    const err = caught(() =>
      deriveZeroConfig(webInput({ entries: ['nginx.conf', 'index.html'], existingDirs: ['dist'] })),
    )
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.match(err.path ?? '', /target\.nginx/)
    assert.match(err.hint ?? '', /--config/)
    assert.match(err.hint ?? '', /server/)
  })

  it('static：不写 target 段（它本来就是默认目标）', () => {
    const r = deriveZeroConfig(webInput({ entries: ['index.html', 'assets/app.js'] }))
    assert.equal(r.detected.kind, 'static')
    assert.equal(projectOf('web', r.config).target, undefined)
  })

  it('只造一个本机主机，项目指向它', () => {
    const r = deriveZeroConfig(webInput({}))
    const hosts = r.config.hosts
    assert.ok(hosts !== undefined)
    assert.deepEqual(Object.keys(hosts), ['local'])
    const host = hosts['local']
    assert.ok(host !== undefined)
    assert.equal(host.local, true)
    assert.equal(host.ssh, undefined)
    assert.deepEqual([...(projectOf('web', r.config).hosts ?? [])], ['local'])
  })
})

describe('zero-config · pick 默认值来自 schema', () => {
  it('不给 pick 时用 targetSchema.pick 的默认值（schema 改默认值这条会红）', () => {
    const schemaDefault = targetSchema.toJsonSchema().properties?.['pick']?.default
    assert.equal(schemaDefault, 'auto')
    const r = deriveZeroConfig(
      webInput({ entries: ['docker-compose.yml', 'index.html'], existingDirs: ['dist'] }),
    )
    const target = projectOf('web', r.config).target
    assert.ok(target !== undefined)
    assert.equal(target.pick, schemaDefault, 'pick 必须来自 schema，不是这里另写的一个值')
  })

  it('给了 pick: fail 就真的传给探测（多候选直接报错，不取最高分）', () => {
    const err = caught(() =>
      deriveZeroConfig(
        webInput({ entries: ['docker-compose.yml', 'index.html'], existingDirs: ['dist'], pick: 'fail' }),
      ),
    )
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.match(err.message, /target\.pick=fail/)
  })
})

describe('resolveEnv · 多环境不能猜', () => {
  it('给了 --env 但不在 profiles 里 → 用法错，并列出可选值', () => {
    const err = caught(() => resolveEnv(['dev', 'prod'], 'staging'))
    assert.ok(err instanceof CliUsageError, `--env 写错是用法错，实际是 ${err.name}`)
    assert.equal(err.path, '--env')
    assert.match(err.hint ?? '', /dev/)
    assert.match(err.hint ?? '', /prod/)
  })

  it('没有 profile → 空串（无环境，不是错误）', () => {
    assert.equal(resolveEnv([], undefined), '')
  })

  it('正好一个 profile → 用它（这不是歧义）', () => {
    assert.equal(resolveEnv(['prod'], undefined), 'prod')
  })

  it('多个且有 defaultEnv → 用它', () => {
    assert.equal(resolveEnv(['dev', 'prod'], undefined, 'dev'), 'dev')
  })

  it('多个且没有 defaultEnv → 报错并列出全部 profile', () => {
    const err = caught(() => resolveEnv(['dev', 'prod'], undefined))
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.match(err.hint ?? '', /dev/)
    assert.match(err.hint ?? '', /prod/)
  })

  it('defaultEnv 不在 profiles 里 → 同样报错（默认环境也得真实存在）', () => {
    const err = caught(() => resolveEnv(['dev', 'prod'], undefined, 'staging'))
    assert.ok(err instanceof CliUsageError)
  })
})

describe('zero-config · notes：自动不等于静默', () => {
  it('至少说清「源根为什么选它」与「目标类型为什么选它」', () => {
    const r = deriveZeroConfig(webInput({ existingDirs: ['build', 'dist'] }))
    const srcNote = r.notes.find((n) => n.includes('源根'))
    assert.ok(srcNote !== undefined, `notes 里没有源根那一行：${r.notes.join(' / ')}`)
    // build 也在候选里，选错（或把顺序写反）这一行会红
    assert.match(srcNote, /存在 dist/)
    assert.match(srcNote, /dist > build > out > public/)

    const kindNote = r.notes.find((n) => n.includes('target.type'))
    assert.ok(kindNote !== undefined, `notes 里没有目标类型那一行：${r.notes.join(' / ')}`)
    assert.match(kindNote, /static/)
  })

  it('docker 时说清 compose 文件与 projectName 从哪来', () => {
    const r = deriveZeroConfig(
      webInput({ entries: ['docker-compose.yml', 'index.html'], existingDirs: ['dist'] }),
    )
    const note = r.notes.find((n) => n.includes('target.docker'))
    assert.ok(note !== undefined, `notes 里没有 docker 那一行：${r.notes.join(' / ')}`)
    assert.match(note, /docker-compose\.yml/)
    assert.match(note, /projectName/)
  })

  it('主机与环境各有一行，且说明不落盘', () => {
    const r = deriveZeroConfig(webInput({ profiles: ['prod'] }))
    assert.ok(r.notes.some((n) => n.includes('local') && n.includes('本机')))
    assert.ok(r.notes.some((n) => n.includes('环境：prod')))
    assert.ok(r.notes.some((n) => n.includes('内存')))
  })
})
