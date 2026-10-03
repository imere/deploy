/**
 * docker 目标（remote-cli）—— 步骤规划，纯函数侧。
 *
 * 与 nginx 目标同一条纪律：**每条 argv 只在 compose.ts 里写一次**，本文件只负责
 * 决定「哪一步、什么顺序、失败了怎么撤」。执行器从 `detail.argv` 取，不另写一份。
 *
 * 顺序上刻意只有 pull → up：先拉镜像再起容器。反过来 up 之后才 pull，
 * 拉下来的新镜像要等下一次部署才生效，而本次的健康检查验的是**旧镜像** ——
 * 「验过了」与「跑的是刚部署的版本」两件事会悄悄分开。
 */
import { DpError, type Step, type Target, type TargetContext } from '@dp/ports'
import { pullArgv, psArgv, releaseDir, resolveCompose, upArgv, type ResolvedCompose } from './compose.js'
import type { DockerTargetConfig } from './types.js'

const CONFIG_PATH = 'projects.*.target.docker'
const READ_ONLY_UNDO = '无需补偿：只读，不在目标机上留下任何作用'

/** 期望状态。compose 的 state 取值是这些，其它一律不通过（见 parseComposePs） */
const DEFAULT_EXPECT_STATES: readonly string[] = ['running', 'healthy']

/** `up` 的 undo 只能是「再 up 一次上一版」—— 没有能同时让旧版与新版都在跑的 compose 语义 */
function upUndo(ctx: TargetContext): string {
  return ctx.previousReleaseId === undefined
    ? '首次部署无上一版可还原：需要撤销时执行 `docker compose ... down`（本包不自动 down —— 那样会连停掉本机正在跑的同名项目）'
    : `重新 up 上一版的 compose 文件：${releaseDir(ctx, ctx.previousReleaseId)}`
}

export const dockerTarget: Target<DockerTargetConfig> = {
  type: 'docker',

  /**
   * install 只做两件事：确认 compose 文件都在、确认 envFile 在。
   *
   * **不搬文件** —— 搬运是 @dp/transport 的职责，docker 包里重造一套就等于
   * 有了两条上传路径，而「文件到底传没传上去」这件事会开始有两个答案。
   * 所以这里出的是「需要存在」清单，由传输层保证，执行器在动手前先核一遍。
   */
  planInstall(ctx, config): readonly Step[] {
    const resolved = resolveCompose(ctx, config, CONFIG_PATH)
    const required = resolved.files
    const steps: Step[] = [
      {
        id: 'docker.check-compose-files',
        kind: 'prepare',
        title: `确认 ${required.length} 个 compose 文件已随 release 上传：${required.join('、')}`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { requireFiles: required, projectDir: resolved.projectDir },
      },
    ]

    if (resolved.envFile !== undefined) {
      steps.push({
        id: 'docker.check-env-file',
        kind: 'prepare',
        title: `确认 envFile 存在：${resolved.envFile}`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        // envFile 缺失时 compose 报的是 `Couldn't find env file` —— 不指向「这个文件
        // 没上传」，而是让人去查 compose 文件的写法
        detail: { requireFiles: [resolved.envFile], envFile: resolved.envFile },
      })
    }
    return steps
  },

  /** pull → up。`pull: false` 时跳过 pull（tag 固定、离线部署的场景） */
  planActivate(ctx, config): readonly Step[] {
    const resolved = resolveCompose(ctx, config, CONFIG_PATH)
    const steps: Step[] = []

    if (config.compose.pull ?? true) {
      steps.push({
        id: 'docker.pull',
        kind: 'activate',
        title: `拉取镜像：${pullArgv(resolved).join(' ')}`,
        host: ctx.host,
        // pull 只改本地镜像缓存，不动任何运行中的容器 —— 它确实没有需要补偿的动作
        undo: '无需补偿：pull 只更新本地镜像缓存，不影响正在运行的容器',
        detail: { argv: [...pullArgv(resolved)], cwd: resolved.cwd },
      })
    }

    const wait = config.compose.wait ?? true
    steps.push({
      id: 'docker.up',
      kind: 'activate',
      title: `起服务：${upArgv(resolved, wait).join(' ')}${wait ? '' : '（--wait 已关闭，验收只剩 planVerify 一道）'}`,
      host: ctx.host,
      undo: upUndo(ctx),
      detail: { argv: [...upArgv(resolved, wait)], cwd: resolved.cwd, wait },
    })
    return steps
  },

  /**
   * ps → 解析 → 断言。
   *
   * 用 `compose ps` 而不是 `docker ps`：后者列的是这台机器上**所有**
   * 容器，与本项目是否健康无关；前者给的是 compose 级别的期望状态。
   */
  planVerify(ctx, config): readonly Step[] {
    const resolved = resolveCompose(ctx, config, CONFIG_PATH)
    const expectStates = config.healthcheck?.expectStates ?? DEFAULT_EXPECT_STATES
    const only = config.healthcheck?.services ?? []
    const steps: Step[] = [
      {
        id: 'docker.ps',
        kind: 'verify',
        title: `读 compose 状态：${psArgv(resolved).join(' ')}`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: {
          argv: [...psArgv(resolved)],
          cwd: resolved.cwd,
          // 解析规则随计划一起固化。执行器只负责取 stdout 交给它，不自己判断状态
          parse: 'compose-ps',
          expectStates: [...expectStates],
          onlyServices: [...only],
        },
      },
    ]

    if (expectStates.includes('healthy')) {
      // 说清代价：--wait 关掉且没配 healthcheck 时，up 成功只说明容器被创建了
      steps.push({
        id: 'docker.assert-services',
        kind: 'verify',
        title: `断言每个服务处于 ${expectStates.join('/')}（${only.length === 0 ? '全部服务' : only.join('、')}）`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { expectStates: [...expectStates], onlyServices: [...only] },
      })
    }
    return steps
  },

  /**
   * 回滚 = 用上一版 release 目录里的 compose 文件重新 up。
   *
   * 没有上一版就显式报错。首次部署报「回滚成功」是本仓最不能接受的一种假结果：
   * 用户会据此认为线上有东西在跑，而实际状态是「什么都没起」。
   */
  planRollback(ctx, config): readonly Step[] {
    if (ctx.previousReleaseId === undefined) {
      throw new DpError('DP.DOCKER.NO_PREVIOUS', '没有上一版 compose 可回滚', {
        path: CONFIG_PATH,
        hint:
          '首次部署没有可回退的版本。确认要撤销的话，手工执行 `docker compose ... down` —— ' +
          '本包不返回「回滚成功」这种假结果，也不自动 down（那会连停掉本机同名的其它项目）',
      })
    }

    const resolved = resolveCompose({ ...ctx, releaseId: ctx.previousReleaseId }, config, CONFIG_PATH)
    const wait = config.compose.wait ?? true
    return [
      {
        id: 'docker.rollback-up',
        kind: 'activate',
        title: `按上一版 compose 重新 up：${upArgv(resolved, wait).join(' ')}`,
        host: ctx.host,
        undo: `再次 up 本版（${ctx.releaseId}）的 compose 文件`,
        detail: { argv: [...upArgv(resolved, wait)], cwd: resolved.cwd, previousReleaseId: ctx.previousReleaseId },
      },
      {
        id: 'docker.rollback-ps',
        kind: 'verify',
        title: `复验上一版状态：${psArgv(resolved).join(' ')}`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { argv: [...psArgv(resolved)], cwd: resolved.cwd, parse: 'compose-ps', expectStates: [...DEFAULT_EXPECT_STATES] },
      },
    ]
  },
}

/** 导出给执行器：解析结果是唯一事实来源，计划与执行不许各算一遍 */
export type { ResolvedCompose }
