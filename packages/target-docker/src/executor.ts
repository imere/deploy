/**
 * docker 目标（remote-cli）—— 执行器。
 *
 * 与 nginx 执行器同一条纪律，核心只有一条：**计划说跑什么，就跑什么**。argv 全部从
 * `detail.argv` 取（compose.ts 是唯一构造点），执行器里不拼第二条命令 —— 一旦这里
 * 另写一份，症状是「计划里写着 pull 再 up、真跑的是裸 up」，而浮动 tag 的镜像会
 * 静默沿用上一轮那份，健康检查还全绿。
 *
 * 失败时**不自动补偿**，这是本文件最重要的一个决定，理由写在 activateDocker 里。
 */
import {
  DpError,
  type DpErrorCode,
  type ExecResult,
  type Runner,
  type Step,
  type TargetContext,
} from '@dp/ports'
import { parseComposePs, releaseDir, type ComposePsEntry } from './compose.js'
import { dockerTarget } from './target.js'
import type { DockerTargetConfig } from './types.js'

/**
 * 默认命令超时。
 *
 * pull 要走网络、up --wait 要等容器健康，冷启动慢网上几分钟是真实的。但它是**上限**
 * 不是「等它结束」：不设上限等于把铁律 0 明令禁止的静默挂起换回来 —— 卡住的 pull
 * 表现为部署永远不结束，而 CI 里没有任何东西会叫醒它。
 */
const DEFAULT_TIMEOUT_MS = 300_000

/** 错误信息里保留多少 docker 输出。整段塞进去会刷屏，并把真正有用的那几行挤走 */
const OUTPUT_LIMIT = 2000

/**
 * 执行器的四个阶段，与 `target.ts` 的四个 plan 方法**一一对应**。
 *
 * 用联合类型而不是 string：四者的失败后续完全不同（activate 失败交给 healing、
 * verify 失败交给上层判要不要回滚），松散的字符串会让分派写成一串 if，
 * 漏掉一种就静默掉进默认分支。
 */
export type DockerPhase = 'install' | 'activate' | 'verify' | 'rollback'

/**
 * 执行器的输入。
 *
 * 刻意接的是 `ctx + config` 而不是调用方算好的 `Step[]`：计划由 target.ts 重算，
 * 「执行用的是哪份计划」就只有这一个答案。改成接外部步骤，「报告跑的是 A、真跑的是 B」
 * 这种最难复现的事故就有了入口。
 */
export interface DockerExecInput {
  /** 目标机的执行入口。全部 IO 走它 —— 本包自己不起子进程、不读 process.env */
  readonly runner: Runner
  /** 本次部署的身份：host / root / releaseId / 上一版。root 已按实测能力选定，不是配置原样 */
  readonly ctx: TargetContext
  readonly config: DockerTargetConfig
  /** 逐步回调，供 CLI 打实时日志 */
  readonly onStep?: (step: Step) => void
  /**
   * 命令超时。必须显式传：铁律 0 要求每条子进程都有 timeout 兜底，
   * 缺省值只在调用方确实没意见时兜底，且它是个上限而不是「等它结束」。
   */
  readonly timeoutMs?: number
  /** 只算不写：不 pull、不 up。ps 这类只读步骤照跑 —— 它给出的结论是真的 */
  readonly dryRun?: boolean
}

/**
 * 一步的执行痕迹。
 *
 * 计划里有这一步，结果里就必然有它的一条记录（成功、跳过或失败）—— 少一条说明
 * 那一步被静默跳过了，而这是「部署完全成功」的报告里唯一查不出来的事故，
 * 所以 `result()` 会专门核一遍 id 集合。
 */
export interface DockerStepTrace {
  /** 步骤 id，取自 target.ts 的 plan；CLI 按它把实时日志与最终报告对上 */
  readonly id: string
  /**
   * 所属阶段，取自 @dp/ports 的 StepKind。它**不等于** DockerPhase：install 那两步的 kind
   * 是 `prepare`（只做 stat，不动机器），而 phase 记的是「这次调用跑的是哪一段」。
   * 上层要回答「哪一步会在机器上留下作用」看 kind，要回答「挂在哪一段」看 phase。
   */
  readonly kind: Step['kind']
  /** false 表示在这一步上中止 —— 后面的步骤不会再有痕迹 */
  readonly ok: boolean
  /**
   * 该步骤**在机器上没有留下作用**：dryRun 下没执行，或本来就没动手。
   *
   * 判据是「留下没留下」而不是「跑没跑」—— dryRun 的 `compose ps` 真的跑了，
   * 它报的服务状态是真的，所以它是 ran；而 pull 与 up 没跑，写进去的镜像与容器
   * 一次也没发生过，所以是 skipped。报「已拉取已启动」而机器上什么都没变，
   * 比不做更难发现。
   */
  readonly skipped: boolean
}

/**
 * 执行成功的产物。
 *
 * `ok` 是字面量 `true` 而不是布尔：失败走 throw，返回值里没有「失败」这一态，
 * 于是「忘了判 ok 就去读服务状态」在类型层面就不成立。
 */
export interface DockerExecResult {
  /** 恒为 true。存在的意义是让调用方能 narrowing —— 见上面那条 */
  readonly ok: true
  /** 本次调用跑的是哪一段 */
  readonly phase: DockerPhase
  /** 目标机标识，直接取 ctx.host —— 报告要能区分多机部署里每一台的结论 */
  readonly host: string
  /** 本次操作对应的版本。回滚时它是**当前版本**，compose 则取自上一版 release 目录 */
  readonly releaseId: string
  /** 本次没有产生任何目标机作用（`dryRun: true` 时恒为 true）。报告按它决定要不要标注「预演」 */
  readonly dryRun: boolean
  /** 逐步痕迹。计划里的每一步都有记录，顺序即执行顺序 */
  readonly steps: readonly DockerStepTrace[]
  /** verify / rollback 复验到的服务状态。install / activate 没有：它们不读 ps */
  readonly services?: readonly ComposePsEntry[]
  readonly warnings: readonly string[]
}

/** 挂在 `DpError.cause` 上：失败时机器到底处在什么状态 */
export interface DockerExecFailure {
  readonly phase: DockerPhase
  /** 挂掉的是哪一步 */
  readonly step: string
  readonly host: string
  readonly releaseId: string
  /** 截至失败时的全部步骤轨迹（含失败的那一步，ok: false） */
  readonly steps: readonly DockerStepTrace[]
  /** verify / rollback 读到过的服务状态。失败在读 ps 之前时没有 */
  readonly services?: readonly ComposePsEntry[]
  /** 命令原话（stdout，没有则 stderr），截断到 2000 字符 */
  readonly output?: string
  /** 人工下一步该做什么，逐条可执行 */
  readonly healing: readonly string[]
}

// ------------------------------------------------------------
// 失败信息组装
// ------------------------------------------------------------

/** 截断长输出。`docker compose up` 失败时 stderr 动辄几百行，整段塞进去等于什么都没说 */
function excerpt(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length === 0) return ''
  return trimmed.length <= OUTPUT_LIMIT
    ? trimmed
    : `${trimmed.slice(0, OUTPUT_LIMIT)}…（已截断，原文 ${trimmed.length} 字节）`
}

/**
 * docker 的原话必须进错误信息。只报「启动失败」等于让用户自己上机器重跑一遍才知道原因，
 * 而他多半还得靠猜（镜像拉不到、端口占用、healthcheck 一直不绿）。stderr 优先。
 */
function dockerOutput(result: ExecResult): string {
  const err = excerpt(result.stderr)
  if (err !== '') return `docker stderr：\n${err}`
  const out = excerpt(result.stdout)
  if (out !== '') return `docker stdout（stderr 为空）：\n${out}`
  return 'docker 没有留下任何输出 —— 多半是它根本没跑起来（不在 PATH、daemon 没起、或被这条命令的权限挡住）'
}

/**
 * 给人看的 argv。
 *
 * 用 JSON 而不是空格 join：这些值会进 compose 的路径与 `-p`，空格是合法字符，
 * join 出来的字符串无法区分「一个元素里有空格」和「两个元素」—— 而那正是本仓
 * 反复踩到的形状（argv 元素级，见 compose.ts 开头）。这里只是展示，执行仍然只传数组。
 */
function argvText(argv: readonly string[]): string {
  return `argv ${JSON.stringify([...argv])}`
}

/** 计划与执行器不同步 = 代码错误，不是部署失败。说清是哪一步，别让它伪装成一次部署事故 */
function mismatch(stepId: string, what: string): DpError {
  return new DpError('DP.DOCKER.PLAN_MISMATCH', `${stepId} 的 ${what} 与执行器对不上`, {
    path: 'projects.*.target.docker',
    hint: '执行器只按 target.ts 发布的 detail 造命令。改 plan 的步骤 id 或 detail 字段时必须同步改 executor.ts',
  })
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** argv 只从计划里取。执行器里再写一份，症状是「计划与真跑的命令悄悄分叉」 */
function argvOf(step: Step): readonly string[] {
  const argv = step.detail?.['argv']
  if (!isStringArray(argv) || argv.length === 0) throw mismatch(step.id, 'detail.argv')
  return argv
}

/**
 * cwd 从计划里取。它固定到 release 目录（compose 的项目目录），而 compose 里的
 * 相对路径（build.context、volumes 的源）按项目目录解析 —— cwd 不对就是同一个 compose
 * 在两台机器上挂载了不同目录，而且是静默的。
 */
function cwdOf(step: Step): string {
  const cwd = step.detail?.['cwd']
  if (typeof cwd !== 'string' || cwd === '') throw mismatch(step.id, 'detail.cwd')
  return cwd
}

function requireFilesOf(step: Step): readonly string[] {
  const files = step.detail?.['requireFiles']
  if (!isStringArray(files) || files.length === 0) throw mismatch(step.id, 'detail.requireFiles')
  return files
}

function expectStatesOf(step: Step): readonly string[] {
  const states = step.detail?.['expectStates']
  if (!isStringArray(states) || states.length === 0) throw mismatch(step.id, 'detail.expectStates')
  return states
}

/** planVerify 在「检查全部服务」时不带这个键，planRollback 也不带 —— 两者都是「不过滤」而不是「过滤成空」 */
function onlyServicesOf(step: Step): readonly string[] {
  const only = step.detail?.['onlyServices']
  if (only === undefined) return []
  if (!isStringArray(only)) throw mismatch(step.id, 'detail.onlyServices')
  return only
}

function stepAt(plan: readonly Step[], id: string): Step {
  const found = plan.find((step) => step.id === id)
  if (found !== undefined) return found
  // 少走一步在这里的表现是「部署看起来成功了」，所以宁可当场炸
  return (() => {
    throw new DpError('DP.DOCKER.PLAN_MISMATCH', `计划里没有步骤 ${id}`, {
      path: 'projects.*.target.docker',
      hint: '改 target.ts 的步骤时必须同步改执行器',
    })
  })()
}

/** 该步骤在计划里就**没有** —— 例如 pull: false 时没有 pull 步骤，expectStates 不含 healthy 时没有断言步骤 */
function optionalStep(plan: readonly Step[], id: string): Step | undefined {
  return plan.find((step) => step.id === id)
}

/**
 * 从某条 argv 里剥出 `docker compose -f ... -p <name>` 这一段。
 *
 * 报错信息里要给用户「自己执行」的 down / ps 命令。**从计划的那条 argv 推**，
 * 而不是在这里重拼一遍：重拼出的那条命令可能带着另一个项目名或另一组 `-f`，
 * 用户照着执行下去，停掉的与本次部署无关的东西比部署本身更难收拾。
 *
 * 尾部必须**逐元素锚定**在末尾，匹配不上就报错而不是「砍掉最后几个元素」——
 * 项目名取 `up` / `ps` 都是合法的，砍尾元素会砍到 `-p` 的值上。锚定在末尾
 * 也让项目名与子命令同名时不受影响：前缀那一侧是完整的。
 */
function composeBaseOf(step: Step, ...tails: readonly (readonly string[])[]): readonly string[] {
  const argv = [...argvOf(step)]
  for (const tail of tails) {
    const start = argv.length - tail.length
    if (start < 2) continue
    if (tail.every((part, i) => argv[start + i] === part)) {
      const base = argv.slice(0, start)
      if (base[0] === 'docker' && base[1] === 'compose') return base
    }
  }
  throw mismatch(step.id, `detail.argv 的尾部不是 ${tails.map((t) => t.join(' ')).join(' 或 ')}`)
}

/** `up` 那条 argv 的两种合法尾部：wait 开着与关着 */
const UP_TAILS: readonly (readonly string[])[] = [
  ['up', '-d', '--wait'],
  ['up', '-d'],
]
/** ps 的尾部固定。它同时也是**唯一**一条能推出 base 的 ps argv 形态 */
const PS_TAIL: readonly string[] = ['ps', '--format', 'json']

function servicesTable(services: readonly ComposePsEntry[]): string {
  return services
    .map((s) => `${s.service === '' ? '(无名服务)' : s.service} state=${s.state} health=${s.health === '' ? '(没配 healthcheck)' : s.health} status=${s.status}`)
    .join('；')
}

// ------------------------------------------------------------
// 一次执行的上下文
// ------------------------------------------------------------

class Session {
  readonly steps: DockerStepTrace[] = []
  readonly warnings: string[] = []
  private known: readonly ComposePsEntry[] | undefined

  constructor(
    readonly input: DockerExecInput,
    private readonly phase: DockerPhase,
  ) {}

  get runner(): Runner {
    return this.input.runner
  }

  get ctx(): TargetContext {
    return this.input.ctx
  }

  get config(): DockerTargetConfig {
    return this.input.config
  }

  get dryRun(): boolean {
    return this.input.dryRun === true
  }

  get timeoutMs(): number {
    return this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 唯一的 exec 出口：argv 与 cwd 都来自计划，timeoutMs 必填，stdin 永不带。
   *
   * 不喂 stdin 时子进程的 stdin 立即关闭 —— 目标机吐出 `Password:` 而我们没在等，
   * 就是「静默挂起」，CI 里表现为部署永远不结束。
   */
  async exec(step: Step): Promise<ExecResult> {
    return this.runner.exec(argvOf(step), { cwd: cwdOf(step), timeoutMs: this.timeoutMs })
  }

  begin(step: Step): void {
    this.input.onStep?.(step)
  }

  pass(step: Step): void {
    this.steps.push({ id: step.id, kind: step.kind, ok: true, skipped: false })
  }

  /** 在机器上没留下作用：dryRun 下没执行，或本来就没动手 */
  skip(step: Step): void {
    this.steps.push({ id: step.id, kind: step.kind, ok: true, skipped: true })
  }

  rememberServices(services: readonly ComposePsEntry[]): void {
    this.known = services
  }

  async fail(
    step: Step,
    code: DpErrorCode,
    message: string,
    options: {
      readonly path?: string
      readonly hint?: string
      readonly output?: string
      readonly healing?: readonly string[]
    },
  ): Promise<never> {
    this.steps.push({ id: step.id, kind: step.kind, ok: false, skipped: false })
    const failure: DockerExecFailure = {
      phase: this.phase,
      step: step.id,
      host: this.ctx.host,
      releaseId: this.ctx.releaseId,
      steps: [...this.steps],
      ...(this.known !== undefined ? { services: this.known } : {}),
      ...(options.output !== undefined ? { output: options.output } : {}),
      healing: [...(options.healing ?? [])],
    }
    throw new DpError(code, message, {
      path: options.path ?? 'projects.*.target.docker',
      ...(options.hint !== undefined ? { hint: options.hint } : {}),
      cause: failure,
    })
  }

  result(phase: DockerPhase, plan: readonly Step[], services?: readonly ComposePsEntry[]): DockerExecResult {
    // 计划里有的步骤必须都被走一遍（dryRun 下也产出 skipped 的那条）。
    // 少走一步是这里唯一一种「看起来完全成功」的事故。
    const planned = plan.map((step) => step.id)
    const ran = new Set(this.steps.map((step) => step.id))
    const missing = planned.filter((id) => !ran.has(id))
    if (missing.length > 0) {
      throw new DpError('DP.DOCKER.PLAN_MISMATCH', `执行器漏掉了计划里的步骤：${missing.join('、')}`, {
        path: 'projects.*.target.docker',
        hint: '执行器与 target.ts 的步骤 id 不一致。这是代码错误，不是部署失败',
      })
    }
    return {
      ok: true,
      phase,
      host: this.ctx.host,
      releaseId: this.ctx.releaseId,
      dryRun: this.dryRun,
      steps: [...this.steps],
      ...(services !== undefined ? { services } : {}),
      warnings: [...this.warnings],
    }
  }
}

// ------------------------------------------------------------
// ① install：只确认存在，不搬文件
// ------------------------------------------------------------

/**
 * install 一条 exec 都不发。
 *
 * 搬运是 @dp/transport 的职责，这里重造一套就等于有了两条上传路径，而「文件到底传上去
 * 没有」会开始有两个答案。存在与否一律走 stat：`readFile` 在不存在时是抛错的，把
 * 「读不了」（EACCES、路径被换成目录）当成「不存在」会直接放行一次注定失败的部署。
 *
 * @param input runner / ctx / config。**ctx.releaseId 就是 compose 要从中读取的那个版本**：
 *   `dp apply` 把这一段排在传输之后，所以这里 stat 的时候文件本就该在位了 ——
 *   顺序反过来（照抄 nginx 的 install → deploy）会让这一步永远失败或什么也没证明
 * @returns install 的结论。它不带 services：这一步读的是盘上的 compose 文件，不是容器状态
 * @throws DpError DP.DOCKER.FILE_MISSING（compose 文件或 envFile 没随 release 上传），
 *   或 DP.DOCKER.PLAN_MISMATCH（计划与执行器不同步，属代码错误）
 */
export async function installDocker(input: DockerExecInput): Promise<DockerExecResult> {
  const session = new Session(input, 'install')
  const plan = dockerTarget.planInstall(session.ctx, session.config)

  for (const step of plan) {
    session.begin(step)
    const missing: string[] = []
    for (const path of requireFilesOf(step)) {
      const stat = await session.runner.stat(path)
      if (stat === null) {
        missing.push(path)
      } else if (stat.isDirectory) {
        // 目录与「不在」是同一件事：`-f <目录>` 报的是 no such file or directory，
        // 与真缺文件一字不差。不说破的话排查者会去查上传逻辑，而问题在路径本身
        missing.push(`${path}（是个目录，不是文件）`)
      }
    }
    if (missing.length > 0) {
      // 一次列全：只报第一个会让用户改一个、重跑、再撞第二个
      return session.fail(step, 'DP.DOCKER.FILE_MISSING', `目标机上没有这些文件：${missing.join('、')}`, {
        hint:
          'compose 文件是随 release 上传的，本包不搬文件。把它纳入 source.root，' +
          '或检查 source.include/exclude 是不是把它排掉了；路径写成相对 release 目录的形式' +
          `（它会落在 ${releaseDir(session.ctx, session.ctx.releaseId)} 之下）`,
      })
    }
    // dryRun 也真的 stat：它给出的「文件在不在」是真的，记 ran
    session.pass(step)
  }

  return session.result('install', plan)
}

// ------------------------------------------------------------
// ② activate：pull → up
// ------------------------------------------------------------

/** up 失败后的人工下一步。给的是**命令**，不是执行器替人做的动作 */
function upHealing(ctx: TargetContext, base: readonly string[]): readonly string[] {
  const items: string[] = [`先看清机器现在的状态：${argvText([...base, 'ps', '--format', 'json'])}`]
  if (ctx.previousReleaseId !== undefined) {
    items.push(
      `需要退到上一版就跑 \`dp rollback\`：它会用 ${releaseDir(ctx, ctx.previousReleaseId)} 里的 compose 文件重新 up（不 pull）`,
    )
  } else {
    items.push(`首次部署没有上一版可退。确认要撤销就跑 ${argvText([...base, 'down'])}（元素级 argv，不要拼成一条 shell 字符串）`)
  }
  items.push('修好上面 docker 的原话指出的问题后，重跑一次 `dp apply`')
  return items
}

/**
 * pull → up，**不自动补偿**。
 *
 * 不自动 `down`：`docker compose -p <name> down` 按项目名停，而项目名是用户起的、
 * 目标机上可能还有别人在用的另一个项目 —— 一次失败部署换掉别的服务，损失比留着
 * 一个跑着的旧版本大得多。
 *
 * 不自动 `up` 上一版：那是 `dp rollback` 的职责。执行器自动回滚会把「失败」与
 * 「已回滚」两个语义混进同一个结果，上层无法区分，也就无法决定要不要再回滚一次。
 * 所以这里抛错，把该跑的命令写进 healing，由人决定。
 *
 * @param input runner / ctx / config。dryRun 时不 pull 也不 up，两条步骤都记 skipped ——
 *   它们在机器上确实什么都没留下
 * @returns activate 的结论。它同样不带 services：容器起没起来由 verify 那条 compose ps 说，
 *   activate 不读 ps，`up --wait` 的返回值也区分不了「等到健康」和「超时放弃」
 * @throws DpError DP.DOCKER.PULL_FAILED（镜像没拉到，运行中的容器没被动过）或
 *   DP.ACTIVATE.START_FAILED（up 失败；盘上/容器状态要自己看 ps 才知道）
 */
export async function activateDocker(input: DockerExecInput): Promise<DockerExecResult> {
  const session = new Session(input, 'activate')
  const plan = dockerTarget.planActivate(session.ctx, session.config)
  if (session.config.compose.wait === false) {
    // up 不带 --wait 时，compose 只保证「容器被创建了」。唯一一道关变成 verify 的 ps，
    // 而 ps 是在 activate 之后单独跑的 —— 这中间有一段时间线上跑的是半就绪的容器
    session.warnings.push('compose.wait=false：up 不带 --wait，容器是否就绪只由 verify 的 compose ps 判定，期间可能有一段半就绪窗口')
  }

  const pullStep = optionalStep(plan, 'docker.pull')
  if (pullStep !== undefined) {
    session.begin(pullStep)
    if (session.dryRun) {
      session.skip(pullStep)
    } else {
      const pulled = await session.exec(pullStep)
      if (pulled.code !== 0) {
        return session.fail(
          pullStep,
          'DP.DOCKER.PULL_FAILED',
          session.ctx.previousReleaseId === undefined
            ? `拉取镜像失败（退出码 ${pulled.code}），本次没有起任何容器`
            : `拉取镜像失败（退出码 ${pulled.code}）：跑着的仍是上一版的容器，本次没有起新容器`,
          {
            output: dockerOutput(pulled),
            // pull 只动本地镜像缓存，不碰任何运行中的容器 —— 所以这次失败没有东西要撤销
            hint:
              'pull 失败不影响正在跑的容器，也不需要回滚：' +
              (session.ctx.previousReleaseId === undefined ? '这是首次部署，目标机上现在什么都没有。' : '线上跑的还是上一版。') +
              '私有仓库要先在这台机器上完成 `docker login`，浮动 tag 要确认该 tag 在仓库里真实存在。' +
              '本包不缓存镜像判断，pull 每次都跑，所以修好后直接重跑 `dp apply` 即可',
            healing: [
              '不要手工 down：跑着的旧容器是这次失败里唯一还在服务的东西',
              '确认镜像地址与 tag 在目标机上可达（`docker pull <image>:<tag>` 手工跑一次最快）',
              '修好后重跑 `dp apply`',
            ],
          },
        )
      }
      session.pass(pullStep)
    }
  }

  const upStep = stepAt(plan, 'docker.up')
  session.begin(upStep)
  if (session.dryRun) {
    session.skip(upStep)
  } else {
    const up = await session.exec(upStep)
    if (up.code !== 0) {
      return session.fail(upStep, 'DP.ACTIVATE.START_FAILED', `起服务失败（退出码 ${up.code}）`, {
        output: dockerOutput(up),
        // 下面是 heal 之前的状态判断：up 失败时容器可能根本没换，也可能换了一半
        //（`up -d` 先建新容器再停旧的）。执行器读不出是哪一种，所以只给命令不给结论
        hint:
          '本包不做任何自动补偿：自动 down 会连停掉目标机上同名的其它项目，' +
          '自动 up 上一版会让「失败」与「已回滚」两个语义混在一起。' +
          '容器现在到底换了没有，用上面给的状态命令自己看一眼 —— `up -d` 可能已经建了新容器才失败',
        healing: upHealing(session.ctx, composeBaseOf(upStep, ...UP_TAILS)),
      })
    }
    session.pass(upStep)
  }

  return session.result('activate', plan)
}

// ------------------------------------------------------------
// ③ verify：ps → 解析 → 断言
// ------------------------------------------------------------

/**
 * 跑 ps 并解析。**判定规则全部在 parseComposePs 里**，执行器不自己看 state / health。
 *
 * 解析失败时**原码原样冒泡**：DP.DOCKER.PS_PARSE_FAILED 的 message 与 hint 是在册的
 * 「读不出结论 ≠ 健康」告警，包成别的码就丢了「远端 compose 可能根本不可用」这条线索。
 * 这里只补上「挂的是哪一步」——靠 cause 上挂的失败现场，不靠改 code。
 * JSON 解析的那个 SyntaxError 不再往下传：它指不回任何用户能改的东西，
 * 而 raw stdout 已经原样进了 failure.output。
 */
async function readPs(session: Session, step: Step): Promise<ReturnType<typeof parseComposePs>> {
  const result = await session.exec(step)
  if (result.code !== 0) {
    // 命令本身没跑成功，stdout 读不出任何东西 —— 按「验收失败」abort，绝不因为
    // 「反正没输出」就跳到下一步。PS_PARSE_FAILED 留给「跑成了但输出读不懂」，
    // 它的处置提示是「确认远端 compose 可用」，与这里同源，不必换个码
    return session.fail(step, 'DP.DOCKER.PS_PARSE_FAILED', `读 compose 状态失败（退出码 ${result.code}），本次没有任何服务被验证过`, {
      output: dockerOutput(result),
      hint:
        'compose ps 自己没跑成功，所以读不出任何服务状态 —— 这不等于健康。' +
        '常见原因是 compose 文件在 release 目录里找不到、compose 文件语法不合法、或 docker daemon 没起。' +
        '先在同一台机器上手工跑一次下面这条同一条命令，确认它有输出再重试',
      healing: [`手工跑一次确认：${argvText(argvOf(step))}`],
    })
  }
  const stdout = result.stdout
  try {
    return parseComposePs(stdout, expectStatesOf(step), onlyServicesOf(step))
  } catch (err) {
    if (err instanceof DpError) {
      return session.fail(step, err.code, err.message, {
        path: err.path,
        ...(err.hint !== undefined ? { hint: err.hint } : {}),
        // 原样带上读不懂的那份输出：message 说「第几行坏了」，输出才让人看得见坏在哪
        output: `compose ps stdout（原样）：\n${excerpt(stdout) || '(空)'}`,
        healing: [`先看这份输出到底是什么形态：${argvText(argvOf(step))}`],
      })
    }
    throw err
  }
}

/**
 * verify：`compose ps --format json` → 解析 → 断言。
 *
 * 为什么 verify 要自己再跑一次 ps，而不是复用 activate 那次 up：
 * `up --wait` 只在 wait 打开时才等到健康，关闭时 `up` 返回只说明容器被创建了 ——
 * 若验收跟着 up 走，同一份配置在 wait 开关之间会有一半情形根本没验收。
 * 走 ps 这一条，两种配置下的判据是同一套字符串比较。
 *
 * 不通过**不回滚**：版本好不好 vs 该不该退回去，是上层 `dp apply` 的事，
 * 这里只保证结论是真的（读不出结论就抛 PS_PARSE_FAILED，绝不判通过）。
 *
 * @param input runner / ctx / config。**dryRun 下 ps 照样真跑**：它是只读的，
 *   给出的服务状态是真的，所以那一步记 ran 而不是 skipped
 * @returns 结论与读到的全部服务条目（`services`），供报告与后续的 healing 命令使用
 * @throws DpError DP.DOCKER.PS_PARSE_FAILED（读不出服务状态，有两种成因：命令没跑成、
 *   或输出读不懂）或 DP.VERIFY.FAILED（有结论但不达标）
 */
export async function verifyDocker(input: DockerExecInput): Promise<DockerExecResult> {
  const session = new Session(input, 'verify')
  const plan = dockerTarget.planVerify(session.ctx, session.config)

  const psStep = stepAt(plan, 'docker.ps')
  session.begin(psStep)
  // dryRun 也真跑：ps 是只读的，它给出的结论是真的
  const parsed = await readPs(session, psStep)
  session.rememberServices(parsed.services)
  session.pass(psStep)

  // 断言步骤没有 argv：它消费上一步的解析结果，不重跑命令。
  // expectStates 不含 healthy 时计划里没有这一步，判定就落在 ps 那一步上 ——
  // 但**不通过一样要报错**：把判定省掉等于把健康检查做成永远绿的灯
  const assertStep = optionalStep(plan, 'docker.assert-services')
  const failStep = assertStep ?? psStep
  if (assertStep !== undefined) session.begin(assertStep)
  if (!parsed.healthy) {
    return session.fail(
      failStep,
      'DP.VERIFY.FAILED',
      `服务状态不达标：${parsed.reason ?? '读不出通过结论'}。实际状态：${servicesTable(parsed.services)}`,
      {
        hint:
          '健康检查没过就是没过，这里不会因为「状态看起来差不多」而放行。' +
          '部署是激活成功的，回不回滚由上层决定（`dp apply` 的回滚判定看这个错误码）。' +
          '先看下面服务状态里的 status 列：镜像起不来、端口占用、healthcheck 一直不绿都在那里写着',
        healing: [
          '看清每个服务卡在哪：' + argvText(argvOf(psStep)),
          '进容器看日志：`docker compose logs --tail 200 <service>`',
          ...(session.ctx.previousReleaseId !== undefined
            ? [`需要退到上一版就跑 \`dp rollback\`（会用 ${releaseDir(session.ctx, session.ctx.previousReleaseId)} 的 compose 重新 up）`]
            : [`首次部署没有上一版可退。确认要撤销就跑 ${argvText([...composeBaseOf(psStep, PS_TAIL), 'down'])}（元素级 argv）`]),
        ],
      },
    )
  }
  if (assertStep !== undefined) session.pass(assertStep)

  return session.result('verify', plan, parsed.services)
}

// ------------------------------------------------------------
// ④ rollback：上一版重新 up（不 pull）→ 复验
// ------------------------------------------------------------

/**
 * rollback：按**上一版 release 目录里的 compose** 重新 up（不 pull），再复验一遍。
 *
 * 不 pull 是刻意的：浮动 tag 再拉一次会把「上一版」换成现在仓库里的新镜像，
 * 那就不是回滚而是换了个版本重新上线，而报告仍然显示回滚成功。
 *
 * @param input runner / ctx / config。**ctx.previousReleaseId 必须是真正的上一版**：
 *   static 的回滚语义是「从 current 退到 previous」，那份 ctx 里的 previousReleaseId
 *   对 docker 而言可能是当前版本 —— 直接传下来会让执行器拿当前版本的 compose 再 up 一次
 * @returns 结论与复验读到的服务条目
 * @throws DpError DP.DOCKER.NO_PREVIOUS（首次部署，由 planRollback 在配置期判定），
 *   DP.ACTIVATE.START_FAILED（上一版的 compose 自己起不来），或 DP.VERIFY.FAILED
 *   （回滚已执行但上一版也没起来 —— 这时机器上跑的是上一版，需要人工介入）
 */
export async function rollbackDocker(input: DockerExecInput): Promise<DockerExecResult> {
  const session = new Session(input, 'rollback')
  // planRollback 在 previousReleaseId 缺失时直接抛 NO_PREVIOUS：
  // 「没有上一版可回滚」不是执行期发现，是配置期就能判定的事，不许在这里吞成空计划
  const plan = dockerTarget.planRollback(session.ctx, session.config)

  const upStep = stepAt(plan, 'docker.rollback-up')
  session.begin(upStep)
  if (session.dryRun) {
    session.skip(upStep)
  } else {
    const up = await session.exec(upStep)
    if (up.code !== 0) {
      return session.fail(upStep, 'DP.ACTIVATE.START_FAILED', `回滚启动失败（退出码 ${up.code}）`, {
        output: dockerOutput(up),
        hint:
          '回滚就是用上一版的 compose 再 up 一次，它失败了说明**上一版自己就起不来** —— ' +
          '常见于上一版的镜像已被清理（dangling / 被 prune 掉）或机器资源已经变了。' +
          '本次不 pull：浮动 tag 再拉一次会把上一版换成新镜像，那就不是回滚了',
        healing: [
          `确认这一版还在盘上：${argvText(argvOf(upStep))}`,
          '镜像被清了就指定一个还存在的 tag 重新 up，或改用一次全新的 apply',
        ],
      })
    }
    session.pass(upStep)
  }

  const psStep = stepAt(plan, 'docker.rollback-ps')
  session.begin(psStep)
  const parsed = await readPs(session, psStep)
  session.rememberServices(parsed.services)
  if (!parsed.healthy) {
    return session.fail(
      psStep,
      'DP.VERIFY.FAILED',
      `回滚已经执行，但上一版也没起来：${parsed.reason ?? '读不出通过结论'}。实际状态：${servicesTable(parsed.services)}。现在需要人工介入`,
      {
        hint:
          '机器上跑的是上一版的 compose，但它的服务没过检查 —— 回滚本身成功了，坏的是上一版。' +
          '这时再自动 down 只会让机器上什么都不剩，所以执行器到此为止，把现状与命令交给你',
        healing: [
          `看清每个服务卡在哪：${argvText(argvOf(psStep))}`,
          '进容器看日志：`docker compose logs --tail 200 <service>`',
          '确认问题后再决定：修好重新 `dp apply`，或手工 down 掉（见上面的 ps 输出确认项目名）',
        ],
      },
    )
  }
  session.pass(psStep)

  return session.result('rollback', plan, parsed.services)
}

// ------------------------------------------------------------
// 失败现场的读取
// ------------------------------------------------------------

/** 把 unknown 摊成可逐字段判定的记录，而不是 cast 成一个我们希望它是的东西 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) out[key] = item
  return out
}

/**
 * 读 `DpError.cause` 里的结构化失败信息用这个，而不是 cast。
 *
 * 执行器失败时保证挂上它；调用方拿到别的东西说明错误不是本包抛的 ——
 * 那就该当成「没有可用的失败现场」，而不是把读不出来的字段当成空数组。
 *
 * @param value 通常就是 `DpError.cause`。它的形状不属于本包的对外契约，
 *   所以只判字段在不在，不进一步校验取值
 * @returns true 表示可以按 DockerExecFailure 逐字段读（phase / step / steps / healing）
 */
export function isDockerExecFailure(value: unknown): value is DockerExecFailure {
  const record = asRecord(value)
  if (record === null) return false
  return (
    typeof record['step'] === 'string' &&
    typeof record['phase'] === 'string' &&
    Array.isArray(record['steps']) &&
    Array.isArray(record['healing'])
  )
}
