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

export interface RunOptions {
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  /** 显式喂给子进程的 stdin。给了也不代表会交互 —— 写完后立刻 end() */
  readonly stdin?: string
  /** 输出字节上限，超出后丢弃（防炸内存） */
  readonly maxOutputBytes?: number
}

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

/** 调用方可追加自己的模式（例如某发行版特有的 su 提示） */
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
 * Windows 上 `.cmd` / `.bat` 不是可执行文件，必须借 `cmd.exe` 才能跑；
 * 直接 spawn 会报 EINVAL。这里把它们显式识别出来。
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
        'CONFIG_INVALID',
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

export async function run(argv: readonly string[], options: RunOptions = {}): Promise<ExecResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const env = options.env ?? (process.env as Readonly<Record<string, string | undefined>>)

  if (argv.length === 0) {
    throw new DpError('CONFIG_INVALID', 'argv 为空', { hint: '至少给出可执行文件名' })
  }

  // 不用 ~/.bashrc 之类的东西推断 exe —— 直接解析 PATH
  const resolved = resolveTool(argv[0]!, env)
  if (resolved === null) {
    throw new DpError('CONFIG_INVALID', `找不到可执行文件：${argv[0]}`, {
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
          new DpError('CONFIG_INVALID', `无法启动 ${argv[0]}：${err.message}`, {
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
