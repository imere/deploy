/**
 * `main()` —— 唯一对外入口。**不自己 process.exit**：返回退出码，由 bin.ts 决定
 * 怎么退出。这样测试可以 `await main([...])` 直接拿到退出码，不用捕获全局状态。
 */
import { createRequire } from 'node:module'
import { DpError } from '@dp/ports'
import {
  assertAllowedFlags,
  hasFlag,
  parseArgs,
  stringFlag,
  CliUsageError,
  type ParsedArgs,
} from './args.js'
import {
  COMMAND_NAMES,
  commandHelp,
  findCommand,
  notImplementedMessage,
  rootHelp,
  unknownCommandMessage,
} from './help.js'
import {
  EXIT_FAILURE,
  exitCodeFor,
  renderErrorJson,
  renderErrorPretty,
} from './output.js'
import { createContext, parseLogFormat, parseLogLevel, type ResolvedFlags, type RunContext } from './run.js'
import type { ApplyDeps } from './deps.js'
import { runPlan, PLAN_OPTION_HINT } from './commands/plan.js'
import { runApply } from './commands/apply.js'
import { runDeploy, DEPLOY_ALLOWED_FLAGS } from './commands/deploy.js'
import { runFacts } from './commands/facts.js'
import { runStatus } from './commands/status.js'
import { runVerify } from './commands/verify.js'
import { runRollback } from './commands/rollback.js'
import { runSchema } from './commands/schema.js'

/**
 * 打进帮助与 `--version` 的版本号。
 *
 * 读 package.json 失败时回落 `0.0.0` 而不是抛错：版本号不值得让整条命令失败，
 * 而抛错的代价是「在没有任何有效配置的环境里，`dp --help` 也会失败」。
 */
export const VERSION: string = readVersion()

function readVersion(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkg = require('../package.json') as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    // 读不到就报 0.0.0 而不是崩掉：版本号不值得让整条命令失败
    return '0.0.0'
  }
}

/**
 * 归一化开关。默认值在这里定一次，其余代码不必再判断 undefined。
 *
 * 「用户没给」与「给了这个值」必须能区分，所以取值型选项用条件展开
 * 而不是 `?? '默认值'`：logFormat 若被补上兜底值，createContext 就无法
 * 判断该不该按 TTY 推断（日志格式会永远锁死在 json 或 pretty 上）。
 *
 * @param parsed parseArgs 的结果
 * @returns 归一化开关；没给定的取值型选项**键不存在**（不是 undefined 值）
 * @throws TypeError log-format / log-level 给了非法字面量
 */
export function resolveFlags(parsed: ParsedArgs): ResolvedFlags {
  const { flags } = parsed
  const config = stringFlag(flags, 'config')
  const env = stringFlag(flags, 'env')
  const host = stringFlag(flags, 'host')
  const project = stringFlag(flags, 'project')
  const factsFile = stringFlag(flags, 'facts')
  const out = stringFlag(flags, 'out')
  const logFile = stringFlag(flags, 'log-file')
  return {
    ...(config !== undefined ? { config } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(project !== undefined ? { project } : {}),
    ...(factsFile !== undefined ? { factsFile } : {}),
    ...(out !== undefined ? { out } : {}),
    ...(logFile !== undefined ? { logFile } : {}),
    all: hasFlag(flags, 'all'),
    json: hasFlag(flags, 'json'),
    dryRun: hasFlag(flags, 'dry-run'),
    verbose: hasFlag(flags, 'verbose'),
    quiet: hasFlag(flags, 'quiet'),
    help: hasFlag(flags, 'help'),
    version: hasFlag(flags, 'version'),
    // 只在用户显式给了才落进 flags：否则 createContext 无法区分「用户要 pretty」
    // 与「没说，请按 TTY 推断」，后者会被 'pretty' 这个兜底值吃掉
    ...(stringFlag(flags, 'log-format') !== undefined
      ? { logFormat: parseLogFormat(stringFlag(flags, 'log-format'), 'pretty') }
      : {}),
    ...(stringFlag(flags, 'log-level') !== undefined
      ? { logLevel: parseLogLevel(stringFlag(flags, 'log-level'), 'info') }
      : {}),
  }
}

/**
 * plan 的开关集合直接取命令模块自己声明的那一份，不在这里再抄一遍。
 * 抄一份的代价不是多写一行，而是「给命令加了开关却忘了同步这里」——
 * 表现为用户按文档加了 flag 却被拒绝，而且两侧代码单看都对。
 */
const PLAN_FLAGS = PLAN_OPTION_HINT.allowedFlags
/**
 * apply 的开关集合与 plan 一致 —— **刻意不给 `yes`**。
 * 铁律 0 不许交互，也就意味着没有「人看过提示再敲 y」这个环节；
 * 加一个确认开关只会让人误以为「有确认=更安全」，实际上它只是多一次能忘记的输入。
 * 想要不落盘的预览，`--dry-run` 已经足够。
 */
const APPLY_FLAGS = ['config', 'env', 'host', 'project', 'all', 'facts', 'json', 'dry-run', 'log-format', 'log-level', 'log-file', 'verbose', 'quiet']
/**
 * deploy 的开关集合 = apply 的全部 + `yes`。它多出来的那个只对零配置有意义：
 * apply 前面有一份用户写好的配置，而 deploy 的配置是探测出来的。
 */
const DEPLOY_FLAGS = DEPLOY_ALLOWED_FLAGS
const FACTS_FLAGS = ['config', 'env', 'host', 'project', 'all', 'json', 'log-format', 'log-level', 'log-file', 'verbose', 'quiet']
const SCHEMA_FLAGS = ['out', 'json', 'log-format', 'log-level', 'log-file', 'verbose', 'quiet']

/**
 * status / verify 的开关集合。**不给 `facts`**：它们需要一个 Runner 才能读索引，
 * 而 --facts 只对 local 主机成立（远端写入必须有真连接）。给了它只会让人
 * 以为「离线查状态」是支持的。
 */
const READONLY_FLAGS = ['config', 'env', 'host', 'project', 'all', 'json', 'log-format', 'log-level', 'log-file', 'verbose', 'quiet']
/**
 * rollback 同样不给 `facts`；也不给 `dry-run` —— 回滚要么做要么不做，
 * 没有「演练回滚」这种半状态。
 */
const ROLLBACK_FLAGS = ['config', 'env', 'host', 'project', 'all', 'json', 'log-format', 'log-level', 'log-file', 'verbose', 'quiet']

/**
 * `help` 的位置参数有两种可能：`dp help plan`（第 0 个位置参数是命令名）与
 * `dp plan --help`（无）。所以 help 的参数校验要放到解析之后单独做。
 */
function allowedFor(command: string): readonly string[] {
  switch (command) {
    case 'plan':
      return PLAN_FLAGS
    case 'apply':
      return APPLY_FLAGS
    case 'deploy':
      return DEPLOY_FLAGS
    case 'facts':
      return FACTS_FLAGS
    case 'status':
      return READONLY_FLAGS
    case 'verify':
      return READONLY_FLAGS
    case 'rollback':
      return ROLLBACK_FLAGS
    case 'schema':
      return SCHEMA_FLAGS
    case 'help':
      return ['json', 'log-format', 'log-level', 'log-file', 'verbose', 'quiet']
    default:
      return ['json', 'log-format', 'log-level', 'log-file', 'verbose', 'quiet']
  }
}

/**
 * 注入点。**每一项都对应一个「测试时不想碰的东西」**：
 * cwd / env 是外部状态，write / writeErr 是全局 stdout/stderr，
 * isTTY 影响日志格式推断，deps 让远端部署测试完全不联网。
 *
 * 全部可选且默认取真实全局值，所以生产路径只调 `main(argv)` 就行。
 */
export interface MainOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly write?: (text: string) => void
  readonly writeErr?: (text: string) => void
  readonly isTTY?: boolean
  /** 测试注入的 apply 依赖（假的 facts / 假的 transfer）。生产不传 */
  readonly deps?: ApplyDeps
}

/**
 * 唯一入口。**永不抛、永不自己 exit**，一律把错误渲染完返回退出码。
 *
 * 由 bin.ts 决定 `process.exit`：测试可以直接 `await main([...])` 拿退出码，
 * 而捕获全局状态（尤其 exit）会让「命令跑得对不对」这件事没法断言。
 *
 * 阶段顺序是硬约束，别调换：
 *  ① parseArgs —— 失败也要按 --json 输出（早期失败最容易被调用方误判成崩溃）
 *  ② 帮助 / --version —— **碰文件系统之前**返回，所以 `dp` 单独跑不需要配置
 *  ③ 查命令是否存在 / 是否已实现
 *  ④ 开关白名单校验
 *  ⑤ 建 context（至此才知道日志格式与 json）
 *  ⑥ 执行
 *
 * @param argv 完整参数，`process.argv.slice(2)` 的形态
 * @param options 注入点，全部可省
 * @returns 进程退出码，取 `EXIT_*` 之一
 */
export async function main(argv: readonly string[], options: MainOptions = {}): Promise<number> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(argv)
  } catch (err) {
    return reportEarly(err, options, argv)
  }

  const { command, positional } = parsed

  // `dp help <cmd>`：把位置参数提升成命令名，让两条等价路径走同一段逻辑
  const effective = command === 'help' && positional[0] !== undefined ? positional[0] : command

  // `dp help <cmd>` 必须**永远**只打印帮助：不能因为后面还有别的参数就掉进执行分支，
  // 否则 `dp help plan` 会在临时目录里真的去部署一次
  if (command === 'help' && effective !== undefined) return emit(options, helpFor(effective))

  // 无命令 / -h / -V 都在碰文件系统之前返回
  if (hasFlag(parsed.flags, 'version')) return emit(options, VERSION)
  // `dp` 单独跑：打印根帮助并成功退出 —— 这是「打印」而不是「出错」
  if (effective === undefined) return emit(options, rootHelp(VERSION))
  if (hasFlag(parsed.flags, 'help')) return emit(options, helpFor(effective))

  const doc = findCommand(effective)
  if (doc === undefined) {
    return emitError(
      new CliUsageError(unknownCommandMessage(effective), {
        path: 'command',
        hint: `可用命令：${COMMAND_NAMES.join(' | ')}`,
      }),
      false,
      options,
      flags0Json(parsed),
    )
  }

  if (!doc.implemented) {
    return emit(options, notImplementedMessage(doc), EXIT_FAILURE)
  }

  let flags: ResolvedFlags
  try {
    flags = resolveFlags(parsed)
    const allowed = allowedFor(effective)
    // `dp help plan` 时位置参数已被提升，这里要允许它带一个参数
    assertAllowedFlags({ ...parsed, command: effective, positional: [] }, allowed)
  } catch (err) {
    return reportEarly(err, options, argv)
  }

  const context: RunContext = createContext(flags, {
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.write !== undefined ? { write: options.write } : {}),
    ...(options.writeErr !== undefined ? { writeErr: options.writeErr } : {}),
    ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}),
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
  })

  try {
    switch (effective) {
      case 'plan':
        return await runPlan(context, flags)
      case 'apply':
        return await runApply(context, flags)
      case 'deploy':
        return await runDeploy(context, { ...flags, ...(hasFlag(parsed.flags, 'yes') ? { yes: true } : {}) })
      case 'facts':
        return await runFacts(context, flags)
      case 'status':
        return await runStatus(context, flags)
      case 'verify':
        return await runVerify(context, flags)
      case 'rollback':
        return await runRollback(context, flags)
      case 'schema':
        return await runSchema(context, flags)
      default:
        return emitError(new CliUsageError(`命令 ${effective} 还没接线`), false, options, flags.json)
    }
  } catch (err) {
    return emitError(err, flags.verbose, options, flags.json)
  }
}

function helpFor(name: string): string {
  const doc = findCommand(name)
  return doc === undefined ? unknownCommandMessage(name) : commandHelp(doc)
}

function emit(options: MainOptions, text: string, code = 0): number {
  const write = options.write ?? ((t: string) => void process.stdout.write(t))
  write(text.endsWith('\n') ? text : `${text}\n`)
  return code
}

function emitError(err: unknown, verbose: boolean, options: MainOptions, json: boolean): number {
  const writeErr = options.writeErr ?? ((t: string) => void process.stderr.write(t))
  writeErr(json ? renderErrorJson(err, verbose) : renderErrorPretty(err, verbose))
  writeErr('\n')
  return exitCodeFor(err)
}

/**
 * 早期失败（连 context 都还没建）也得尊重 --json。
 * 直接在 argv 上找 `--json` 即可：此时还没解析，宁可粗一点也不能让
 * 「输出的是文本、调用方却在等 JSON」这种错配发生。
 */
function earlyJson(argv: readonly string[]): boolean {
  return argv.includes('--json')
}

/** 未知命令这条分支发生在 flags 归一化之前，所以只能看已解析的原始 flags */
function flags0Json(parsed: ParsedArgs): boolean {
  return hasFlag(parsed.flags, 'json')
}

function reportEarly(err: unknown, options: MainOptions, argv: readonly string[]): number {
  return emitError(err, false, options, earlyJson(argv))
}

export { CliUsageError, DpError }
export * from './args.js'
export * from './help.js'
export * from './output.js'
export * from './config-file.js'
export * from './targets.js'
export * from './zero-config.js'
export * from './project-facts.js'
export * from './run.js'
