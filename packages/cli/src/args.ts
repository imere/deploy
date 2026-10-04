/**
 * argv → 结构化结果。**纯函数**，零 IO。
 *
 * 为什么不用 yargs / commander：
 *  ① 铁律 3 —— 依赖只允许 workspace 包。多一个运行时依赖就要多一份供应链与
 *     升级节奏，而这个包的全部解析需求就是「长选项 + 短选项 + `--`」这一档。
 *  ② 未知选项必须**报错**而不是被库静默吞掉（歧义靠拒绝）。主流库默认要么
 *     放行未知项、要么把容错藏在回调里，我们要「给错名字立刻指出是哪一项」，
 *     这个行为自己写更好断言。
 *  ③ 纯函数可 100% 单测：不需要起子进程就能断言每一种写法。
 */
import { DpError } from '@dp/ports'

/**
 * 用法/参数错误。
 *
 * 为什么需要这个子类：`DpErrorCode` 是 @dp/ports 的封闭联合，**不允许**在 CLI
 * 里加新码（改 ports 属于跨包改动），而 `CONFIG_INVALID` 同时覆盖「命令行写错」
 * 和「配置文件写错」两种完全不同的失败 —— 退出码不一样（用法错退 2、配置错退 3），CI 也要区别对待。所以用法错误靠**类型**区分，不靠码。
 */
export class CliUsageError extends DpError {
  constructor(message: string, options: { readonly path?: string; readonly hint?: string } = {}) {
    super('DP.CONFIG.INVALID', message, options)
    this.name = 'CliUsageError'
  }
}

export function isUsageError(err: unknown): boolean {
  return err instanceof CliUsageError
}

export interface ParsedArgs {
  /** 没有命令时是 undefined（`dp` 单独跑 → 打印根帮助） */
  readonly command: string | undefined
  readonly flags: Readonly<Record<string, string | boolean>>
  /** 命令之后的位置参数 */
  readonly positional: readonly string[]
}

/** 不吃值的开关。给它们加 `--x=1` 是用户的错，静默忽略反而会让人以为生效了 */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'help',
  'version',
  'verbose',
  'quiet',
  'json',
  'all',
  'dry-run',
  // 只对 `dp deploy` 有意义：零配置下的配置是探测出来的，`--yes` 表达的是
  // 「接受上面这份自动决定」。apply 刻意不给它 —— 那里有用户写好的配置。
  'yes',
])

export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  'config',
  'env',
  'host',
  'project',
  'facts',
  'out',
  'log-format',
  'log-level',
  'log-file',
])

/** 短选项 → 长选项。只留真正高频的 */
export const SHORT_FLAGS: Readonly<Record<string, string>> = {
  c: 'config',
  v: 'verbose',
  q: 'quiet',
  h: 'help',
}

export const ALL_FLAGS: readonly string[] = [...BOOLEAN_FLAGS, ...VALUE_FLAGS].sort()

const USAGE_HINT = '用 `dp --help` 看全部开关与例子，或 `dp help <命令>` 看单个命令'

function usage(message: string, path?: string): CliUsageError {
  return new CliUsageError(message, { path, hint: USAGE_HINT })
}

function unknownOption(name: string, form: string): CliUsageError {
  return new CliUsageError(`未知选项：${form}`, {
    path: `--${name}`,
    hint: `已支持的选项：${ALL_FLAGS.join(' | ')}。${USAGE_HINT}`,
  })
}

/** `-1` 这类负数不是选项名，否则 `--log-level -1` 会被误判成「缺值」 */
function looksLikeNegativeNumber(arg: string): boolean {
  return /^-\d/.test(arg)
}

function missingValue(name: string, form: string): CliUsageError {
  return new CliUsageError(`选项 ${form} 需要一个值（写成 ${form} 值 或 ${form}=值）`, {
    path: `--${name}`,
    hint: USAGE_HINT,
  })
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  let afterSeparator = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string

    if (afterSeparator) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      afterSeparator = true
      continue
    }

    if (arg.startsWith('--')) {
      const body = arg.slice(2)
      if (body === '') throw usage('`--` 后面必须有内容：`--` 本身不是选项')
      const eq = body.indexOf('=')
      if (eq >= 0) {
        const name = body.slice(0, eq)
        const value = body.slice(eq + 1)
        if (BOOLEAN_FLAGS.has(name)) {
          throw usage(`选项 --${name} 是开关，不接受取值（你写的是 ${arg}）`, `--${name}`)
        }
        if (!VALUE_FLAGS.has(name)) throw unknownOption(name, arg)
        if (value === '') throw missingValue(name, arg)
        flags[name] = value
        continue
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true
        continue
      }
      if (!VALUE_FLAGS.has(body)) throw unknownOption(body, arg)
      const next = argv[i + 1]
      if (next === undefined || next === '--' || (next.startsWith('-') && !looksLikeNegativeNumber(next))) {
        throw missingValue(body, `--${body}`)
      }
      flags[body] = next
      i += 1
      continue
    }

    if (arg.length > 1 && arg.startsWith('-')) {
      const body = arg.slice(1)
      const eq = body.indexOf('=')
      const short = eq >= 0 ? body.slice(0, eq) : body
      const long = SHORT_FLAGS[short]
      if (long === undefined) throw unknownOption(short, arg)
      if (BOOLEAN_FLAGS.has(long)) {
        if (eq >= 0) throw usage(`选项 -${short} 是开关，不接受取值（你写的是 ${arg}）`, `--${long}`)
        flags[long] = true
        continue
      }
      let value: string
      if (eq >= 0) {
        value = body.slice(eq + 1)
        if (value === '') throw missingValue(long, `-${short}`)
      } else {
        const next = argv[i + 1]
        if (next === undefined || next === '--' || (next.startsWith('-') && !looksLikeNegativeNumber(next))) {
          throw missingValue(long, `-${short}`)
        }
        value = next
        i += 1
      }
      flags[long] = value
      continue
    }

    positional.push(arg)
  }

  const [command, ...rest] = positional
  return { command, flags, positional: rest }
}

export function hasFlag(flags: Readonly<Record<string, string | boolean>>, name: string): boolean {
  return flags[name] === true
}

export function stringFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

/**
 * 每个命令只认自己的开关。跨命令串用（比如 `dp facts --all`）在这里报出来，
 * 因为「被静默忽略的选项」是自动化里最难查的一类故障。
 */
export function assertAllowedFlags(parsed: ParsedArgs, allowed: readonly string[]): void {
  const allow = new Set(allowed)
  for (const name of Object.keys(parsed.flags)) {
    if (!allow.has(name)) {
      throw new CliUsageError(`命令 ${parsed.command ?? '(无)'} 不支持选项 --${name}`, {
        path: `--${name}`,
        hint: `该命令支持的选项：${[...allow].sort().map((f) => `--${f}`).join(' | ')}。${USAGE_HINT}`,
      })
    }
  }
}
