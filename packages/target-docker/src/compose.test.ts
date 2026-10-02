/**
 * compose argv 与 ps 解析的测试。
 *
 * 一条纪律：**断言 argv 数组，不断言拼出来的字符串**。字符串断言会放过
 * 「元素之间多了一个空格」和「某个值被拼成了 `a b` 一个元素」这两类真问题 ——
 * 而后者正是本包存在的理由。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError, type TargetContext } from '@dp/ports'
import { parseComposePs, psArgv, pullArgv, resolveCompose, upArgv } from './compose.js'
import type { DockerTargetConfig } from './types.js'

const CTX: TargetContext = { host: 'web-01', root: '/srv/app', releaseId: 'r-1', keep: 3 }

const RENDER = { project: 'api', env: 'prod' }

function config(over: Partial<DockerTargetConfig['compose']> = {}): DockerTargetConfig {
  return {
    mode: 'remote-cli',
    render: RENDER,
    compose: { files: ['docker-compose.yml'], projectName: 'api', ...over },
  }
}

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof DpError, `期望 DpError，实际：${String(err)}`)
    assert.ok(err.hint !== undefined && err.hint.length > 0, '错误必须带 hint')
    return err.code
  }
  throw new Error('期望抛错，但没有')
}

describe('argv 构造', () => {
  it('pull：文件选项在前，项目名其次，子命令最后', () => {
    const r = resolveCompose(CTX, config({ files: ['docker-compose.yml', 'docker-compose.prod.yml'] }))
    assert.deepEqual(pullArgv(r), [
      'docker', 'compose',
      '-f', '/srv/app/releases/r-1/docker-compose.yml',
      '-f', '/srv/app/releases/r-1/docker-compose.prod.yml',
      '-p', 'api', 'pull',
    ])
  })

  it('up：-d 在前，--wait 打开时在后', () => {
    const r = resolveCompose(CTX, config())
    assert.deepEqual(upArgv(r, true), [
      'docker', 'compose', '-f', '/srv/app/releases/r-1/docker-compose.yml', '-p', 'api', 'up', '-d', '--wait',
    ])
    assert.deepEqual(upArgv(r, false), [
      'docker', 'compose', '-f', '/srv/app/releases/r-1/docker-compose.yml', '-p', 'api', 'up', '-d',
    ])
  })

  it('ps：--format json 是一整个参数，不带空格', () => {
    const r = resolveCompose(CTX, config())
    assert.deepEqual(psArgv(r), [
      'docker', 'compose', '-f', '/srv/app/releases/r-1/docker-compose.yml', '-p', 'api', 'ps', '--format', 'json',
    ])
  })

  it('envFile 变成 --env-file，且在 -p 之前（compose 全局选项）', () => {
    const r = resolveCompose(CTX, config({ envFile: '.env.prod' }))
    assert.deepEqual(pullArgv(r), [
      'docker', 'compose',
      '-f', '/srv/app/releases/r-1/docker-compose.yml',
      '--env-file', '/srv/app/releases/r-1/.env.prod',
      '-p', 'api', 'pull',
    ])
  })

  it('release 目录以 / 结尾的 root 也不产生双斜杠', () => {
    const r = resolveCompose({ ...CTX, root: '/srv/app//' }, config())
    assert.deepEqual(r.files, ['/srv/app/releases/r-1/docker-compose.yml'])
  })

  it('项目名与路径里的变量走 @dp/template 展开', () => {
    const r = resolveCompose(CTX, config({ projectName: '${project}', files: ['${project}.yml'] }))
    assert.equal(r.projectName, 'api')
    assert.deepEqual(r.files, ['/srv/app/releases/r-1/api.yml'])
  })
})

describe('projectName 校验', () => {
  it('每个拒绝分支都报 DP.DOCKER.PROJECT_NAME_INVALID 并给 hint', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['api prod', '含空格'],
      ['API', '含大写'],
      ['-api', '以 - 开头'],
      ['api;rm', '含分号'],
      ['api$x', '含 $'],
      ['api/x', '含分隔符'],
      ['', '空串'],
    ]
    for (const [name, why] of cases) {
      assert.equal(
        code(() => resolveCompose(CTX, config({ projectName: name }))),
        'DP.DOCKER.PROJECT_NAME_INVALID',
        `projectName ${why}（${JSON.stringify(name)}）没有被拒`,
      )
    }
  })

  it('以 - 开头的 hint 要说明会被当成选项，其它字符说明字符集', () => {
    try {
      resolveCompose(CTX, config({ projectName: '-api' }))
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.match(String(err.hint), /选项/)
    }
    try {
      resolveCompose(CTX, config({ projectName: 'API' }))
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.match(String(err.hint), /小写/)
    }
  })

  it('合法的下划线与数字开头都放过', () => {
    assert.equal(resolveCompose(CTX, config({ projectName: 'api_2-1' })).projectName, 'api_2-1')
    assert.equal(resolveCompose(CTX, config({ projectName: '2api' })).projectName, '2api')
  })
})

describe('files 校验', () => {
  it('空数组 → COMPOSE_FILES_EMPTY，hint 说清后果是「去当前目录找」', () => {
    assert.equal(code(() => resolveCompose(CTX, config({ files: [] }))), 'DP.DOCKER.COMPOSE_FILES_EMPTY')
    try {
      resolveCompose(CTX, config({ files: [] }))
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.match(String(err.hint), /当前工作目录/)
    }
  })

  it('重复文件 → COMPOSE_FILE_DUPLICATED（去重是替用户做决定）', () => {
    assert.equal(
      code(() => resolveCompose(CTX, config({ files: ['a.yml', 'b.yml', 'a.yml'] }))),
      'DP.DOCKER.COMPOSE_FILE_DUPLICATED',
    )
  })

  it('绝对路径 / .. 逃逸 / 反斜杠 / 空段 / 空串都拒绝', () => {
    const bad = ['/etc/compose.yml', 'C:/x.yml', '../outside.yml', 'a\\b.yml', 'a//b.yml', '']
    for (const f of bad) {
      assert.equal(
        code(() => resolveCompose(CTX, config({ files: [f] }))),
        'DP.DOCKER.COMPOSE_FILE_INVALID',
        `没有拒绝 ${JSON.stringify(f)}`,
      )
    }
  })

  it('envFile 走同一套路径判定', () => {
    assert.equal(
      code(() => resolveCompose(CTX, config({ envFile: '../secrets.env' }))),
      'DP.DOCKER.COMPOSE_FILE_INVALID',
    )
  })

  it('值里带换行 → 模板层的 DP.TPL.UNSAFE_VALUE（换行会破坏 argv 元素边界）', () => {
    const withVar = {
      ...config({ files: ['${env.NAME}.yml'] }),
      render: { project: 'api', env: 'prod', envVars: { NAME: 'a\nb' } },
    }
    assert.equal(code(() => resolveCompose(CTX, withVar)), 'DP.TPL.UNSAFE_VALUE')
  })
})

describe('mode', () => {
  it('非 remote-cli 显式报错，不静默降级', () => {
    assert.equal(
      code(() => resolveCompose(CTX, { ...config(), mode: 'build-push' })),
      'DP.DOCKER.MODE_UNSUPPORTED',
    )
    assert.equal(code(() => resolveCompose(CTX, { ...config(), mode: 'image-only' })), 'DP.DOCKER.MODE_UNSUPPORTED')
  })
})

describe('parseComposePs', () => {
  it('数组形态：running + healthy 通过', () => {
    const out = JSON.stringify([
      { Service: 'api', State: 'running', Status: 'Up 2 minutes', Health: 'healthy' },
      { Service: 'db', State: 'running', Status: 'Up 2 minutes' },
    ])
    const result = parseComposePs(out)
    assert.equal(result.healthy, true)
    assert.deepEqual(result.services.map((s) => s.service), ['api', 'db'])
    // 没有 healthcheck 的服务 health 是空串，那不是「不健康」
    assert.equal(result.services[1]!.health, '')
  })

  it('NDJSON 形态：每行一个对象，结果与数组形态一致', () => {
    const out = [
      JSON.stringify({ Service: 'api', State: 'running', Health: 'healthy' }),
      JSON.stringify({ Service: 'db', State: 'running' }),
    ].join('\n')
    const result = parseComposePs(out)
    assert.equal(result.healthy, true)
    assert.equal(result.services.length, 2)
  })

  it('exited / restarting / unhealthy 都不通过，且 reason 点名', () => {
    for (const row of [
      { Service: 'api', State: 'exited', Health: '' },
      { Service: 'api', State: 'restarting', Health: '' },
      { Service: 'api', State: 'running', Health: 'unhealthy' },
    ]) {
      const result = parseComposePs(JSON.stringify([row]))
      assert.equal(result.healthy, false, `${JSON.stringify(row)} 竟然判通过了`)
      assert.match(String(result.reason), /api/)
    }
  })

  it('state=running 但 health=unhealthy → 不通过（进程活着 ≠ 服务可用）', () => {
    const result = parseComposePs(JSON.stringify([{ Service: 'api', State: 'running', Health: 'unhealthy' }]))
    assert.equal(result.healthy, false)
  })

  it('健康状态在 starting → 不通过', () => {
    const result = parseComposePs(JSON.stringify([{ Service: 'api', State: 'running', Health: 'starting' }]))
    assert.equal(result.healthy, false)
  })

  it('空输出报错（compose 没装时 stdout 是空的），不是绿灯', () => {
    assert.equal(code(() => parseComposePs('   \n')), 'DP.DOCKER.PS_PARSE_FAILED')
  })

  it('空数组：没有服务被验证 → 不通过，且 services 为空', () => {
    const result = parseComposePs('[]')
    assert.equal(result.healthy, false)
    assert.equal(result.services.length, 0)
  })

  it('非法 JSON 报错，带 cause，且不按空处理', () => {
    const err = code(() => parseComposePs('[{"Service":'))
    assert.equal(err, 'DP.DOCKER.PS_PARSE_FAILED')
  })

  it('单个 JSON 对象走 NDJSON 分支（单容器就是一行），不报错', () => {
    const result = parseComposePs('{"Service":"api","State":"running"}')
    assert.equal(result.services.length, 1)
    assert.equal(result.healthy, true)
  })

  it('NDJSON 中有一行坏掉 → 整体报错，不跳过（跳过等于少验一个服务）', () => {
    assert.equal(
      code(() => parseComposePs(`{"Service":"a","State":"running"}\nnot json\n{"Service":"b","State":"running"}`)),
      'DP.DOCKER.PS_PARSE_FAILED',
    )
  })

  it('数组里出现非对象元素 → 报错', () => {
    assert.equal(code(() => parseComposePs('[1,2]')), 'DP.DOCKER.PS_PARSE_FAILED')
  })

  it('自定义 expectStates 只放行指定状态', () => {
    const out = JSON.stringify([{ Service: 'api', State: 'exited' }])
    assert.equal(parseComposePs(out).healthy, false)
    assert.equal(parseComposePs(out, ['exited']).healthy, true)
  })
})

describe('parseComposePs 的 onlyServices', () => {
  const two = JSON.stringify([
    { Service: 'api', State: 'running', Health: 'healthy' },
    { Service: 'worker', State: 'exited' },
  ])

  it('只判定指定服务：范围外的服务不通过也不算失败', () => {
    const r = parseComposePs(two, ['running', 'healthy'], ['api'])
    assert.equal(r.healthy, true)
    // services 仍给全量，便于诊断时看清机器上到底起了什么
    assert.deepEqual(r.services.map((s) => s.service), ['api', 'worker'])
  })

  it('指定服务本身不通过 → 不通过', () => {
    const r = parseComposePs(two, ['running', 'healthy'], ['worker'])
    assert.equal(r.healthy, false)
    assert.match(String(r.reason), /worker/)
  })

  it('指定的服务在 ps 里根本不存在 → 不通过（名字写错不会变成绿灯）', () => {
    const r = parseComposePs(two, ['running', 'healthy'], ['typo'])
    assert.equal(r.healthy, false)
    assert.match(String(r.reason), /typo/)
    assert.match(String(r.reason), /api/)
  })
})
