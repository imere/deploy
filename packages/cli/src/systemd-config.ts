import { ERR, DpError, type Facts, type TargetContext } from '@dp/ports'
import type { SystemdConfig } from '@dp/schema'
import type { SystemdScope, SystemdTargetConfig } from '@dp/target-systemd'
import { renderContextFor } from './render-context.js'

/**
 * 各 scope 的 unit 目录候选。**只列有依据的**：systemd 官方的两处默认落点。
 *
 * `user` scope 的那一处要靠 homedir 拼出来，所以它是函数而不是常量 ——
 * homedir 是探测结果，写死在表里就等于凭空断言每台机器的家目录都一样。
 */
const SYSTEM_UNIT_DIR = '/etc/systemd/system'

/** `user` scope 的候选。用 `facts.homedir`，探不到就不给候选（理由见 resolveUnitDir） */
function userUnitDir(facts: Facts): string | undefined {
  const home = facts.homedir.replace(/\/+$/, '')
  if (home === '' || home === '.') return undefined
  return `${home}/.config/systemd/user`
}

const UNIT_DIR_PATH = 'projects.*.target.systemd.unitDir'

/**
 * `resolveUnitDir` 真正要读的那两个字段。
 *
 * 收窄成局部形状而不是直接吃 `TargetConfig`，是因为 `unitDir` 在 schema 里是**可选**
 * （不给才轮到推导）：收窄之后「调用方没给 unitDir，由 facts 推导」这条路在类型上才成立，
 * 否则那两级推导只能靠 `as` 硬凑出来 —— 而凑出来的夹具证明不了函数真的处理了这种情况。
 * `TargetConfig` 结构上满足它，调用点不必改。
 */
export interface UnitDirSource {
  readonly systemd?: {
    readonly unitDir?: string
    readonly scope?: SystemdScope
  }
}

/**
 * unitDir 的来源，三级优先级：显式 > 实测可写的候选 > 报错。与 confd 的推导同构，
 * 但**故意不共用一个错误码**：confd 不可写是「nginx 的入口目录不可写」，
 * unitDir 不可写是「systemd 的单元目录不可写」，排查路径完全不同。
 *
 * @param input facts 与 target 段（显式 unitDir / scope 都从这里读）
 * @returns 目标机上的 unit 目录绝对路径
 * @throws DpError `DP.PERM.UNIT_DIR_NOT_WRITABLE` —— 显式没给，且没有实测可写的候选
 */
export function resolveUnitDir(input: { readonly facts: Facts; readonly target?: UnitDirSource }): string {
  const spec = input.target?.systemd
  const explicit = spec?.unitDir
  if (explicit !== undefined) return explicit

  const scope = spec?.scope ?? 'system'
  const candidates = unitDirCandidates(input.facts, scope)
  const canWrite = input.facts.capabilities.canWrite
  for (const path of candidates) {
    // 缺键与 false 同义：探测表里没有某个路径时，我们**不知道**它能不能写，
    // 而「不知道」当成「可能能写」去猜，落点就是一次以 root 执行的写入赌注
    if (canWrite[path] === true) return path
  }

  const note =
    candidates.length === 0
      ? `facts 里这台机器是 ${input.facts.platform}（scope=${scope}${scope === 'user' ? `，homedir=${input.facts.homedir === '' ? '未探测到' : input.facts.homedir}` : ''}），本仓对它没有可靠的 unit 目录默认值`
      : `已实测过 ${candidates.join(' | ')}，都不可写`

  throw new DpError(ERR.PERM.UNIT_DIR_NOT_WRITABLE, `推导不出可写的 systemd unit 目录：${note}`, {
    path: UNIT_DIR_PATH,
    hint:
      '两件事按顺序排查：① 这台机器的 unit 装在别处（发行版拆包、自建 rpm、非 root 的 systemd 实例）——' +
      '在 projects.<项目>.target.systemd.unitDir 显式写它的单元目录（必须是目标机绝对路径，不含 `..`）；' +
      '② 目录存在但不可写 —— 那是权限问题，给这台主机配 hosts.<主机>.become ' +
      '（免密 sudo / su / doas）让 dp 有权写。不要 chmod 777：unit 是 systemd 以 root 执行的文件，' +
      '把它交给任意本地用户写入等于把这台机器的启动项交出去。scope: user 的 unit 只在用户会话存活期间运行，' +
      'linger 没开的话人一注销服务就停 —— 要常驻就用 system scope 并配提权',
  })
}

/**
 * 该 scope 在这台机器上的候选目录。
 *
 * 非 linux 一律不给候选：systemd 的单元路径在 linux 上才有确定含义，
 * 而 `<homedir>/.config/systemd/user` 在没探到 homedir 时拼出来的只是 `/.config/systemd/user` ——
 * 报一个这样的路径不如报「推导不出来」。
 *
 * @param facts 目标机事实
 * @param scope systemd 段里的范围
 * @returns 按优先级排列的候选；空数组表示这台机器上没有可用的默认值
 */
function unitDirCandidates(facts: Facts, scope: 'system' | 'user'): readonly string[] {
  if (facts.platform !== 'linux') return []
  if (scope === 'user') {
    const dir = userUnitDir(facts)
    return dir === undefined ? [] : [dir]
  }
  return [SYSTEM_UNIT_DIR]
}

export interface SystemdTranslateInput {
  readonly project: string
  /** profile 名（`--env`）。没给就是空串：`${env}` 这时按缺值报错，而不是编一个出来 */
  readonly env: string
  readonly envVars: Readonly<Record<string, string | undefined>>
  readonly targetCtx: TargetContext
  readonly now: Date
  readonly systemd: SystemdConfig
  /** 推导出来的 unit 目录。目标机路径不是配置项，本函数只负责搬 */
  readonly unitDir: string
}

/**
 * schema 的 `target.systemd` → `@dp/target-systemd` 的 `SystemdTargetConfig`。
 *
 * 可选字段一律条件展开：塞 `undefined` 进去会让执行器的 `?? 默认值` 与渲染期的
 * 「未配置」两种语义在下游分不清 —— 而它们的处置方式并不相同。
 *
 * @param input 渲染上下文与已推导的 unitDir
 * @returns 执行器可直接消费的配置
 */
export function systemdConfigFor(input: SystemdTranslateInput): SystemdTargetConfig {
  const { systemd } = input
  return {
    unitDir: input.unitDir,
    execStart: systemd.execStart,
    render: renderContextFor(input),
    ...(systemd.unit !== undefined ? { unit: systemd.unit } : {}),
    ...(systemd.scope !== undefined ? { scope: systemd.scope } : {}),
    ...(systemd.description !== undefined ? { description: systemd.description } : {}),
    ...(systemd.execReload !== undefined ? { execReload: systemd.execReload } : {}),
    ...(systemd.workingDirectory !== undefined ? { workingDirectory: systemd.workingDirectory } : {}),
    ...(systemd.user !== undefined ? { user: systemd.user } : {}),
    ...(systemd.group !== undefined ? { group: systemd.group } : {}),
    ...(systemd.environment !== undefined ? { environment: systemd.environment } : {}),
    ...(systemd.restart !== undefined ? { restart: systemd.restart } : {}),
    ...(systemd.restartSec !== undefined ? { restartSec: systemd.restartSec } : {}),
    ...(systemd.after !== undefined ? { after: systemd.after } : {}),
    ...(systemd.requires !== undefined ? { requires: systemd.requires } : {}),
    ...(systemd.wantedBy !== undefined ? { wantedBy: systemd.wantedBy } : {}),
    ...(systemd.enabled !== undefined ? { enabled: systemd.enabled } : {}),
    ...(systemd.extra !== undefined ? { extra: systemd.extra } : {}),
  }
}
