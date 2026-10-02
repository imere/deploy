/**
 * 四个 planX 的测试。
 *
 * 断言点只有两类：**步骤的 id/顺序**，与 **`detail.argv` 的元素**。
 * 不断言拼出来的字符串 —— 那是 compose 目标最容易被放过的一类错。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError, type Step, type TargetContext } from '@dp/ports'
import { dockerTarget } from './target.js'
import type { DockerTargetConfig } from './types.js'

const CTX: TargetContext = { host: 'web-01', root: '/srv/app', releaseId: 'r-1', keep: 3 }

function config(over: Partial<DockerTargetConfig['compose']> = {}, healthcheck?: DockerTargetConfig['healthcheck']): DockerTargetConfig {
  return {
    mode: 'remote-cli',
    render: { project: 'api', env: 'prod' },
    compose: { files: ['docker-compose.yml'], projectName: 'api', ...over },
    ...(healthcheck !== undefined ? { healthcheck } : {}),
  }
}

function argvsOf(steps: readonly Step[], id: string): readonly string[] {
  const step = steps.find((s) => s.id === id)
  assert.ok(step !== undefined, `没有这一步 ${id}，实际：${steps.map((s) => s.id).join(',')}`)
  const argv = step.detail?.argv
  assert.ok(Array.isArray(argv), `${id} 的 detail.argv 不是数组`)
  return argv as readonly string[]
}

function code(fn: () => unknown): string {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof DpError, `期望 DpError，实际：${String(err)}`)
    return err.code
  }
  throw new Error('期望抛错，但没有')
}

describe('planInstall', () => {
  it('只做存在性确认，不搬文件；envFile 给不给都成立', () => {
    const plain = dockerTarget.planInstall(CTX, config())
    assert.deepEqual(plain.map((s) => s.id), ['docker.check-compose-files'])
    assert.deepEqual(plain[0]!.detail?.requireFiles, ['/srv/app/releases/r-1/docker-compose.yml'])

    const withEnv = dockerTarget.planInstall(CTX, config({ envFile: '.env.prod' }))
    assert.deepEqual(withEnv.map((s) => s.id), ['docker.check-compose-files', 'docker.check-env-file'])
    assert.deepEqual(withEnv[1]!.detail?.requireFiles, ['/srv/app/releases/r-1/.env.prod'])
  })

  it('多个 compose 文件按给定顺序全部列出', () => {
    const steps = dockerTarget.planInstall(CTX, config({ files: ['base.yml', 'prod.yml'] }))
    assert.deepEqual(steps[0]!.detail?.requireFiles, [
      '/srv/app/releases/r-1/base.yml',
      '/srv/app/releases/r-1/prod.yml',
    ])
  })

  it('每步都有 undo', () => {
    for (const s of dockerTarget.planInstall(CTX, config({ envFile: '.env.prod' }))) {
      assert.ok(s.undo !== undefined && s.undo.length > 0, `${s.id} 缺 undo`)
    }
  })
})

describe('planActivate', () => {
  it('pull → up，argv 与 compose.ts 一致', () => {
    const steps = dockerTarget.planActivate(CTX, config())
    assert.deepEqual(steps.map((s) => s.id), ['docker.pull', 'docker.up'])
    assert.deepEqual(argvsOf(steps, 'docker.pull'), [
      'docker', 'compose', '-f', '/srv/app/releases/r-1/docker-compose.yml', '-p', 'api', 'pull',
    ])
    assert.deepEqual(argvsOf(steps, 'docker.up'), [
      'docker', 'compose', '-f', '/srv/app/releases/r-1/docker-compose.yml', '-p', 'api', 'up', '-d', '--wait',
    ])
  })

  it('pull: false → 整步不出现（而不是跑一条 --pull never）', () => {
    const steps = dockerTarget.planActivate(CTX, config({ pull: false }))
    assert.deepEqual(steps.map((s) => s.id), ['docker.up'])
  })

  it('wait: false → up 不带 --wait，标题要说清只剩一道关', () => {
    const steps = dockerTarget.planActivate(CTX, config({ wait: false }))
    assert.deepEqual(argvsOf(steps, 'docker.up'), [
      'docker', 'compose', '-f', '/srv/app/releases/r-1/docker-compose.yml', '-p', 'api', 'up', '-d',
    ])
    assert.match(String(steps.find((s) => s.id === 'docker.up')?.title), /验收只剩/)
  })

  it('首次部署的 undo 不谎称有上一版', () => {
    const steps = dockerTarget.planActivate(CTX, config())
    assert.match(String(steps[1]!.undo), /首次部署/)
  })

  it('有上一版时 undo 指向上一版 release 目录', () => {
    const steps = dockerTarget.planActivate({ ...CTX, previousReleaseId: 'r-0' }, config())
    assert.match(String(steps[1]!.undo), /\/srv\/app\/releases\/r-0/)
  })

  it('cwd 固定在 release 目录（compose 的相对路径按项目目录解析）', () => {
    const steps = dockerTarget.planActivate(CTX, config())
    for (const s of steps) assert.equal(s.detail?.cwd, '/srv/app/releases/r-1')
  })
})

describe('planVerify', () => {
  it('ps → 断言，两步；argv 带 --format json', () => {
    const steps = dockerTarget.planVerify(CTX, config())
    assert.deepEqual(steps.map((s) => s.id), ['docker.ps', 'docker.assert-services'])
    assert.deepEqual(argvsOf(steps, 'docker.ps'), [
      'docker', 'compose', '-f', '/srv/app/releases/r-1/docker-compose.yml', '-p', 'api', 'ps', '--format', 'json',
    ])
    // 解析规则随计划固化：执行器只取 stdout，不自己判断状态
    assert.equal(steps[0]!.detail?.parse, 'compose-ps')
    assert.deepEqual(steps[0]!.detail?.expectStates, ['running', 'healthy'])
  })

  it('healthcheck.services 限定范围，空=全部服务', () => {
    const steps = dockerTarget.planVerify(CTX, config({}, { services: ['api'] }))
    assert.deepEqual(steps[1]!.detail?.onlyServices, ['api'])
    assert.match(steps[1]!.title, /api/)
    assert.deepEqual(dockerTarget.planVerify(CTX, config())[1]!.detail?.onlyServices, [])
  })

  it('expectStates 不含 healthy 时不出现多余的断言步骤', () => {
    const steps = dockerTarget.planVerify(CTX, config({}, { expectStates: ['running'] }))
    assert.deepEqual(steps.map((s) => s.id), ['docker.ps'])
  })
})

describe('planRollback', () => {
  it('无上一版 → DP.DOCKER.NO_PREVIOUS，不返回假成功', () => {
    assert.equal(code(() => dockerTarget.planRollback(CTX, config())), 'DP.DOCKER.NO_PREVIOUS')
  })

  it('有上一版 → 用上一版目录的 compose 重新 up 并复验', () => {
    const steps = dockerTarget.planRollback({ ...CTX, previousReleaseId: 'r-0' }, config())
    assert.deepEqual(steps.map((s) => s.id), ['docker.rollback-up', 'docker.rollback-ps'])
    assert.deepEqual(argvsOf(steps, 'docker.rollback-up'), [
      'docker', 'compose', '-f', '/srv/app/releases/r-0/docker-compose.yml', '-p', 'api', 'up', '-d', '--wait',
    ])
    assert.deepEqual(argvsOf(steps, 'docker.rollback-ps'), [
      'docker', 'compose', '-f', '/srv/app/releases/r-0/docker-compose.yml', '-p', 'api', 'ps', '--format', 'json',
    ])
  })

  it('回滚不 pull：浮动 tag 再拉一次会把上一版换成新镜像', () => {
    const steps = dockerTarget.planRollback({ ...CTX, previousReleaseId: 'r-0' }, config())
    assert.equal(steps.some((s) => s.id.includes('pull')), false)
  })
})

describe('四个 plan 共用同一套校验', () => {
  it('非法配置在每个 plan 里都报同一个码（不该 install 过、activate 才炸）', () => {
    const bad = config({ projectName: 'API' })
    for (const plan of [
      () => dockerTarget.planInstall(CTX, bad),
      () => dockerTarget.planActivate(CTX, bad),
      () => dockerTarget.planVerify(CTX, bad),
      () => dockerTarget.planRollback({ ...CTX, previousReleaseId: 'r-0' }, bad),
    ]) {
      assert.equal(code(plan), 'DP.DOCKER.PROJECT_NAME_INVALID')
    }
  })

  it('非 remote-cli 在每个 plan 里都显式报错', () => {
    const wrong: DockerTargetConfig = { ...config(), mode: 'build-load' }
    for (const plan of [
      () => dockerTarget.planInstall(CTX, wrong),
      () => dockerTarget.planActivate(CTX, wrong),
      () => dockerTarget.planVerify(CTX, wrong),
      () => dockerTarget.planRollback({ ...CTX, previousReleaseId: 'r-0' }, wrong),
    ]) {
      assert.equal(code(plan), 'DP.DOCKER.MODE_UNSUPPORTED')
    }
  })
})
