import { ERR, DpError, RELEASES_DIR_NAME, joinRemotePath, type Step, type Target, type TargetContext } from '@dp/ports'
import { renderString } from '@dp/template'
import { renderUnit } from './unit.js'
import type { SystemdTargetConfig } from './types.js'

const BACKUP_SUFFIX = '.dp-backup'
const NEW_SUFFIX = '.dp-new'

/**
 * unit 在目标机上的落点。**全是 ctx 的纯函数** —— 影子目录也落在 release 目录下，
 * 所以 plan 与执行器算出的路径逐字相同，不存在「计划里一条、真跑是另一条」的分叉。
 *
 * 影子目录**不能**落在 unitDir 之下：systemd 会递归扫描 unit 路径，unitDir 里的任何
 * `.service` 都会被当成 unit 加载 —— 把候选放那儿等于往机器里塞一份同名重复 unit，
 * 冲突与否取决于扫描顺序，是纯粹的自我干扰。
 */
export interface UnitPaths {
  /** unit 文件名，含 `.service` */
  readonly unitName: string
  /** `<unitDir>/<unitName>` */
  readonly file: string
  /** `<release 目录>/.dp`：可写性已由 deploy 实证，且远离 unitDir */
  readonly shadowRoot: string
  readonly shadowDir: string
  readonly candidate: string
  readonly backup: string
  /** 替换用的中间文件。必须落在 unitDir 内，见 planActivate 的 replace 步骤 */
  readonly newFile: string
  /** `systemctl` 的范围选项：user scope 是 `['--user']`，system scope 为空 */
  readonly scopeArgv: readonly string[]
}

/**
 * 本次 unit 操作涉及的全部路径。**一处算好，全程复用** ——
 * 候选、备份、替换的中间文件分别落在 shadow 目录与 unitDir 里（`candidate` 落在
 * 发布根目录之下是因为 unitDir 常常是不可随意写的系统目录，而 rename 换生效必须同盘同目录）。
 *
 * @param ctx 发布上下文
 * @param config systemd 段（`unitDir` 与可选的 `unit`）
 * @returns 见 `UnitPaths`
 * @throws DpError `DP.SYSD.UNIT_INVALID` —— `unitDir` 不是绝对路径，或 `unit` 含目录分隔符
 */
export function unitPaths(ctx: TargetContext, config: SystemdTargetConfig): UnitPaths {
  assertUnitDir(config.unitDir)
  const unitName = resolveUnitName(ctx, config)
  const file = joinRemotePath(config.unitDir.replace(/\/+$/, ''), unitName)
  const releaseDir = joinRemotePath(ctx.root.replace(/\/+$/, ''), RELEASES_DIR_NAME, ctx.releaseId)
  const shadowRoot = joinRemotePath(releaseDir, '.dp')
  return {
    unitName,
    file,
    shadowRoot,
    shadowDir: joinRemotePath(shadowRoot, ctx.releaseId),
    candidate: joinRemotePath(shadowRoot, ctx.releaseId, unitName),
    backup: `${file}${BACKUP_SUFFIX}`,
    newFile: `${file}${NEW_SUFFIX}`,
    scopeArgv: config.scope === 'user' ? ['--user'] : [],
  }
}

const UNIT_PATH = 'projects.*.target.systemd.unit'
const UNIT_DIR_PATH = 'projects.*.target.systemd.unitDir'

/**
 * unit 文件名。**不含目录** —— 带分隔符就能写到 unitDir 之外去。
 *
 * @param ctx 发布上下文，仅在 `unit` 缺省时用于按项目名推导
 * @param config systemd 段
 * @returns 以 `.service` 结尾的 unit 文件名
 * @throws DpError `DP.SYSD.UNIT_INVALID` —— 含分隔符、是 `.` / `..`、不以 `.service` 结尾、
 * 或省略且渲染上下文里没有 project 可推导
 */
function resolveUnitName(ctx: TargetContext, config: SystemdTargetConfig): string {
  let name: string
  if (config.unit === undefined) {
    const project = config.render.project
    if (project === '') {
      throw new DpError(
        ERR.SYSD.UNIT_INVALID,
        '未配置 unit 名，且渲染上下文里没有 project 可用来推导',
        {
          path: UNIT_PATH,
          hint: '显式写一个 unit 名，或让调用方把 project 放进渲染上下文（默认名是 `<项目名>.service`）',
        },
      )
    }
    name = `${project}.service`
  } else {
    name = renderString(config.unit, config.render, { usage: 'conf', path: UNIT_PATH }).trim()
    if (name === '') {
      throw new DpError(ERR.SYSD.UNIT_INVALID, 'unit 名是空白字符串', {
      path: UNIT_PATH,
      hint: '删掉这个字段表示用默认值 `<项目名>.service`；写成空白等于要求一个没有名字的 unit 文件',
      })
    }
  }

  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') {
    throw new DpError(ERR.SYSD.UNIT_INVALID, `unit 名不是单个文件名：${name}`, {
      path: UNIT_PATH,
      hint: '它会被拼到 unitDir 后面，带路径分隔符就意味着能写到 unitDir 之外。要写到别的目录请另开一个 target',
    })
  }
  if (!name.endsWith('.service')) {
    throw new DpError(ERR.SYSD.UNIT_INVALID, `unit 名必须以 .service 结尾：${name}`, {
      path: UNIT_PATH,
      hint: '本包只管 service unit —— timer / socket / path 的生命周期语义各不相同，' +
        '套进同一套 install/activate/verify 只会得到看起来能跑、实则语义错的实现',
    })
  }
  return name
}

/**
 * unitDir 必须是目标机绝对路径且不含 `..`。
 *
 * unit 是 systemd 会以 root 执行的文件，落点写错的代价不是「部署失败」而是「机器被接管」，
 * 所以这条不靠约定靠拒绝。
 *
 * @param path 待判定的目录
 * @throws DpError `DP.SYSD.UNIT_INVALID` —— 不是可信的目标机绝对路径
 */
function assertUnitDir(path: string): void {
  const escaped = path.split('/').some((segment) => segment === '..')
  if (!escaped && path.startsWith('/')) return
  throw new DpError(ERR.SYSD.UNIT_INVALID, `unitDir 不是可信的目标机绝对路径：${path}`, {
    path: UNIT_DIR_PATH,
    hint: '写以 / 开头的绝对路径且不含 `..`。它由上层从 layout 推导后注入，不是用户随手填的相对路径',
  })
}

/**
 * `systemctl` 的 argv。范围选项（`--user`）必须紧跟子命令之前，
 * 且**只从 `paths` 取** —— 每处各拼一次迟早会漏掉 user scope。
 *
 * @param paths `unitPaths()` 的结果
 * @param args 子命令与参数，如 `['restart', unit]`
 * @returns 完整 argv
 */
export function systemctlArgv(paths: UnitPaths, ...args: readonly string[]): readonly string[] {
  return ['systemctl', ...paths.scopeArgv, ...args]
}

/**
 * `systemd-analyze verify` 的 argv。**验的是候选文件而不是生效文件** ——
 * 让一份写坏的 unit 先生效再报错，代价是服务已经停了。
 *
 * @param paths `unitPaths()` 的结果
 * @param candidate shadow 目录里的候选文件路径
 * @returns 完整 argv
 */
export function analyzeVerifyArgv(paths: UnitPaths, candidate: string): readonly string[] {
  return ['systemd-analyze', ...paths.scopeArgv, 'verify', candidate]
}

/**
 * 这一步要不要进计划。**计划与执行器共用这一个判据** —— 两边各判一次，症状是
 * 「计划里有、执行器没跑」（`result()` 会报漏步骤）或反过来（执行器找不到这一步）。
 *
 * @param config systemd 段
 * @returns true 表示要 `systemctl enable`
 */
function shouldEnable(config: SystemdTargetConfig): boolean {
  return config.enabled !== false
}

/**
 * `systemctl enable` 的 argv。**幂等**：已经 enable 过的 unit 再跑一次仍返回 0。
 *
 * @param paths `unitPaths()` 的结果
 * @returns 完整 argv
 */
export function enableArgv(paths: UnitPaths): readonly string[] {
  return systemctlArgv(paths, 'enable', paths.unitName)
}

/**
 * 渲染 unit 全文的唯一出口。计划与执行都走它，保证两处内容逐字相同 ——
 * verify 阶段靠逐字比对判断「线上这份是不是 dp 写的」，出口分叉的话这个比对就没意义。
 *
 * @param ctx 发布上下文
 * @param config systemd 段
 * @returns unit 文件全文，首行是 managed 标记
 * @throws DpError `DP.SYSD.UNIT_INVALID` —— unit 名或值不合法
 */
export function renderUnitFor(ctx: TargetContext, config: SystemdTargetConfig): string {
  const paths = unitPaths(ctx, config)
  return renderUnit({
    config,
    unitName: paths.unitName,
    releaseId: ctx.releaseId,
    path: 'projects.*.target.systemd',
  })
}

const READ_ONLY_UNDO = '无需补偿：只解析或只读，不改任何文件'

/**
 * systemd 目标的 plan 侧。**纯函数**：不碰 runner、不发命令、不写文件。
 */
export const systemdTarget: Target<SystemdTargetConfig> = {
  type: 'systemd',

  /** ① 渲染 → 写影子候选 → `systemd-analyze verify`。**完全不碰 unitDir 里正在生效的文件** */
  planInstall(ctx, config): readonly Step[] {
    const paths = unitPaths(ctx, config)
    const argv = analyzeVerifyArgv(paths, paths.candidate)
    return [
      {
        id: 'systemd.render',
        kind: 'prepare',
        title: `渲染 unit（${paths.unitName}）`,
        host: ctx.host,
        undo: '无需补偿：渲染发生在本地，不产生任何目标机副作用',
      },
      {
        id: 'systemd.write-candidate',
        kind: 'install',
        title: `写候选 unit 到 ${paths.candidate}`,
        host: ctx.host,
        undo: `删除 ${paths.shadowDir}`,
      },
      {
        id: 'systemd.validate-shadow',
        kind: 'install',
        title: `影子校验：${argv.join(' ')}`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { argv, candidate: paths.candidate },
      },
    ]
  },

  /** ② 备份 → 原子替换 → daemon-reload → enable → restart。这是**唯一会动生效 unit** 的阶段 */
  planActivate(ctx, config): readonly Step[] {
    const paths = unitPaths(ctx, config)
    return [
      {
        id: 'systemd.backup',
        kind: 'activate',
        title: `备份现有 unit → ${paths.backup}`,
        host: ctx.host,
        undo: '无需补偿：备份只是新增一个文件，目标文件还没被挪走',
      },
      {
        id: 'systemd.replace',
        kind: 'activate',
        title: `原子替换 ${paths.file}`,
        host: ctx.host,
        undo: `还原 ${paths.backup} → ${paths.file}`,
        detail: { file: paths.file, newFile: paths.newFile },
      },
      {
        id: 'systemd.daemon-reload',
        kind: 'activate',
        title: '生效配置：systemctl daemon-reload',
        host: ctx.host,
        undo: '无需补偿：reload 只让 systemd 重读磁盘',
        detail: { argv: systemctlArgv(paths, 'daemon-reload') },
      },
      // enable 排在 daemon-reload 之后、restart 之前：systemd 要读过 unit 才知道
      // 它的 [Install] 段（enable 建的就是 WantedBy 那条软链），而 start/restart 与
      // 是否 enable 无关，先建软链再起服务不会留下「起了但没自启」的窗口
      ...(shouldEnable(config)
        ? [
            {
              id: 'systemd.enable',
              kind: 'activate' as const,
              title: `开机自启：systemctl enable ${paths.unitName}`,
              host: ctx.host,
              undo:
                '无需补偿：enable 只在 unit 目录之外（wants 目录）加一条软链，' +
                '撤掉它是 `systemctl disable`，而这台机器上服务本来就该是 enabled 的',
              detail: { argv: enableArgv(paths) },
            },
          ]
        : []),
      {
        id: 'systemd.restart',
        kind: 'activate',
        title: `重启服务：systemctl restart ${paths.unitName}`,
        host: ctx.host,
        undo:
          '无需补偿：unit 已落盘且已 daemon-reload，起不来是服务自身的问题；' +
          '再跑一次 restart 即可收敛，退回旧 unit 反而让现场更难判断',
        detail: { argv: systemctlArgv(paths, 'restart', paths.unitName) },
      },
    ]
  },

  /** ③ 断言 unit 处于 active */
  planVerify(ctx, config): readonly Step[] {
    const paths = unitPaths(ctx, config)
    return [
      {
        id: 'systemd.is-active',
        kind: 'verify',
        title: `断言服务存活：systemctl is-active ${paths.unitName}`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { argv: systemctlArgv(paths, 'is-active', paths.unitName) },
      },
    ]
  },

  /** ④ 还原备份 unit → daemon-reload → restart → 复验 */
  planRollback(ctx, config): readonly Step[] {
    const paths = unitPaths(ctx, config)
    return [
      {
        id: 'systemd.restore-backup',
        kind: 'activate',
        title: `rename ${paths.backup} → ${paths.file}（还原上一份 unit）`,
        host: ctx.host,
        undo: '撤销回退 = 再走一次 planInstall/planActivate 把本次 unit 写回去，然后 daemon-reload + restart',
        detail: { from: paths.backup, to: paths.file, previousReleaseId: ctx.previousReleaseId },
      },
      {
        id: 'systemd.daemon-reload-rollback',
        kind: 'activate',
        title: '生效配置：systemctl daemon-reload',
        host: ctx.host,
        undo: '无需补偿：reload 只让 systemd 重读磁盘',
        detail: { argv: systemctlArgv(paths, 'daemon-reload') },
      },
      {
        id: 'systemd.restart-rollback',
        kind: 'activate',
        title: `重启服务：systemctl restart ${paths.unitName}`,
        host: ctx.host,
        undo: '无需补偿：起不来是服务自身的问题，盘上的 unit 是好的',
        detail: { argv: systemctlArgv(paths, 'restart', paths.unitName) },
      },
      {
        id: 'systemd.is-active-rollback',
        kind: 'verify',
        title: `复验服务存活：systemctl is-active ${paths.unitName}`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { argv: systemctlArgv(paths, 'is-active', paths.unitName) },
      },
    ]
  },
}
