/**
 * 运行上下文 —— 组装 logger、stdin-free 的 IO、以及配置加载入口。
 *
 * 为什么不用 process.stdout 直接写：命令实现要能**被单测直接调用**。把 out /
 * error / log 全部做成注入的，测试就不必起子进程、也不必捕获全局 stdout。
 * 铁律 0 在这里体现为：没有任何一处读 stdin，也没有任何提示。
 */
import { appendFileSync } from 'node:fs'
import { createLogger, type LogFormat, type LogLevel } from '@dp/log'
import type { DpError } from '@dp/ports'
import { loadConfig, type LoadedConfig } from './config-file.js'
import type { ApplyDeps } from './deps.js'

export interface ResolvedFlags {
  readonly config?: string
  readonly env?: string
  readonly host?: string
  readonly project?: string
  readonly all: boolean
  readonly json: boolean
  readonly dryRun: boolean
  readonly verbose: boolean
  readonly quiet: boolean
  readonly help: boolean
  readonly version: boolean
  readonly factsFile?: string
  readonly out?: string
  /** 用户**显式**指定时才存在；没指定就交给 createContext 按 TTY / --json 推断 */
  readonly logFormat?: LogFormat
  readonly logLevel?: LogLevel
  readonly logFile?: string
}

/** 命令自己声明的开关集合，供 assertAllowedFlags 逐命令校验 */
export interface PlanOptions {
  readonly needsConfig: boolean
  readonly allowedFlags: readonly string[]
}

export interface RunContext {
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly logger: ReturnType<typeof createLogger>
  /** 结果出口。`--json` 时 stdout 只有它，避免日志污染管道 */
  readonly out: (text: string) => void
  /** 人类可读的提示（不走日志格式） */
  readonly error: (message: string, hint?: string) => void
  readonly loadConfig: (flags: ResolvedFlags) => Promise<LoadedConfig>
  readonly flags: ResolvedFlags
  /**
   * apply 的可注入依赖。生产路径不传（命令内部回落到 defaultApplyDeps）；
   * 测试传假的 acquireFacts / transfer，于是远端部署的测试**完全不碰网络**。
   */
  readonly deps?: ApplyDeps
}

const LOG_FORMATS: readonly LogFormat[] = ['json', 'pretty', 'logfmt']
const LOG_LEVELS: readonly LogLevel[] = ['trace', 'debug', 'info', 'warn', 'error']

/**
 * 格式与级别的取值校验放这里，而不是散在各处。
 * `as` 断言是危险的：写错一次就等于在后面某个 IO 路径上炸出无法定位的错。
 */
export function parseLogFormat(value: string | undefined, fallback: LogFormat): LogFormat {
  if (value === undefined) return fallback
  if ((LOG_FORMATS as readonly string[]).includes(value)) return value as LogFormat
  throw new TypeError(`--log-format 只能是 ${LOG_FORMATS.join(' | ')}，实际是 ${value}`)
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel): LogLevel {
  if (value === undefined) return fallback
  if ((LOG_LEVELS as readonly string[]).includes(value)) return value as LogLevel
  throw new TypeError(`--log-level 只能是 ${LOG_LEVELS.join(' | ')}，实际是 ${value}`)
}

export interface CreateContextOptions {
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly write?: (text: string) => void
  readonly writeErr?: (text: string) => void
  readonly isTTY?: boolean
  readonly deps?: ApplyDeps
}

export function createContext(flags: ResolvedFlags, options: CreateContextOptions = {}): RunContext {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const write = options.write ?? ((t: string) => void process.stdout.write(t))
  const writeErr = options.writeErr ?? ((t: string) => void process.stderr.write(t))
  const tty = options.isTTY ?? process.stdout.isTTY === true

  // 显式 --log-format 优先；否则 stdout 不是 TTY（管道 / CI）时用 json，
  // 人看的 pretty 混进机器读的场景只会制造新问题。
  const format = parseLogFormat(flags.logFormat, flags.json || !tty ? 'json' : 'pretty')
  const level = parseLogLevel(flags.logLevel, flags.quiet ? 'warn' : 'info')

  // --json 时日志走 stderr：stdout 必须只有结果，管道才能直接喂给 jq。
  // 注意 out 必须**无条件**传 —— 不传的话 logger 会退回自己默认的 process.stdout，
  // 于是 pretty 日志照样混进 --json 的 stdout，jq 直接炸（并且测试注入的 write 也捕获不到）。
  const logOut = flags.json ? writeErr : write
  const logger = createLogger({
    level,
    format,
    // --log-file 显式指定时日志进文件；用 appendFileSync 而不是常驻 WriteStream：
    // 常驻句柄会 ref 住事件循环，让 CLI 跑完不退出。
    out:
      flags.logFile === undefined
        ? (line: string) => void logOut(line)
        : (line: string) => {
            try {
              appendFileSync(flags.logFile as string, line, 'utf8')
            } catch (err) {
              // 日志写不进去不能推翻主流程，降级到 stderr 并说清原因
              writeErr(`[log-file 写入失败] ${err instanceof Error ? err.message : String(err)}\n`)
              logOut(line)
            }
          },
    bind: { component: '@dp/cli', command: flags.version ? 'version' : 'dp' },
  })

  return {
    cwd,
    env,
    logger,
    out: (text: string) => write(text.endsWith('\n') ? text : `${text}\n`),
    error: (message: string, hint?: string) => {
      writeErr(`${message}\n`)
      if (hint !== undefined) writeErr(`下一步：${hint}\n`)
    },
    loadConfig: (f: ResolvedFlags) =>
      loadConfig({
        cwd,
        env,
        ...(f.config !== undefined ? { explicit: f.config } : {}),
      }),
    ...(options.deps !== undefined ? { deps: options.deps } : {}),
    flags,
  }
}

export type { DpError }
