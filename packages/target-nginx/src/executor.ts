import {
  DpError,
  describeExecFailure,
  excerptOutput,
  type DpErrorCode,
  type ExecResult,
  type Runner,
  type Step,
  type TargetContext,
} from '@dp/ports'
import { assertOverwritable, type OverwriteDecision } from './ownership.js'
import { renderShadowMainConf } from './render.js'
import { layout, nginxTarget, renderFor, type Layout } from './target.js'
import type { NginxTargetConfig } from './types.js'

/**
 * 默认命令超时。
 */
const DEFAULT_TIMEOUT_MS = 30_000

const SHADOW_DIR_MODE = 0o700
const CONF_MODE = 0o644

/**
 * 执行器的一个阶段。与 `@dp/ports` 的 `StepKind` **不是一套东西**：StepKind 描述「做了哪类动作」（prepare / install / activate…），阶段描述「调用的是哪个入口函数」。一个入口会连跑好几种 StepKind（activate 里就有 backup / validate / reload），合成一个枚举的话，失败信息里就只剩一句「activate 挂了」，看不出是其中哪一步。
 */
export type NginxPhase = 'install' | 'activate' | 'verify' | 'rollback'

/**
 * 四个入口共用的入参。
 */
export interface NginxExecInput {
  /** 目标机通道。`nginx -t` 与 reload 也经它发出，本包不直接起子进程 */
  readonly runner: Runner
  /** 发布上下文。只用来推导影子目录名（带 releaseId）与回填结果，不决定换哪个版本 */
  readonly ctx: TargetContext
  /** 渲染与路径推导的唯一依据。confd / render 在这里是必填的，本包不探测也不读环境 */
  readonly config: NginxTargetConfig
  /** 逐步回调，供 CLI 打实时日志 */
  readonly onStep?: (step: Step) => void
  /**
   * 命令超时。必须显式传：铁律 0 要求每条子进程都有 timeout 兜底，缺省值只在调用方确实没意见时兜底，且它是个上限而不是「等它结束」。
   */
  readonly timeoutMs?: number
  /**
   * 只算不写。`dp apply --dry-run` 用：走完渲染、所有权判定与影子校验，但不写 confd、不 rename、不 reload。
   */
  readonly dryRun?: boolean
}

/**
 * 一步的执行轨迹。这个类型存在的理由是 `skipped` 字段，见它自己的说明。
 */
export interface NginxStepTrace {
  /** 计划的 step id。失败信息里的 step 靠它与用户手上的 plan 输出对上 */
  readonly id: string
  /** 直接取自计划的 kind，不重新分类 */
  readonly kind: Step['kind']
  /** 跑完且结论为真；失败一律抛错，不会带着 `ok: false` 的轨迹返回 */
  readonly ok: boolean
  /**
   * 该步骤**在机器上没有留下作用**：dryRun 下没执行、无事可做（本来就没有上一份可备份）、或执行过但产物已随补偿撤销。
   */
  readonly skipped: boolean
}

/**
 * 一个阶段跑完后的结论。`ok` 是字面量 `true` —— 失败不返回，一律抛错。
 */
export interface NginxExecResult {
  /** 恒为 true。要处理失败请 catch `DpError` 并读 `cause` 上的 NginxExecFailure */
  readonly ok: true
  /** 哪个入口跑的。失败时同一个值也出现在 cause 里，两边对得上才算定位得到 */
  readonly phase: NginxPhase
  /** 目标机，与 ctx.host 相同，原样带回便于日志按机器聚合 */
  readonly host: string
  /** 本次部署的版本号。verify / rollback 也带它：conf 路径与影子目录名都由它推导 */
  readonly releaseId: string
  /** confd 里的目标文件 */
  readonly file: string
  /** 所有权判定结果。install / activate 会做判定，verify / rollback 不做 */
  readonly ownership?: OverwriteDecision
  /**
   * 是否 dryRun。为 true 时**磁盘上什么都没留下**（影子目录已撤、confd 未碰），调用方不得拿它当「已经生效」的依据继续往下走。
   */
  readonly dryRun: boolean
  /**
   * 本次**真的发出过** reload 且成功。
   */
  readonly reloaded: boolean
  /** 非致命但必须让人看到的事：补偿未完全成功、影子目录清理失败一类 */
  readonly warnings: readonly string[]
  /** 逐步轨迹。skipped 的步骤也在内 —— 「没做什么」和「做了什么」一样是要报告的 */
  readonly steps: readonly NginxStepTrace[]
}

/** 挂在 `DpError.cause` 上：失败时机器到底处在什么状态 */
export interface NginxExecFailure {
  readonly phase: NginxPhase
  /** 挂掉的是哪一步 */
  readonly step: string
  readonly host: string
  readonly file: string
  /** 截至失败时的全部步骤轨迹（含失败的那一步，ok: false） */
  readonly steps: readonly NginxStepTrace[]
  /** 补偿已收回去的动作 */
  readonly compensated: readonly string[]
  /** 补偿本身失败的动作 —— 那些副作用**留在机器上了** */
  readonly compensationErrors: readonly string[]
  /** nginx 的原话（stderr，没有则 stdout） */
  readonly output?: string
}

interface UndoEntry {
  readonly label: string
  readonly run: () => Promise<void>
}

export interface UnwindReport {
  readonly done: readonly string[]
  readonly errors: readonly string[]
}

// 失败信息组装

/**
 * nginx 的原话必须进错误信息。只报「校验失败」等于让用户自己上机器重跑一遍才能知道原因，而他多半还得靠猜（改哪个文件、加什么 include）。stderr 优先，没有才看 stdout。
 */
function nginxOutput(result: ExecResult): string {
  const err = excerptOutput(result.stderr)
  if (err !== '') return `nginx stderr：\n${err}`
  const out = excerptOutput(result.stdout)
  if (out !== '') return `nginx stdout（stderr 为空）：\n${out}`
  return 'nginx 没有留下任何输出 —— 多半是它根本没跑起来（不在 PATH、被 cgroup 限制、或被这条命令的权限挡住）'
}

// 路径与计划

/**
 * confd / shadowDir 必须是绝对路径且不含 `..`。
 */
function assertAbsoluteRemotePath(kind: string, path: string, configPath: string): void {
  const escaped = path.split('/').some((segment) => segment === '..')
  if (path.startsWith('/') && !escaped) return
  throw new DpError('DP.NGX.CONF_INVALID', `${kind} 不是可信的目标机绝对路径：${path}`, {
    path: configPath,
    hint: '目标机路径由上层从 layout 推导后注入，必须以 / 开头且不含 `..`。相对路径会随进程工作目录漂移，`..` 能写到 confd 之外',
  })
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** argv 只从计划里取。执行器里再写一份，症状是「计划与真跑的命令悄悄分叉」 */
function argvOf(step: Step): readonly string[] {
  const argv = step.detail?.['argv']
  if (!isStringArray(argv) || argv.length === 0) {
    throw new DpError('DP.NGX.CONF_INVALID', `${step.id} 的 detail.argv 缺失或不是非空字符串数组`, {
      hint: '执行器只按计划里发布的 argv 造命令。要改命令就改 target.ts 的 plan，不要在执行器里另写一份',
    })
  }
  return argv
}

function stepAt(plan: readonly Step[], id: string): Step {
  const found = plan.find((step) => step.id === id)
  if (found !== undefined) return found
  // 计划与执行器不同步是代码错误，不是部署失败。说清楚是哪一步，
  throw new DpError('DP.NGX.CONF_INVALID', `计划里没有步骤 ${id}`, {
    hint: '改 target.ts 的步骤时必须同步改执行器：少走一步在这里的表现是「部署看起来成功了」',
  })
}

// 一次执行的上下文

class Session {
  readonly L: Layout
  readonly steps: NginxStepTrace[] = []
  readonly warnings: string[] = []
  private readonly undo: UndoEntry[] = []
  private reloaded = false

  constructor(
    readonly input: NginxExecInput,
    private readonly phase: NginxPhase,
  ) {
    const { config } = input
    assertAbsoluteRemotePath('confd', config.confd, 'projects.*.target.nginx.confd')
    if (config.shadowDir !== undefined) {
      assertAbsoluteRemotePath('shadowDir', config.shadowDir, 'projects.*.target.nginx.shadowDir')
    }
    this.L = layout(input.ctx, config)
  }

  get runner(): Runner {
    return this.input.runner
  }

  get ctx(): TargetContext {
    return this.input.ctx
  }

  get config(): NginxTargetConfig {
    return this.input.config
  }

  get dryRun(): boolean {
    return this.input.dryRun === true
  }

  get timeoutMs(): number {
    return this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /**
   * 唯一的 exec 出口：timeoutMs 必填，stdin 永不带。
   */
  async exec(argv: readonly string[]): Promise<ExecResult> {
    return this.runner.exec(argv, { timeoutMs: this.timeoutMs })
  }

  begin(step: Step): void {
    this.input.onStep?.(step)
  }

  pass(step: Step): void {
    this.steps.push({ id: step.id, kind: step.kind, ok: true, skipped: false })
  }

  /** dryRun 下走过判定但没动手 */
  skip(step: Step): void {
    this.steps.push({ id: step.id, kind: step.kind, ok: true, skipped: true })
  }

  reloadedNow(): void {
    this.reloaded = true
  }

  pushUndo(label: string, run: () => Promise<void>): void {
    this.undo.push({ label, run })
  }

  /** 副作用就此落定：之后的失败不再回滚已完成的步骤 */
  commit(): void {
    this.undo.length = 0
  }

  /** 逆序执行补偿。**永不抛错**：补偿失败要作为附加信息上报，不能顶掉原始错误 */
  async unwind(): Promise<UnwindReport> {
    const done: string[] = []
    const errors: string[] = []
    while (this.undo.length > 0) {
      const entry = this.undo.pop()!
      try {
        await entry.run()
        done.push(entry.label)
      } catch (err) {
        errors.push(`${entry.label} → ${describeExecFailure(err)}`)
      }
    }
    return { done, errors }
  }

  async fail(
    step: Step,
    code: DpErrorCode,
    message: string,
    options: {
      readonly path?: string
      readonly hint?: string | ((report: UnwindReport) => string)
      readonly output?: string
    },
  ): Promise<never> {
    this.steps.push({ id: step.id, kind: step.kind, ok: false, skipped: false })
    const report = await this.unwind()
    const hint = typeof options.hint === 'function' ? options.hint(report) : options.hint
    const failure: NginxExecFailure = {
      phase: this.phase,
      step: step.id,
      host: this.ctx.host,
      file: this.L.file,
      steps: [...this.steps],
      compensated: report.done,
      compensationErrors: report.errors,
      ...(options.output !== undefined ? { output: options.output } : {}),
    }
    throw new DpError(code, message, {
      path: options.path ?? 'projects.*.target.nginx',
      ...(hint !== undefined ? { hint } : {}),
      cause: failure,
    })
  }

  result(phase: NginxPhase, plan: readonly Step[], ownership?: OverwriteDecision): NginxExecResult {
    // 计划里有的步骤必须都被走一遍（dryRun 下也产出 skipped 的那条）。
    const planned = plan.map((step) => step.id)
    const ran = new Set(this.steps.map((step) => step.id))
    const missing = planned.filter((id) => !ran.has(id))
    if (missing.length > 0) {
      throw new DpError('DP.NGX.CONF_INVALID', `执行器漏掉了计划里的步骤：${missing.join(', ')}`, {
        hint: '执行器与 target.ts 的步骤 id 不一致。这是代码错误，不是部署失败',
      })
    }
    return {
      ok: true,
      phase,
      host: this.ctx.host,
      releaseId: this.ctx.releaseId,
      file: this.L.file,
      ...(ownership !== undefined ? { ownership } : {}),
      dryRun: this.dryRun,
      reloaded: this.reloaded,
      warnings: [...this.warnings],
      steps: [...this.steps],
    }
  }
}

// IO 小工具

/**
 * 建目录，并把**最外层那级原本不存在的目录**登记成撤销目标。
 *
 * 与 systemd / process 执行器里的 mkdirTracked 同构（同一套「建目录 + 登记撤销」台账），
 * 差异在撤销边界（这里从 confd 推导，那边是显式 root）与 dryRun 额外清理；统一成一份
 * 要以 exec-session 基件为前提，本包暂不收
 */
async function mkdirTracked(session: Session, dir: string): Promise<void> {
  const confd = session.config.confd.replace(/\/+$/, '')
  const chain: string[] = []
  let cur = ''
  for (const part of dir.split('/').filter((p) => p !== '')) {
    cur = `${cur}/${part}`
    chain.push(cur)
  }
  const missing: string[] = []
  for (const p of chain) {
    if ((await session.runner.stat(p)) === null) missing.push(p)
  }
  await session.runner.mkdir(dir, { recursive: true, mode: SHADOW_DIR_MODE })
  // 只收 confd **之下**的路径：confd 自己是 nginx 的目录，本包不负责删它 ——
  const under = missing.filter((p) => p.startsWith(`${confd}/`))
  const firstUnderConfd = dir.startsWith(`${confd}/`)
    ? `${confd}/${dir.slice(confd.length + 1).split('/')[0]}`
    : dir
  const top = under[0] ?? firstUnderConfd
  session.pushUndo(`删除 ${top}`, () => session.runner.remove(top))
}

/** 读现有 conf，不存在返回 null。 */
async function readConfIfExists(session: Session): Promise<string | null> {
  if ((await session.runner.stat(session.L.file)) === null) return null
  return session.runner.readFile(session.L.file)
}

function overwriteOptions(session: Session): { force?: boolean; path: string } {
  return {
    ...(session.config.force !== undefined ? { force: session.config.force } : {}),
    path: 'projects.*.target.nginx',
  }
}

/**
 * 影子主配置要 include 的清单 = confd 的真实内容，减去四样东西。
 */
async function collectIncludes(runner: Runner, confd: string, L: Layout): Promise<readonly string[]> {
  const trailing = confd.replace(/\/+$/, '')
  const includes: string[] = []
  for (const name of await runner.listDir(trailing)) {
    const path = `${trailing}/${name}`
    if (path === L.file || path === L.backup || path === L.newFile) continue
    if (path === L.shadowRoot || path.startsWith(`${L.shadowRoot}/`)) continue
    const stat = await runner.stat(path)
    // 目录会让 nginx 把整棵子树拉进来；已消失的项会踩空。两者都不是「一份 conf」
    if (stat === null || stat.isDirectory) continue
    includes.push(path)
  }
  return includes.sort()
}

/**
 * 还原上一份 conf，并重新 `-t` 确认确实回到了原状。
 */
async function restoreConf(session: Session, liveArgv: readonly string[]): Promise<void> {
  const { runner, L } = session
  if ((await runner.stat(L.backup)) === null) {
    // 首次部署没有上一份。此时正确的收场不是「留一个 nginx 拒绝的坏文件」，
    await runner.remove(L.file)
  } else {
    await runner.rename(L.backup, L.file)
  }
  const check = await session.exec(liveArgv)
  if (check.code !== 0) {
    const err = excerptOutput(check.stderr) || excerptOutput(check.stdout) || '(无输出)'
    throw new Error(`还原后 nginx -t 仍然失败（退出码 ${check.code}）：${err}`)
  }
}

// ① install：渲染 + 影子校验，**完全不碰生产文件**

/**
 * ① install：渲染 → 写影子候选 → 影子校验，**完全不碰生产文件**。
 *
 * @param input 见 NginxExecInput；本阶段只读输入，不改 ctx
 * @returns 阶段结论；影子目录留在现场（便于下次 include 时排除），ownership 带判定结果
 * @throws DpError `DP.NGX.NOT_MANAGED` —— 目标 conf 存在、不带 managed 标记、也没 force。
 * 此时尚未写过任何东西，confd 仍是部署前的内容
 * @throws DpError `DP.NGX.TEST_FAILED` —— 候选过不了 `nginx -t`。候选从未写进 `<confd>/<filename>`，
 * 同样不需要手工回滚；nginx 的原话在 hint 里
 */
export async function installNginx(input: NginxExecInput): Promise<NginxExecResult> {
  const session = new Session(input, 'install')
  const { L } = session
  const plan = nginxTarget.planInstall(session.ctx, session.config)

  // 判定排在任何写入之前。planInstall 内部的渲染是本地纯计算，不产生目标机副作用，
  const existing = await readConfIfExists(session)
  const ownership = assertOverwritable(existing, overwriteOptions(session))
  const content = renderFor(session.config)

  // ① 渲染
  const renderStep = stepAt(plan, 'nginx.render')
  session.begin(renderStep)
  session.pass(renderStep)

  // ② 写候选到影子目录
  const writeStep = stepAt(plan, 'nginx.write-candidate')
  session.begin(writeStep)
  await mkdirTracked(session, L.shadowDir)
  await session.runner.writeFile(L.candidate, content, { mode: CONF_MODE })
  await session.runner.writeFile(
    L.mainConfig,
    renderShadowMainConf({
      includes: await collectIncludes(session.runner, session.config.confd, L),
      candidate: L.candidate,
      path: 'projects.*.target.nginx',
    }),
    { mode: CONF_MODE },
  )
  // dryRun 下这一步真的写了，但紧接着就被撤销，净效果为零 → 记 skipped。
  if (session.dryRun) session.skip(writeStep)
  else session.pass(writeStep)

  // ③ 影子校验
  const checkStep = stepAt(plan, 'nginx.validate-shadow')
  session.begin(checkStep)
  const check = await session.exec(argvOf(checkStep))
  if (check.code !== 0) {
    return session.fail(checkStep, 'DP.NGX.TEST_FAILED', `候选 conf 过不了 nginx -t（退出码 ${check.code}）`, {
      output: nginxOutput(check),
      hint: (report) =>
        `${compensationSuffix(report)}候选没有写进 ${L.file}，confd 里仍是部署前的内容，无需手工回滚。` +
        '上面是 nginx 的原话：按它指的文件/行去改（同一棵树里别的 conf 冲突、环境缺模块或证书都属于这一类），' +
        '改完重新部署即可；本次渲染出的候选留在影子目录里可以自己拿去比对',
    })
  }
  session.pass(checkStep)

  if (session.dryRun) {
    // dryRun 承诺的是「不写 confd」。而影子校验必须有盘上的文件才能跑（`nginx -t` 只读，
    const report = await session.unwind()
    for (const err of report.errors) session.warnings.push(`影子目录清理失败（dryRun 应无残留）：${err}`)
  } else {
    // 影子目录留着。它就是下一次部署 include 清单里最容易漏排除的东西，
    session.commit()
  }

  return session.result('install', plan, ownership)
}

// ② activate：备份 → 原子替换 → 复验 → reload

/**
 * ② activate：备份 → 原子替换 → 复验 → reload。这是**唯一会动生产 conf** 的阶段。
 *
 * @param input 见 NginxExecInput
 * @returns 阶段结论；`reloaded` 为 true 只在真发过 reload 且成功时成立
 * @throws DpError `DP.NGX.TEST_FAILED` —— 复验不过。已把备份 rename 回原位并重新
 * `-t` 确认；首次部署没有备份，此时 `<confd>/<filename>` 被删除，confd 回到部署前
 * @throws DpError `DP.NGX.RELOAD_FAILED` —— **不回滚**，盘上的 conf 是好的，
 * nginx 跑的还是替换前那份。修好重载机制后手动重跑同一条 reload 命令即可
 */
export async function activateNginx(input: NginxExecInput): Promise<NginxExecResult> {
  const session = new Session(input, 'activate')
  const { L } = session
  const plan = nginxTarget.planActivate(session.ctx, session.config)

  const existing = await readConfIfExists(session)
  const ownership = assertOverwritable(existing, overwriteOptions(session))

  // 与影子校验那份**逐字相同**：renderConf 是纯函数，重新渲染不依赖影子目录是否还在。
  const content = renderFor(session.config)
  const liveArgv = argvOf(stepAt(plan, 'nginx.validate-live'))

  // ① 备份
  const backupStep = stepAt(plan, 'nginx.backup')
  session.begin(backupStep)
  if (ownership.backup && !session.dryRun) {
    // 备份只留上一份，不留历史链：回滚要的是「上一次生效的那份」，
    await session.runner.rename(L.file, L.backup)
    session.pass(backupStep)
  } else {
    // dryRun 与「本来就没有上一份」都记 skipped：这一步在机器上没留下任何东西。
    session.skip(backupStep)
  }

  // ② 原子替换
  const replaceStep = stepAt(plan, 'nginx.replace')
  session.begin(replaceStep)
  // 登记必须在动手**之前**：备份一被 rename 走，磁盘上就没有那份 conf 了，
  session.pushUndo(
    ownership.backup ? `还原 ${L.backup} → ${L.file}` : `删除首次部署写入的 ${L.file}`,
    () => restoreConf(session, liveArgv),
  )
  if (session.dryRun) {
    session.skip(replaceStep)
  } else {
    await session.runner.writeFile(L.newFile, content, { mode: CONF_MODE })
    session.pushUndo(`删除中间文件 ${L.newFile}`, () => session.runner.remove(L.newFile))
    await session.runner.rename(L.newFile, L.file)
    session.pass(replaceStep)
  }

  // ③ 复验整棵树
  const checkStep = stepAt(plan, 'nginx.validate-live')
  session.begin(checkStep)
  if (session.dryRun) {
    session.skip(checkStep)
  } else {
    const live = await session.exec(liveArgv)
    if (live.code !== 0) {
      return session.fail(checkStep, 'DP.NGX.TEST_FAILED', `换上去之后整棵 include 树过不了 nginx -t（退出码 ${live.code}）`, {
        output: nginxOutput(live),
        hint: (report) =>
          `${compensationSuffix(report)}` +
          (ownership.backup
            ? `已把备份还原回 ${L.file} 并重新 -t 确认；nginx 当前跑的还是替换前那份配置。`
            : `首次部署没有备份可还原，${L.file} 已被删除，confd 回到部署前。`) +
          ' 上面是 nginx 的原话。影子校验能过而这一步过不了，差在影子主配置**没有**包含的那些东西（真实主配置里的 map / mime.types / 其他 conf）',
      })
    }
    session.pass(checkStep)
  }

  // 复验通过 = 这份 conf 被 nginx 接受了，替换到此落定。
  session.commit()

  // ④ reload
  const reloadStep = stepAt(plan, 'nginx.reload')
  session.begin(reloadStep)
  if (L.reload === false) {
    // reload: false 时计划里就有「已禁用」这条步骤，产出它，不发任何命令
    session.pass(reloadStep)
  } else if (session.dryRun) {
    session.skip(reloadStep)
  } else {
    const reloaded = await session.exec(argvOf(reloadStep))
    if (reloaded.code !== 0) {
      return session.fail(reloadStep, 'DP.NGX.RELOAD_FAILED', `reload 失败（退出码 ${reloaded.code}）`, {
        output: nginxOutput(reloaded),
        hint:
          `${L.file} 已经在盘上并且通过了 nginx -t，**不需要回滚**：nginx 现在跑的还是替换前那份配置。` +
          ' 原话见上。按它修好重载机制后手动重跑一次同样的 reload 命令即可收敛；' +
          '在 reload 修好之前重复部署只会让同一份新 conf 反复写进磁盘而线上始终不生效',
      })
    }
    session.pass(reloadStep)
    session.reloadedNow()
  }

  return session.result('activate', plan, ownership)
}

// ③ verify：读回来逐字比对

/**
 * ③ verify：把 confd 里的内容读回来，与本次渲染结果**逐字**比对。
 *
 * @param input 见 NginxExecInput
 * @returns 阶段结论；内容不一致时 `ok` 仍为 true，差异写在 warnings 里
 * @throws DpError `DP.VERIFY.FAILED` —— 目标 conf 不存在。差异不算失败，见上
 */
export async function verifyNginx(input: NginxExecInput): Promise<NginxExecResult> {
  const session = new Session(input, 'verify')
  const { L } = session
  const plan = nginxTarget.planVerify(session.ctx, session.config)

  const checkStep = stepAt(plan, 'nginx.verify-conf')
  session.begin(checkStep)
  const expected = renderFor(session.config)
  const actual = await readConfIfExists(session)

  if (actual === null) {
    return session.fail(checkStep, 'DP.VERIFY.FAILED', `${L.file} 不存在`, {
      hint: 'confd 里没有本次该有的那份 conf。重新跑一次 apply 会写上去；如果这台机器本来就不该有它，检查 confd 是不是被清过',
    })
  }
  if (actual !== expected) {
    // 内容不一致只报警告、不回滚：那份内容本身可能完全合法（有人手改过）
    session.warnings.push(
      `DP.VERIFY.FAILED: ${L.file} 与本次渲染结果不一致（线上 ${actual.length} 字节 / 本次 ${expected.length} 字节）。` +
        '文件存在且可能被 dp 之外的东西改过，或是这台机器上的配置来自另一次部署。确认要接管就重新 apply 一次覆盖它',
    )
  }
  session.pass(checkStep)

  return session.result('verify', plan)
}

// ④ rollback：还原备份 + 复验 + reload

/**
 * ④ rollback：把备份 rename 回原位 → 复验 → reload。
 *
 * @param input 见 NginxExecInput；`ctx.previousReleaseId` 缺省时计划期就抛错
 * @returns 阶段结论；reload 被配成 `false` 时只跑完还原与复验即返回
 * @throws DpError `DP.NGX.NO_PREVIOUS` —— 备份文件不存在。**不会**返回「回滚成功」这种假结果
 * @throws DpError `DP.NGX.TEST_FAILED` —— 还原后仍过不了 `-t`，说明**上一份 conf 本身**
 * 或它同树的其它文件就是坏的（它当初替换上来时未必被验过）
 * @throws DpError `DP.NGX.RELOAD_FAILED` —— 还原已落盘且过了 `-t`，只是 nginx 还没加载。
 * 修好重载机制后手动重跑同一条 reload 即可，不必再动文件
 */
export async function rollbackNginx(input: NginxExecInput): Promise<NginxExecResult> {
  const session = new Session(input, 'rollback')
  const { L } = session
  // planRollback 在 previousReleaseId 缺失时直接抛 NO_PREVIOUS：
  const plan = nginxTarget.planRollback(session.ctx, session.config)

  const restoreStep = stepAt(plan, 'nginx.restore-backup')
  session.begin(restoreStep)
  if ((await session.runner.stat(L.backup)) === null) {
    return session.fail(restoreStep, 'DP.NGX.NO_PREVIOUS', `没有可还原的备份：${L.backup} 不存在`, {
      hint:
        '首次部署没有上一份 conf 可回滚，本包不会返回「回滚成功」这种假结果。' +
        '确实要撤掉这次部署的话，手动删除该 conf 后 reload —— 备份只在上一次替换时才产生',
    })
  }
  await session.runner.rename(L.backup, L.file)
  session.pass(restoreStep)

  const checkStep = stepAt(plan, 'nginx.validate-rollback')
  session.begin(checkStep)
  const check = await session.exec(argvOf(checkStep))
  if (check.code !== 0) {
    return session.fail(checkStep, 'DP.NGX.TEST_FAILED', `还原之后整棵 include 树过不了 nginx -t（退出码 ${check.code}）`, {
      output: nginxOutput(check),
      hint:
        `注意备份已经被 rename 掉，没有第二份可退：${L.backup} 不再存在。` +
        ' 也就是说**上一份 conf 本身或它同树的其它文件就是坏的**（它替换上来时未必被验过）。' +
        '按上面的原话改完再 reload；若只是想要当前渲染结果，重新 apply 一次即可写回去',
    })
  }
  session.pass(checkStep)

  if (L.reload === false) {
    // planRollback 在 reload: false 时不产出 reload 步骤
    return session.result('rollback', plan)
  }
  const reloadStep = stepAt(plan, 'nginx.reload-rollback')
  session.begin(reloadStep)
  if (session.dryRun) {
    session.skip(reloadStep)
  } else {
    const reloaded = await session.exec(argvOf(reloadStep))
    if (reloaded.code !== 0) {
      return session.fail(reloadStep, 'DP.NGX.RELOAD_FAILED', `还原已落盘但 reload 失败（退出码 ${reloaded.code}）`, {
        output: nginxOutput(reloaded),
        hint: `${L.file} 已还原成上一份并通过了 nginx -t，只是 nginx 还没加载它。修好重载机制后手动重跑一次同样的 reload 命令即可；不需要再动文件`,
      })
    }
    session.pass(reloadStep)
    session.reloadedNow()
  }

  return session.result('rollback', plan)
}

/** 补偿结果拼成给用户看的一句话。原错误始终在前，补偿只是附加信息 */
function compensationSuffix(report: UnwindReport): string {
  if (report.errors.length > 0) {
    return `【补偿未完全成功，以下副作用留在机器上，需人工处理：${report.errors.join('；')}】`
  }
  if (report.done.length === 0) return '【本次没有需要收回的动作】'
  return `【已收回：${report.done.join('；')}】`
}

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
 * @param value 待判定的 `unknown`，通常是 catch 到的 `DpError.cause`
 * @returns true 仅表示这几个字段齐备、可以安全按 NginxExecFailure 读；**不表示**它是本包抛的
 * —— 同样形状的 cause 也可能来自别的包，判定时请以 `phase` 的取值一并核对
 */
export function isNginxExecFailure(value: unknown): value is NginxExecFailure {
  const record = asRecord(value)
  if (record === null) return false
  return (
    typeof record['step'] === 'string' &&
    Array.isArray(record['steps']) &&
    Array.isArray(record['compensated']) &&
    Array.isArray(record['compensationErrors'])
  )
}
