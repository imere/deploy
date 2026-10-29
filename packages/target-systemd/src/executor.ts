import {
  ERR,
  DpError,
  describeExecFailure,
  excerptOutput,
  isManaged,
  type DpErrorCode,
  type ExecResult,
  type Runner,
  type Step,
  type TargetContext,
} from '@dp/ports'
import {
  renderUnitFor,
  systemdTarget,
  unitPaths,
  type UnitPaths,
} from './target.js'
import type { SystemdTargetConfig } from './types.js'

/** 默认命令超时。守护进程类命令（restart）会自己返回，不需要更长 */
const DEFAULT_TIMEOUT_MS = 30_000

const SHADOW_DIR_MODE = 0o700
const UNIT_MODE = 0o644

/**
 * 执行器的一个阶段。与 `@dp/ports` 的 `StepKind` **不是一套东西**：StepKind 描述
 * 「做了哪类动作」，阶段描述「调用的是哪个入口函数」。合成一个枚举的话，失败信息里
 * 就只剩一句「activate 挂了」，看不出是其中哪一步。
 */
export type SystemdPhase = 'install' | 'activate' | 'verify' | 'rollback'

/**
 * 四个入口共用的入参。
 */
export interface SystemdExecInput {
  /** 目标机通道。所有 unit 写入与 systemctl 调用都经它发出，本包不直接起子进程 */
  readonly runner: Runner
  readonly ctx: TargetContext
  readonly config: SystemdTargetConfig
  readonly onStep?: (step: Step) => void
  /**
   * 命令超时。**每个子进程都必须给**：systemctl 在一台卡住的机器上会挂住，
   * 没有兜底就是一次永不返回的部署。
   */
  readonly timeoutMs?: number
  /** 只算不写。`dp apply --dry-run` 用 */
  readonly dryRun?: boolean
}

/** 一步的执行轨迹。`skipped` 的存在理由见它自己的说明 */
export interface SystemdStepTrace {
  readonly id: string
  readonly kind: Step['kind']
  /** 跑完且结论为真；失败一律抛错，不会带着 `ok: false` 的轨迹返回 */
  readonly ok: boolean
  /** 该步骤**在机器上没有留下作用**：dryRun 下没执行、无事可做，或产物已随补偿撤销 */
  readonly skipped: boolean
}

/** 覆盖判定的结论 */
export interface SystemdOwnership {
  readonly action: 'create' | 'replace'
  readonly reason: string
  readonly backup: boolean
}

/** 一个阶段跑完后的结论。`ok` 恒为 `true` —— 失败不返回，一律抛错 */
export interface SystemdExecResult {
  readonly ok: true
  readonly phase: SystemdPhase
  readonly host: string
  readonly releaseId: string
  readonly file: string
  readonly unitName: string
  /** 所有权判定结果。install / activate 会做，verify / rollback 不做 */
  readonly ownership?: SystemdOwnership
  /** 为 true 时**磁盘上什么都没留下**（影子目录已撤、unitDir 未碰） */
  readonly dryRun: boolean
  /** 真发过 daemon-reload 且成功 */
  readonly reloaded: boolean
  /** 真发过 restart 且成功 */
  readonly restarted: boolean
  /** 真发过 `systemctl enable` 且成功。`enabled: false` 时恒为 false */
  readonly enabled: boolean
  readonly warnings: readonly string[]
  readonly steps: readonly SystemdStepTrace[]
}

/** 挂在 `DpError.cause` 上：失败时机器到底处在什么状态 */
export interface SystemdExecFailure {
  readonly phase: SystemdPhase
  readonly step: string
  readonly host: string
  readonly file: string
  readonly steps: readonly SystemdStepTrace[]
  readonly compensated: readonly string[]
  /** 补偿本身失败的动作 —— 那些副作用**留在机器上了** */
  readonly compensationErrors: readonly string[]
  /** systemctl 的原话（stderr，没有则 stdout） */
  readonly output?: string
}

interface UndoEntry {
  readonly label: string
  readonly run: () => Promise<void>
}

interface UnwindReport {
  readonly done: readonly string[]
  readonly errors: readonly string[]
}

/** systemctl 的原话必须进错误信息。只报「失败了」等于让用户自己上机器重跑一遍 */
function outputOf(result: ExecResult): string {
  const err = excerptOutput(result.stderr)
  if (err !== '') return `systemctl stderr：\n${err}`
  const out = excerptOutput(result.stdout)
  if (out !== '') return `systemctl stdout（stderr 为空）：\n${out}`
  return 'systemctl 没有留下任何输出'
}

/**
 * 建目录并把**最外层那级原本不存在的目录**登记成撤销目标。
 *
 * 与 nginx / process 执行器里的 mkdirTracked 同构（同一套「建目录 + 登记撤销」台账），
 * 差异在撤销边界（这里的 root 是显式传入）与权限位（0o700）；统一成一份要以
 * exec-session 基件为前提，本包暂不收
 */
async function mkdirTracked(session: Session, dir: string, root: string): Promise<void> {
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
  const under = missing.filter((p) => p.startsWith(`${root}/`))
  const top = under[0] ?? dir
  session.pushUndo(`删除 ${top}`, () => session.runner.remove(top))
  // recursive mkdir 会把缺失的每一级都建出来，而 root 之上那几级（releases/ 与版本目录）
  // 不在上面的登记范围内 —— 它们是**共享**目录，真正出错要补偿时不该由本次部署删掉。
  // dryRun 是另一回事：它承诺的是「磁盘上什么都没留下」，留下两个空目录就等于把这句
  // 话降格成「没留下有用的东西」。所以 dryRun 额外把这次新建的那几级也登记上，
  // 且只登记这次查明不存在的（`missing`），不碰原本就在的那几级
  if (session.dryRun) {
    for (const p of missing.filter((p) => !p.startsWith(`${root}/`)).reverse()) {
      session.pushUndo(`dryRun 清理 ${p}`, () => session.runner.remove(p))
    }
  }
}

/**
 * 从计划里取 argv。执行器只按计划里发布的 argv 造命令 ——
 * 在这里另写一份，症状是「计划与真跑的命令悄悄分叉」。
 *
 * @param step 计划里的一步
 * @returns 该步的 argv
 * @throws DpError `DP.SYSD.UNIT_INVALID` —— 这一步没有 argv（执行器与 target.ts 不同步）
 */
function argvOf(step: Step): readonly string[] {
  const argv = step.detail?.['argv']
  if (Array.isArray(argv) && argv.length > 0 && argv.every((item) => typeof item === 'string')) {
    return argv as readonly string[]
  }
  throw new DpError(ERR.SYSD.UNIT_INVALID, `${step.id} 的 detail.argv 缺失或不是非空字符串数组`, {
    hint: '执行器只按计划里发布的 argv 造命令。要改命令就改 target.ts 的 plan，不要在执行器里另写一份',
  })
}

/** 读现有 unit，不存在返回 null */
async function readUnitIfExists(session: Session): Promise<string | null> {
  if ((await session.runner.stat(session.paths.file)) === null) return null
  return session.runner.readFile(session.paths.file)
}

/**
 * 判定现存 unit 能不能被覆盖。**纯函数：三种路况都按数据返回**，由调用方决定是继续还是报错。
 *
 * 判据只有「带不带 managed 标记」与「有没有 `force`」两条 —— 不空的判断一律排在后面，
 * 因为空文件也是一种「别人在这儿」的证据，不能因为读出来是空就当成没占。
 *
 * @param existing 现存 unit 全文；目标文件不存在时为 `null`
 * @param options `force` 表示明知不带标记也要写（仍会先备份）
 * @returns `action`：新建 / 覆盖（配 `backup=true`）/ 拒绝；`reason` 给错误信息用
 */
function decideUnitOverwrite(
  existing: string | null,
  options?: { readonly force?: boolean },
): { readonly action: 'create' | 'replace' | 'abort'; readonly reason: string; readonly backup: boolean } {
  if (existing === null) return { action: 'create', backup: false, reason: '目标 unit 不存在' }
  if (isManaged(existing)) return { action: 'replace', backup: true, reason: '带 managed 标记，属于 dp 管理的 unit' }
  if (options?.force === true) {
    return { action: 'replace', backup: true, reason: '不带标记，但显式 force；仍然先备份' }
  }
  return {
    action: 'abort',
    backup: false,
    reason:
      existing.trim() === ''
        ? '目标 unit 存在且为空，不带 managed 标记'
        : '目标 unit 存在且不带 managed 标记，可能不是 dp 写的',
  }
}

const PRESERVE_HINT =
  '保住自己文件的办法有三：① 把自己的 unit 挪到别的文件名，本包只写 `unit` 指定的这一份；' +
  '② 在 unit 前几行加 `# managed by dp` 注释，表示你接受 dp 管理它；' +
  '③ 确知要覆盖就配 `force: true` —— 仍会先备份成 `<unit>.dp-backup`，不是直接抹掉'

/** 判定并抛错。不能覆盖时必须在**还没碰生效 unit** 的时候说清 */
function assertUnitOverwritable(existing: string | null, options: { readonly force?: boolean; readonly path: string }): SystemdOwnership {
  const decision = decideUnitOverwrite(existing, options)
  if (decision.action === 'abort') {
    throw new DpError(ERR.SYSD.UNIT_NOT_MANAGED, decision.reason, {
      path: options.path,
      hint: PRESERVE_HINT,
    })
  }
  return { action: decision.action, reason: decision.reason, backup: decision.backup }
}

/** 还原上一份 unit；首次部署则删掉本次写上去的那份，让 unitDir 回到部署前 */
async function restoreUnit(session: Session): Promise<void> {
  const { runner, paths } = session
  if ((await runner.stat(paths.backup)) === null) await runner.remove(paths.file)
  else await runner.rename(paths.backup, paths.file)
}

// 一次执行的上下文

class Session {
  readonly paths: UnitPaths
  readonly steps: SystemdStepTrace[] = []
  readonly warnings: string[] = []
  private readonly undo: UndoEntry[] = []
  private daemonReloaded = false
  private unitRestarted = false
  private unitEnabled = false

  constructor(
    readonly input: SystemdExecInput,
    private readonly phase: SystemdPhase,
  ) {
    this.paths = unitPaths(input.ctx, input.config)
  }

  get runner(): Runner {
    return this.input.runner
  }

  get ctx(): TargetContext {
    return this.input.ctx
  }

  get config(): SystemdTargetConfig {
    return this.input.config
  }

  get dryRun(): boolean {
    return this.input.dryRun === true
  }

  get timeoutMs(): number {
    return this.input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** 唯一的 exec 出口：timeoutMs 必填，stdin 永不带（铁律 0） */
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

  reloaded(): void {
    this.daemonReloaded = true
  }

  restarted(): void {
    this.unitRestarted = true
  }

  enabledUnit(): void {
    this.unitEnabled = true
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
    const failure: SystemdExecFailure = {
      phase: this.phase,
      step: step.id,
      host: this.ctx.host,
      file: this.paths.file,
      steps: [...this.steps],
      compensated: report.done,
      compensationErrors: report.errors,
      ...(options.output !== undefined ? { output: options.output } : {}),
    }
    throw new DpError(code, message, {
      path: options.path ?? 'projects.*.target.systemd',
      ...(hint !== undefined ? { hint } : {}),
      cause: failure,
    })
  }

  result(
    phase: SystemdPhase,
    plan: readonly Step[],
    ownership?: SystemdOwnership,
  ): SystemdExecResult {
    // 计划里有的步骤必须都被走一遍（dryRun 下也产出 skipped 的那条）。
    const planned = plan.map((step) => step.id)
    const ran = new Set(this.steps.map((step) => step.id))
    const missing = planned.filter((id) => !ran.has(id))
    if (missing.length > 0) {
      throw new DpError(ERR.SYSD.UNIT_INVALID, `执行器漏掉了计划里的步骤：${missing.join(', ')}`, {
        hint: '执行器与 target.ts 的步骤 id 不一致。这是代码错误，不是部署失败',
      })
    }
    return {
      ok: true,
      phase,
      host: this.ctx.host,
      releaseId: this.ctx.releaseId,
      file: this.paths.file,
      unitName: this.paths.unitName,
      ...(ownership !== undefined ? { ownership } : {}),
      dryRun: this.dryRun,
      reloaded: this.daemonReloaded,
      restarted: this.unitRestarted,
      enabled: this.unitEnabled,
      warnings: [...this.warnings],
      steps: [...this.steps],
    }
  }
}

// ① install：渲染 + 影子校验，**完全不碰生效 unit**

/**
 * ① install：渲染 → 写影子候选 → `systemd-analyze verify`。**完全不碰 unitDir 里正在生效的文件**。
 *
 * 影子目录之所以落在**临时目录**而不是 unitDir 之下：systemd 会递归扫描 unit 路径，
 * unitDir 下的任何 `.service` 都会被当作 unit 加载 —— 把候选放那儿等于往机器里塞
 * 一份同名的重复 unit，冲突与否取决于扫描顺序，是纯粹的自我干扰。
 *
 * @param input 见 SystemdExecInput
 * @returns 阶段结论；ownership 带判定结果
 * @throws DpError `DP.SYSD.UNIT_NOT_MANAGED` —— 目标 unit 存在、不带 managed 标记、也没 force
 * @throws DpError `DP.SYSD.UNIT_INVALID` —— unit 名或某个值不合法
 * @throws DpError `DP.SYSD.TEST_FAILED` —— `systemd-analyze verify` 不过，候选仍在影子里
 */
export async function installSystemd(input: SystemdExecInput): Promise<SystemdExecResult> {
  const session = new Session(input, 'install')
  const plan = systemdTarget.planInstall(session.ctx, session.config)

  // 判定排在任何写入之前：拿不到归属就别建影子目录
  const existing = await readUnitIfExists(session)
  const ownership = assertUnitOverwritable(existing, {
    ...(session.config.force !== undefined ? { force: session.config.force } : {}),
    path: 'projects.*.target.systemd',
  })

  const renderStep = stepAt(plan, 'systemd.render')
  session.begin(renderStep)
  const content = renderUnitFor(session.ctx, session.config)
  session.pass(renderStep)

  const writeStep = stepAt(plan, 'systemd.write-candidate')
  session.begin(writeStep)
  await mkdirTracked(session, session.paths.shadowDir, session.paths.shadowRoot)
  await session.runner.writeFile(session.paths.candidate, content, { mode: UNIT_MODE })
  if (session.dryRun) session.skip(writeStep)
  else session.pass(writeStep)

  const checkStep = stepAt(plan, 'systemd.validate-shadow')
  session.begin(checkStep)
  const argv = argvOf(stepAt(plan, 'systemd.validate-shadow'))
  const check = await session.exec(argv)
  if (check.code !== 0) {
    return session.fail(checkStep, ERR.SYSD.TEST_FAILED, `候选 unit 过不了 systemd-analyze verify（退出码 ${check.code}）`, {
      output: outputOf(check),
      hint: (report) =>
        `${compensationSuffix(report)}unitDir 里的 ${session.paths.file} 没被碰过，` +
        '机器上生效的仍是部署前那份 unit。上面是 systemd 的原话，按它指的行去改配置',
    })
  }
  session.pass(checkStep)

  if (session.dryRun) {
    // dryRun 承诺「磁盘上什么都没留下」：影子目录撤掉
    const report = await session.unwind()
    for (const err of report.errors) session.warnings.push(`影子目录清理失败（dryRun 应无残留）：${err}`)
  } else {
    // 影子目录留着：它就是同一版本再跑一次 install 时的覆盖目标，留着才能幂等
    session.commit()
  }

  return session.result('install', plan, ownership)
}

// ② activate：备份 → 原子替换 → daemon-reload → restart

/**
 * ② activate：备份 → 原子替换 → daemon-reload → restart。**唯一会动生效 unit** 的阶段。
 *
 * 顺序不是随手排的：先备份再替换，替换走「写中间文件 + rename」（rename 在同一目录
 * 内是原子的，直接 writeFile 会让 systemd 有机会读到写了一半的文件）；替换完必须先
 * `daemon-reload`，否则 systemctl 用的还是它缓存里的旧 unit，restart 起的是旧配置 ——
 * 症状是「部署报成功，但行为没变」，而这种症状最难往 unit 缓存上想。
 *
 * @param input 见 SystemdExecInput
 * @returns 阶段结论；`reloaded` / `restarted` 只在真发过且成功时为真
 * @throws DpError `DP.SYSD.UNIT_NOT_MANAGED` —— 目标 unit 存在、不带 managed 标记、也没 force
 * @throws DpError `DP.SYSD.DAEMON_RELOAD_FAILED` —— unit 已落盘但 systemd 没读到，
 * 机器仍在跑旧 unit；不回滚（盘上这份是好的）
 * @throws DpError `DP.SYSD.ENABLE_FAILED` —— 服务在跑，但开机自启那条软链没建上
 * （重启后它不会自己起来）；不回滚，理由同上
 * @throws DpError `DP.SYSD.RESTART_FAILED` —— unit 已生效、服务起不来；不回滚，
 * 理由同 nginx 的 reload 失败：为一个服务问题退掉一次成功的发布，只会把一件事变成两件
 */
export async function activateSystemd(input: SystemdExecInput): Promise<SystemdExecResult> {
  const session = new Session(input, 'activate')
  const plan = systemdTarget.planActivate(session.ctx, session.config)

  const existing = await readUnitIfExists(session)
  const ownership = assertUnitOverwritable(existing, {
    ...(session.config.force !== undefined ? { force: session.config.force } : {}),
    path: 'projects.*.target.systemd',
  })

  const content = renderUnitFor(session.ctx, session.config)

  const backupStep = stepAt(plan, 'systemd.backup')
  session.begin(backupStep)
  if (ownership.backup && !session.dryRun) {
    // 备份只留上一份：回滚要的是「上一次生效的那份」，不是历史链
    await session.runner.rename(session.paths.file, session.paths.backup)
    session.pushUndo(`rename ${session.paths.backup} → ${session.paths.file}`, () => restoreUnit(session))
    session.pass(backupStep)
  } else {
    // dryRun 与「本来就没有上一份」都记 skipped —— 这一步在机器上没留下任何东西
    session.skip(backupStep)
  }

  const replaceStep = stepAt(plan, 'systemd.replace')
  session.begin(replaceStep)
  if (session.dryRun) {
    session.skip(replaceStep)
  } else {
    await session.runner.writeFile(session.paths.newFile, content, { mode: UNIT_MODE })
    session.pushUndo(`删除中间文件 ${session.paths.newFile}`, () =>
      session.runner.remove(session.paths.newFile),
    )
    await session.runner.rename(session.paths.newFile, session.paths.file)
    session.pass(replaceStep)
  }

  const reloadStep = stepAt(plan, 'systemd.daemon-reload')
  session.begin(reloadStep)
  if (session.dryRun) {
    session.skip(reloadStep)
  } else {
    const reloaded = await session.exec(argvOf(reloadStep))
    if (reloaded.code !== 0) {
      return session.fail(reloadStep, ERR.SYSD.DAEMON_RELOAD_FAILED, `systemctl daemon-reload 失败（退出码 ${reloaded.code}）`, {
        output: outputOf(reloaded),
        hint: (report) =>
          `${compensationSuffix(report)}${session.paths.file} 已经在盘上，但 systemd 还没读到它，` +
          '机器上生效的仍是上一份 unit。原话见上，通常是 unit 本身的语法问题或权限问题；' +
          '改完重新部署即可 —— 不需要手工还原，备份还在',
      })
    }
    session.pass(reloadStep)
    session.reloaded()
  }

  // 到这一步 unit 已经被 systemd 接受，替换落定。
  session.commit()

  const enableStep = plan.find((step) => step.id === 'systemd.enable')
  if (enableStep !== undefined) {
    session.begin(enableStep)
    if (session.dryRun) {
      session.skip(enableStep)
    } else {
      const enabled = await session.exec(argvOf(enableStep))
      if (enabled.code !== 0) {
        return session.fail(enableStep, ERR.SYSD.ENABLE_FAILED, `systemctl enable ${session.paths.unitName} 失败（退出码 ${enabled.code}）`, {
          output: outputOf(enabled),
          hint:
            '服务本身没受影响 —— unit 已落盘、daemon-reload 已过，缺的只是 WantedBy 那条软链，' +
            '也就是**这台机器重启后服务不会自己起来**。' +
            '常见原因是 wants 目录不可写（system scope 要提权，看 hosts.<主机>.become）或 ' +
            `${session.config.wantedBy ?? 'multi-user.target'} 在这台机器上不存在。` +
            '修好后再部署一次即可；确实不该开机自启就把 projects.*.target.systemd.enabled 设成 false',
        })
      }
      session.pass(enableStep)
      session.enabledUnit()
    }
  }

  const restartStep = stepAt(plan, 'systemd.restart')
  session.begin(restartStep)
  if (session.dryRun) {
    session.skip(restartStep)
  } else {
    const restarted = await session.exec(argvOf(restartStep))
    if (restarted.code !== 0) {
      return session.fail(restartStep, ERR.SYSD.RESTART_FAILED, `systemctl restart ${session.paths.unitName} 失败（退出码 ${restarted.code}）`, {
        output: outputOf(restarted),
        hint: (report) =>
          `${compensationSuffix(report)}unit 已经落盘并生效，只是服务没起来 —— ` +
          '机器现在的状态是「新 unit + 无服务」。按上面的原话排查服务自身（端口占用、' +
          '可执行权限、工作目录是否存在都是这一类），修好后再跑一次部署或直接重启该 unit。' +
          '**不用回滚** —— 退掉 unit 也换不回服务，还会让现场更难判断',
      })
    }
    session.pass(restartStep)
    session.restarted()
  }

  return session.result('activate', plan, ownership)
}

// ③ verify：断言 unit 处于 active

/**
 * ③ verify：断言 unit 处于 `active`。
 *
 * 不用 `systemctl status` 判：它的退出码在 unit 不活跃时非 0，但它同时会把大量无关
 * 状态行打进 stderr，混在错误信息里反而看不清；`is-active` 只回答「活不活」这一个问题。
 *
 * @param input 见 SystemdExecInput
 * @returns 阶段结论
 * @throws DpError `DP.SYSD.NOT_ACTIVE` —— unit 不是 active（含 not-found）
 */
export async function verifySystemd(input: SystemdExecInput): Promise<SystemdExecResult> {
  const session = new Session(input, 'verify')
  const plan = systemdTarget.planVerify(session.ctx, session.config)

  const step = stepAt(plan, 'systemd.is-active')
  session.begin(step)
  const result = await session.exec(argvOf(step))
  if (result.code !== 0) {
    const state = excerptOutput(result.stdout) || excerptOutput(result.stderr) || '(无输出)'
    return session.fail(step, ERR.SYSD.NOT_ACTIVE, `unit ${session.paths.unitName} 不是 active：${state}`, {
      output: outputOf(result),
      hint:
        `systemctl is-active 报的是 ${state}。` +
        '常见三种：① not-found —— unit 没写进 unitDir，或 daemon-reload 没跑到；' +
        '② failed —— 服务起来了又退了，看 journalctl -u 拿退出原因；' +
        '③ activating —— 还没就绪，把 activation.trialTimeout 调大再试',
    })
  }
  session.pass(step)

  return session.result('verify', plan)
}

// ④ rollback：还原备份 unit → daemon-reload → restart → 复验

/**
 * ④ rollback：还原备份 unit → daemon-reload → restart → 复验。
 *
 * @param input 见 SystemdExecInput；`ctx.previousReleaseId` 缺失时计划期就抛错
 * @returns 阶段结论
 * @throws DpError `DP.SYSD.NO_PREVIOUS` —— 备份 unit 不存在。首次部署没有上一份可还原，
 * 此时**不**返回「回滚成功」这种假结果
 * @throws DpError `DP.SYSD.DAEMON_RELOAD_FAILED` —— 已还原但 systemd 没读到
 * @throws DpError `DP.SYSD.RESTART_FAILED` —— 已还原且已生效，服务没起来
 * @throws DpError `DP.SYSD.NOT_ACTIVE` —— 重启后复验仍不活跃
 */
export async function rollbackSystemd(input: SystemdExecInput): Promise<SystemdExecResult> {
  const session = new Session(input, 'rollback')
  const plan = systemdTarget.planRollback(session.ctx, session.config)

  const restoreStep = stepAt(plan, 'systemd.restore-backup')
  session.begin(restoreStep)
  if ((await session.runner.stat(session.paths.backup)) === null) {
    return session.fail(restoreStep, ERR.SYSD.NO_PREVIOUS, `没有可还原的备份：${session.paths.backup} 不存在`, {
      hint:
        '首次部署没有上一份 unit 可回滚，本包不会返回「回滚成功」这种假结果。' +
        '确实要撤掉这次部署的话，手动删除该 unit 后 daemon-reload —— 备份只在上一次替换时才产生',
    })
  }
  await session.runner.rename(session.paths.backup, session.paths.file)
  session.pass(restoreStep)

  const reloadStep = stepAt(plan, 'systemd.daemon-reload-rollback')
  session.begin(reloadStep)
  const reloaded = await session.exec(argvOf(reloadStep))
  if (reloaded.code !== 0) {
    return session.fail(reloadStep, ERR.SYSD.DAEMON_RELOAD_FAILED, `还原后 systemctl daemon-reload 失败（退出码 ${reloaded.code}）`, {
      output: outputOf(reloaded),
      hint: (report) =>
        `${compensationSuffix(report)}${session.paths.file} 已还原成上一份，但 systemd 还没读到它。` +
        '原话见上，修好后重跑 daemon-reload 即可 —— 备份已被 rename 消耗，没有第二份可退',
    })
  }
  session.pass(reloadStep)
  session.reloaded()

  const restartStep = stepAt(plan, 'systemd.restart-rollback')
  session.begin(restartStep)
  const restarted = await session.exec(argvOf(restartStep))
  if (restarted.code !== 0) {
    return session.fail(restartStep, ERR.SYSD.RESTART_FAILED, `还原后 systemctl restart ${session.paths.unitName} 失败（退出码 ${restarted.code}）`, {
      output: outputOf(restarted),
      hint:
        `unit 已还原成上一份并完成了 daemon-reload，只是服务还没起来。` +
        '按上面的原话排查服务自身，修好后手动重跑同一条 restart 命令即可收敛',
    })
  }
  session.pass(restartStep)
  session.restarted()

  const verifyStep = stepAt(plan, 'systemd.is-active-rollback')
  session.begin(verifyStep)
  const checked = await session.exec(argvOf(verifyStep))
  if (checked.code !== 0) {
    const state = excerptOutput(checked.stdout) || excerptOutput(checked.stderr) || '(无输出)'
    return session.fail(verifyStep, ERR.SYSD.NOT_ACTIVE, `回滚后 unit ${session.paths.unitName} 不是 active：${state}`, {
      output: outputOf(checked),
      hint:
        '回滚本身已经完成（unit 已是上一份、服务也重启过），只是它没活下来 —— ' +
        '也就是**上一版的服务本来就是坏的**。这种情况再退一版未必更好，' +
        '先看 journalctl -u 确认原因，再决定是修配置还是手动指定某个历史版本',
    })
  }
  session.pass(verifyStep)

  return session.result('rollback', plan)
}

/** 从计划里取步骤；缺了就是代码错误而不是部署失败 */
function stepAt(plan: readonly Step[], id: string): Step {
  const found = plan.find((step) => step.id === id)
  if (found !== undefined) return found
  throw new DpError(ERR.SYSD.UNIT_INVALID, `计划里没有步骤 ${id}`, {
    hint: '改 target.ts 的步骤时必须同步改执行器：少走一步在这里的表现是「部署看起来成功了」',
  })
}

/** 补偿结果拼成给用户看的一句话。原错误始终在前，补偿只是附加信息 */
function compensationSuffix(report: UnwindReport): string {
  if (report.errors.length > 0) {
    return `【补偿未完全成功，以下副作用留在机器上，需人工处理：${report.errors.join('；')}】`
  }
  if (report.done.length === 0) return '【本次没有需要收回的动作】'
  return `【已收回：${report.done.join('；')}】`
}

/**
 * 从 `DpError.cause` 里认出本执行器留下的失败现场。
 *
 * @param value `err.cause`，来源不可控，什么都可能是
 * @returns 是本包的失败现场（`SystemdExecFailure`）；其它来源一律 `false`
 */
export function isSystemdExecFailure(value: unknown): value is SystemdExecFailure {
  if (typeof value !== 'object' || value === null) return false
  const record: Record<string, unknown> = { ...(value as Record<string, unknown>) }
  return (
    typeof record['step'] === 'string' &&
    Array.isArray(record['steps']) &&
    Array.isArray(record['compensated']) &&
    Array.isArray(record['compensationErrors'])
  )
}
