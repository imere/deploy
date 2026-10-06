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

/**
 * 判断一个错误是否属于「命令行用法错」这一类。
 *
 * 判据是**类型**而不是 code：用法错与配置错共用 `DP.CONFIG.INVALID`，而两者的
 * 退出码不同（用法错 2、配置错 3）。若改成按 code 判，退出码映射就得同时知道
 * 「这个 DP.CONFIG.INVALID 是从 argv 抛的」—— 而抛出点在好几个文件里，
 * 判据一旦变成隐式的约定，加一个新抛点就会漏判。
 *
 * @param err 任意值。`unknown` 而非 `Error`：捕获到的异常类型不确定，
 *   这里要能对非 Error 的抛出也给出确定答案（false）
 * @returns true 表示应退 `EXIT_USAGE`（先改输入再重跑）
 */
export function isUsageError(err: unknown): boolean {
  return err instanceof CliUsageError
}

/**
 * 一次 argv 解析的结果。
 *
 * `positional` 刻意**不含**命令名本身：命令已在 `command` 里单列。留在
 * positional 里的话，`dp help plan` 的处理就得靠「第一个位置参数是不是命令名」
 * 去猜，两条等价路径（`dp help plan` 与 `dp plan --help`）会走岔。
 */
export interface ParsedArgs {
  /** 没有命令时是 undefined（`dp` 单独跑 → 打印根帮助） */
  readonly command: string | undefined
  /** 长选项名（无连字符）→ 取值或 true。键名只可能是 BOOLEAN_FLAGS ∪ VALUE_FLAGS 里的 */
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

/**
 * 吃值的选项。**全仓只有这一份**，帮助文本、开关白名单、解析器都读它。
 *
 * 之所以要求「列出即唯一来源」：白名单是安全性判据（不在表里的选项必须报错），
 * 而帮助是给人看的期望 —— 两份各写一份时，先加开关忘改另一份的后果是
 * 「文档教用户用的 flag 被拒绝」，排查方向会完全跑偏到依赖版本上。
 */
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

/**
 * 两类选项的全集，**已排序**。错误提示里直接 join 它，用户能一眼比对自己写的名字。
 *
 * 排序是给提示文本用的：集合的插入顺序会让提示随改动顺序漂移，同一条错误在两个
 * 版本里长得不一样就没法互相搜索。
 */
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

/**
 * argv → { 命令, 开关, 位置参数 }。**纯函数**，不读环境、不碰文件系统。
 *
 * 不在这里做「开关对不对命令」的判定：那是 `assertAllowedFlags` 的事，它需要命令名。
 * 两处分开是刻意的 —— argv 形状的错（写了不存在的选项）和用法的错（这个命令不认它）
 * 退出码相同但消息不同，混在一个函数里就只能挑一种报，另一半用户永远看不到自己写错的那处。
 *
 * 几个刻意的不宽容：未知选项、开关带值、值选项缺值、单独的 `--`，全部报错而不是猜。
 * `dp` 是自动化与 agent 的主入口，放行一条歧义输入的代价是一次「部署到了没部署过的版本」。
 *
 * @param argv **不含** node 路径与脚本路径的完整参数（`process.argv.slice(2)`）
 * @returns 命令名可能为 undefined；开关值里的短选项已展开成长选项名
 * @throws CliUsageError 任意一种歧义写法
 */
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

/**
 * 开关是否被打开。判据是「值恰好是 `true`」而不是「键存在」：
 * `--json=false` 解析出来是字符串 `'false'`，它在语义上是没开这个开关，
 * 而若按存在性判就会得到一个名字叫 `json=false` 的假开关（随后被白名单拒掉，
 * 报错信息指向的名字还是错的）。
 *
 * @param flags parseArgs 的 flags
 * @param name 不带连字符的选项名
 * @returns 显式给了且取值为 true 才为 true
 */
export function hasFlag(flags: Readonly<Record<string, string | boolean>>, name: string): boolean {
  return flags[name] === true
}

/**
 * 取一个取值型选项。不给、给了开关形态（`--json` 对 `--json` 型名字）都返回 undefined。
 *
 * 不报错：调用方拿到 undefined 时区分不出「没给」与「类型不对」，而这两种情况下
 * 后面必然还会走白名单校验并报出真正的原因，在这里先抛一次只会把它盖掉。
 *
 * @param flags parseArgs 的 flags
 * @param name 不带连字符的选项名
 * @returns 字符串原样（**不** trim、不展开 `~`、相对路径也不在这里解析）
 */
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
 *
 * @param parsed parseArgs 的结果；command 只用于错误消息
 * @param allowed 该命令声明的选项名白名单，取自命令模块自己导出的那一份
 * @throws CliUsageError 出现白名单之外的选项
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
