/**
 * 跨平台命令执行包装层。
 *
 * 三条硬约束（对应铁律 0）：
 *
 *  1. **永不经过 shell** —— 一律 `spawn(argv[])`，`shell` 恒为 false。
 *     命令注入的面从调用方就被掐掉：本模块不接收命令字符串，只接收 argv。
 *  2. **永不交互** —— stdin 立即关闭；stdout/stderr 里一旦出现远端 prompt
 *     立刻杀进程并报 `DP.INTERACTIVE_PROMPT_DETECTED`，而不是挂在那里等。
 *  3. **永不无限等待** —— 每次执行都必须有 timeout。超时即失败。
 */
import { spawn } from 'node:child_process'
import { accessSync, constants as fsConstants } from 'node:fs'
import { delimiter, join, extname, resolve as resolvePath } from 'node:path'
import { DpError, type ExecResult } from '@dp/ports'

/**
 * `run()` 的执行选项。形状上与 ports 的 `ExecOptions` 兼容，外加一个输出上限。
 *
 * 为什么输出上限只加在这一层、不加进 `ExecOptions`：那个字段会随 Runner 接口
 * 扩散到每一个远端驱动，而「超限怎么算」（丢弃整块 / 截断 / 报错）在不同驱动上
 * 没有共同语义。写在这里，语义就只由 `run()` 一个实现说了算。
 */
export interface RunOptions {
  /** 工作目录。不存在时由系统报错，不自动创建 —— 建出来会把拼错的路径变成真目录 */
  readonly cwd?: string
  /** 超时（毫秒）。省略时取 DEFAULT_TIMEOUT_MS，但每次执行都该显式给：一次大目录 rsync 远不止 30 秒 */
  readonly timeoutMs?: number
  /**
   * 子进程环境。**给了就是整体替换，不与父进程合并** —— 与 ports 里那句
   * 「覆盖式环境变量」相反：同一份 env 既喂给 `resolveTool()` 判存在性、又原样
   * 交给 spawn，两边看的是同一份 PATH。合并会让「找到一个 exe」和「用另一份
   * PATH 去跑它」各说各话，而症状是启动了却行为异常。
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 显式喂给子进程的 stdin。给了也不代表会交互 —— 写完后立刻 end() */
  readonly stdin?: string
  /**
   * 输出字节上限（stdout 与 stderr **合并**计数），超出后整块丢弃。
   *
   * 合并计数而不是各算各的：要保护的是这一个进程的总内存，分开算等于把上限翻倍。
   * 超限是丢弃而不是报错 —— 调用方要的是「命令跑没跑成」，一条编译警告把结论
   * 变成失败会误伤；代价是输出可能不完整，所以这个值不宜设小。
   */
  readonly maxOutputBytes?: number
}

/**
 * 缺省超时（毫秒）。
 *
 * 为什么必须存在：铁律 0 要求每个子进程都有 timeout，而 `run()` 是本仓唯一的
 * spawn 入口 —— 兜底放在这里才可能覆盖到**所有**调用方，包括后面新写的。
 * 取 30 秒是取「本机工具（rsync / ssh / nginx -t）正常跑完」的量级，同时短到
 * 一次真挂死不会把整条部署拖住。它是漏传时的兜底，不是可以依赖的默认超时：
 * 超过 30 秒的操作该由调用方显式传 timeoutMs。
 */
export const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024

/**
 * 远端可能吐出的交互式 prompt。命中即杀进程 —— 挂起比失败危险得多。
 * 用户可扩展（不同发行版 `su` 的措辞不一样，我们不穷举）。
 */
export const PROMPT_PATTERNS: readonly RegExp[] = [
  /^\s*\[sudo\]\s+password\s+for\s+/im,
  /^\s*Password:\s*$/im,
  /^\s*(sudo|su)\s+password:\s*$/im,
  /are you sure you want to continue connecting/i,
  /^\s*Enter\s+passphrase\s+for\s+key/im,
  /^\s*Do you want to continue \[Y\/n\]/im,
]

/**
 * 在一段输出里找出交互式提示。
 *
 * 命中即意味着「有人在等密码」，所以这个判定必须发生在**读流的当下**：
 * 等命令跑完再看输出时，挂起已经发生了，而挂死在无人值守的部署里等于一次
 * 永远不返回的任务。
 *
 * @param chunk 一次读到的输出片段（不保证以行为单位完整，提示也可能跨块）
 * @param extra 调用方追加的模式。内置表覆盖常见措辞，但发行版自带的 `su` 提示
 *   各不相同，穷举不如让调用方补；与内置表并集而不是替换，替换会让调用方
 *   必须把内置表复制一遍才敢加一条
 * @returns 命中的那条模式（用于在错误里告诉用户是哪句提示拦下的），未命中为 undefined
 */
export function detectPrompt(chunk: string, extra: readonly RegExp[] = []): RegExp | undefined {
  for (const re of [...PROMPT_PATTERNS, ...extra]) {
    if (re.test(chunk)) return re
  }
  return undefined
}

// ------------------------------------------------------------
// 可执行文件解析
// ------------------------------------------------------------

/**
 * 在 Windows 上 `.cmd` / `.bat` 不是可执行文件，必须借 `cmd.exe` 才能跑；
 * 直接 spawn 会报 EINVAL。这里把它们显式识别出来。
 *
 * 为什么自己解析 PATH 而不借 `where` / `which`：那两个都得再 fork 一个进程，
 * 而探测一批工具时进程数会翻倍；且它们各自的输出格式与「是否可执行」判定并不等价
 * —— 这里要的是 access(X_OK) 这一条实测。
 *
 * @param name 工具名，含路径分隔符时按绝对/相对路径直接处理（含 X_OK 检查）
 * @param env 取 PATH 的环境。**必须传**而不是读 `process.env`：调用方可能正带着
 *   一份定制 env 探测（SSH 侧就是这么干的），用全局 env 去解析会得出一个
 *   「本地有这个工具」而实际 spawn 时并不存在的结论
 * @returns 第一个可执行的绝对路径；PATH 里找不到为 null（调用方据此报「工具缺失」
 *   而不是当成找不到就静默跳过）
 */
export function resolveTool(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (name.includes('/') || name.includes('\\')) {
    try {
      accessSync(name, fsConstants.X_OK)
      return resolvePath(name)
    } catch {
      return null
    }
  }

  const pathVar = env.PATH ?? env.Path ?? ''
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : ['']

  for (const dir of pathVar.split(delimiter)) {
    if (dir === '') continue
    for (const ext of extensions) {
      const candidate = join(dir, name + ext)
      try {
        accessSync(candidate, fsConstants.X_OK)
        return candidate
      } catch {
        // 继续试下一个
      }
    }
  }
  return null
}

const needsCmdShell = (exe: string): boolean => ['.cmd', '.bat'].includes(extname(exe).toLowerCase())

/** cmd.exe 会解释引号与 `%`，所以走这条退路时先拒绝危险字符 */
const UNSAFE_FOR_CMD = /[\r\n"&|<>^%]/

function buildCmdArgv(exe: string, args: readonly string[]): string[] {
  for (const a of args) {
    if (UNSAFE_FOR_CMD.test(a)) {
      throw new DpError(
        'DP.CONFIG.INVALID',
        `参数含 cmd.exe 会解释的字符，已拒绝执行：${JSON.stringify(a)}`,
        { hint: '去掉换行/引号/%/&|<>^ 等字符；或改用不需要 .cmd 包装的可执行文件' },
      )
    }
  }
  return ['/d', '/s', '/c', ...[`"${exe}"`, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a))]
}

// ------------------------------------------------------------
// 执行
// ------------------------------------------------------------

/**
 * 本机唯一执行命令的入口。
 *
 * 三件事在这里兜住，调用方不必各自处理：超时、prompt 杀进程、找不到可执行文件。
 * 刻意**不提供**「跑一条 shell 命令字符串」的能力 —— 一旦有它，上面那条命令注入
 * 的防护就只剩调用方的自觉了。
 *
 * @param argv 完整命令行，argv[0] 为可执行文件名（走 PATH 解析）及其参数。
 *   空数组直接报错而不是 spawn 失败：后者在 Windows 上的错误信息指不回「你没给命令」
 * @param options 见 RunOptions，省略项各取缺省值
 * @returns 进程结束后的退出码与输出。**退出码非 0 不抛错** —— 部署流程里
 *   「命令跑了但失败了」是一条正常的判定结果，由调用方按 code 分派，
 *   在这里 throw 会让所有非零退出都退化成同一种「异常」
 * @throws DpError argv 为空 / 找不到可执行文件（DP.CONFIG.INVALID）、
 *   超出 timeoutMs（DP.TIMEOUT.EXEC）、输出里出现交互提示（DP.INTERACTIVE_PROMPT_DETECTED）
 */
export async function run(argv: readonly string[], options: RunOptions = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>)

  if (argv.length === 0) {
    throw new DpError('DP.CONFIG.INVALID', 'argv 为空', { hint: '至少给出可执行文件名' })
  }

  // 不用 ~/.bashrc 之类的东西推断 exe —— 直接解析 PATH
  const resolved = resolveTool(argv[0]!, env)
  if (resolved === null) {
    throw new DpError('DP.CONFIG.INVALID', `找不到可执行文件：${argv[0]}`, {
      hint: '检查 PATH，或在配置里给出绝对路径',
    })
  }

  const rest = argv.slice(1)
  const useCmd = process.platform === 'win32' && needsCmdShell(resolved)
  const file = useCmd ? (env.ComSpec ?? 'cmd.exe') : resolved
  const spawnArgs = useCmd ? buildCmdArgv(resolved, rest) : rest

  return new Promise<ExecResult>((promiseResolve, promiseReject) => {
    let settled = false
    const child = spawn(file, spawnArgs, {
      cwd: options.cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })

    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done(() =>
        promiseReject(
          new DpError('DP.TIMEOUT.EXEC', `执行超时 ${timeoutMs}ms：${argv[0]}`, {
            hint: '增大 timeout，或检查该命令是否在等待输入（若是，先配好免密）',
          }),
        ),
      )
    }, timeoutMs)

    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let outBytes = 0
    let errBytes = 0

    const collect = (list: Buffer[], counter: 'out' | 'err') => (buf: Buffer): void => {
      if (counter === 'out') outBytes += buf.length
      else errBytes += buf.length
      if (outBytes + errBytes <= maxBytes) list.push(buf)

      // 输出里出现 prompt → 立刻杀掉，不能让它挂在那儿等别人输密码
      const matched = detectPrompt(buf.toString('utf8'))
      if (matched !== undefined) {
        child.kill('SIGKILL')
        done(() =>
          promiseReject(
            new DpError(
              'DP.INTERACTIVE_PROMPT_DETECTED',
              `检测到交互式提示 ${matched}，已终止：${argv[0]}`,
              {
                hint: '配置免密 sudo / 密钥直登 / SSH_ASKPASS，或改用不需要交互的命令',
              },
            ),
          ),
        )
      }
    }

    child.stdout.on('data', collect(chunks, 'out'))
    child.stderr.on('data', collect(errChunks, 'err'))

    if (options.stdin === undefined) {
      // 不喂 stdin 时**立刻关闭**，避免子进程误以为有人会回答它
      child.stdin.end()
    } else {
      child.stdin.end(options.stdin)
    }
    child.stdin.on('error', () => {
      /* 子进程提前退出会导致 EPIPE，忽略 */
    })

    child.on('error', (err) => {
      done(() =>
        promiseReject(
          new DpError('DP.CONFIG.INVALID', `无法启动 ${argv[0]}：${err.message}`, {
            cause: err,
            hint: '检查可执行文件是否存在、是否被安全软件拦截',
          }),
        ),
      )
    })

    child.on('close', (code) => {
      done(() =>
        promiseResolve({
          code: code ?? -1,
          stdout: Buffer.concat(chunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
        }),
      )
    })
  })
}
