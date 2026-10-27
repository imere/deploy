import { ERR, DpError, MANAGED_MARKER } from '@dp/ports'
import { renderString, type RenderContext } from '@dp/template'
import type { SystemdTargetConfig } from './types.js'

export { isManaged, MANAGED_MARKER } from '@dp/ports'

/**
 * unit 的值里不许出现的字符。
 *
 * unit 是「一行一条指令」的格式：一行的边界就是指令的边界。值里带换行等于凭空多出
 * 几条 `ExecStart=` / `User=` —— 那不是配置，是指令注入。其余控制字符同理，一律在
 * **渲染期**拒掉：早于落盘，零副作用。
 */
// eslint-disable-next-line no-control-regex -- 这条规则防的是「正则里混进控制字符」，而这里要找的就是控制字符本身
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/**
 * `renderUnit` 的输入。unit 正文**全部来自 `config`**，另三项是渲染期要用的上下文：
 * `unitName` 由 layout 推出来（不把用户输入直接当文件名）、`releaseId` 用来挡
 * 「把 ExecStart 钉死在某版本目录」、`path` 让错误指回具体配置项。
 */
export interface UnitRenderInput {
  readonly config: SystemdTargetConfig
  /** unit 文件名（含 `.service`）。由 layout 推导，不是用户原样输入 */
  readonly unitName: string
  /** 本次部署的版本号。用来挡住把 unit 钉死在某一个版本目录上的写法 */
  readonly releaseId: string
  /** 出错时定位到具体配置项 */
  readonly path: string
}

/**
 * 渲染一段模板并挡住控制字符。
 *
 * @param template 用户写的模板原文；undefined 表示「不输出这一行」
 * @param ctx 渲染上下文
 * @param path 出错时定位的配置路径
 * @returns 渲染后的值
 * @throws DpError `DP.SYSD.UNIT_INVALID` —— 渲染结果含控制字符；模板语法错误原样透传
 */
function renderValue(
  template: string | undefined,
  ctx: RenderContext,
  path: string,
): string | undefined {
  if (template === undefined) return undefined
  const value = renderString(template, ctx, { usage: 'conf', path })
  if (CONTROL_CHARS.test(value)) {
    throw new DpError(ERR.SYSD.UNIT_INVALID, `渲染结果含控制字符：${JSON.stringify(value).slice(0, 80)}`, {
      path,
      hint:
        'unit 是「一行一条指令」的格式，值里的换行会变成额外的 unit 指令（比如再插一条 ExecStart=）。' +
        '去掉这些字符，或把多行内容拆成 `extra` 的多个元素',
    })
  }
  return value
}

/**
 * `Environment=` 的值。按 systemd 的规则转义：`\` 与 `"` 前加反斜杠，其余原样。
 *
 * 不额外再套一层引号的理由：套了也躲不掉值里自带引号造成的截断（那只能靠转义），
 * 而转义与外引号并用会让解析结果依赖具体的 systemd 版本。
 */
function envValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * 渲染一份 unit 文件。纯函数。
 *
 * 输出顺序固定：`[Unit]` → `[Service]` → `[Install]` → `extra`。固定顺序换来的是
 * 同一份配置在两台机器上产出**逐字相同**的文件 —— verify 阶段靠逐字比对判断
 * 「线上这份是不是 dp 写的」，顺序不稳定的话这个比对就失去意义。
 *
 * @param input 配置、unit 名与本次版本号
 * @returns unit 文件的完整内容，首行是 managed 标记
 * @throws DpError `DP.SYSD.UNIT_INVALID` —— 值含控制字符，或 unit 把路径钉死在本次版本目录上
 */
export function renderUnit(input: UnitRenderInput): string {
  const { config } = input
  const lines: string[] = [MANAGED_MARKER]

  lines.push('[Unit]')
  const description = renderValue(config.description, config.render, `${input.path}.description`)
  lines.push(`Description=${description ?? describeUnit(input.unitName)}`)
  const after = config.after?.map((item) => renderString(item, config.render, { usage: 'conf', path: `${input.path}.after` }))
  if (after !== undefined && after.length > 0) lines.push(`After=${after.join(' ')}`)
  const requires = config.requires?.map((item) => renderString(item, config.render, { usage: 'conf', path: `${input.path}.requires` }))
  if (requires !== undefined && requires.length > 0) lines.push(`Requires=${requires.join(' ')}`)
  lines.push('')

  lines.push('[Service]')
  lines.push('Type=simple')
  for (const key of ['user', 'group', 'workingDirectory'] as const) {
    const raw = config[key]
    if (raw === undefined) continue
    const label = key === 'workingDirectory' ? 'WorkingDirectory' : capitalize(key)
    lines.push(`${label}=${renderValue(raw, config.render, `${input.path}.${key}`) ?? ''}`)
  }
  if (config.environment !== undefined) {
    for (const [key, raw] of Object.entries(config.environment)) {
      const value = renderString(raw, config.render, { usage: 'conf', path: `${input.path}.environment.${key}` })
      lines.push(`Environment="${key}=${envValue(value)}"`)
    }
  }
  lines.push(`ExecStart=${renderValue(config.execStart, config.render, `${input.path}.execStart`) ?? ''}`)
  const execReload = renderValue(config.execReload, config.render, `${input.path}.execReload`)
  if (execReload !== undefined) lines.push(`ExecReload=${execReload}`)
  lines.push(`Restart=${config.restart ?? 'on-failure'}`)
  if (config.restartSec !== undefined) lines.push(`RestartSec=${config.restartSec}`)
  lines.push('')

  lines.push('[Install]')
  lines.push(`WantedBy=${config.wantedBy ?? 'multi-user.target'}`)
  lines.push('')

  for (const line of config.extra ?? []) {
    if (CONTROL_CHARS.test(line)) {
      throw new DpError(ERR.SYSD.UNIT_INVALID, `extra 的行含控制字符：${JSON.stringify(line).slice(0, 80)}`, {
        path: `${input.path}.extra`,
        hint: 'extra 是逐行原样输出的逃生舱；一行里带换行等于多出几条 unit 指令 —— 那不是逃生舱，是指令注入口',
      })
    }
    lines.push(line)
  }

  const text = lines.join('\n')
  return text
}

function describeUnit(unitName: string): string {
  const base = unitName.replace(/\.service$/, '')
  return base === '' ? 'dp-managed service' : base
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
