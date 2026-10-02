/**
 * 子进程执行 —— **唯一**允许真正起进程的地方。
 *
 * 三条铁律在这里落地（与 @dp/local/src/exec.ts 同源，但本包必须能注入 fake spawn，
 * 所以不能直接复用 `run()`）：
 *
 *  1. **永不交互**：stdin 立刻 end；stdout/stderr 里嗅到 prompt 立刻杀进程并报
 *     `DP.INTERACTIVE_PROMPT_DETECTED`。挂起比失败危险得多。
 *  2. **永不无限等待**：每次执行都必须有 timeout，超时杀**进程树**（只 kill 本体
 *     会留下 ssh / ProxyJump 子 ssh 继续跑）。
 *  3. **绝不经过 shell**：只 `spawn(exe, argv[])`。
 *
 * 复用 `@dp/ssh` 的 `detectPrompt` 与 `killProcessTree` 而不是各写一套：
 * prompt 词表与杀树方式必须全仓一致。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { DpError } from '@dp/ports'
import { detectPrompt, killProcessTree } from '@dp/ssh'
import type { SpawnImpl, SpawnedProcess } from './types.js'

export const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024

export interface RunProcessOptions {
  readonly timeoutMs?: number
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly spawnImpl?: SpawnImpl
  /** 喂给 stdin 的内容；给完立刻 end */
  readonly stdin?: string
  readonly maxOutputBytes?: number
  /** 超时消息里显示的可执行文件名（spawn 内部可能是绝对路径） */
  readonly label?: string
}

export interface RunProcessResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
  /** 退出时进程是否已被我们杀掉（超时 / prompt 命中） */
  readonly killed: boolean
}

export const realSpawn: SpawnImpl = (file, args, options) =>
  nodeSpawn(file, args as string[], {
    ...(options as Record<string, unknown>),
    shell: false,
    windowsHide: true,
  } as Parameters<typeof nodeSpawn>[2]) as unknown as SpawnedProcess

/**
 * 起一个子进程并等它结束。全程保证有 timeout。
 *
 * 注意 `spawn` 的 `error`（ENOENT 等）**先于** `close` 到达，所以 `settled`
 * 守卫必须同时挡住两条路径，否则会出现"已 reject 又 resolve"的悬空。
 */
export function runProcess(
  argv: readonly string[],
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT
  const spawnImpl = options.spawnImpl ?? realSpawn
  const label = options.label ?? argv[0] ?? ''

  if (argv.length === 0) {
    throw new DpError('DP.CONFIG.INVALID', 'argv 为空', { hint: '至少给出可执行文件名' })
  }

  return new Promise<RunProcessResult>((resolve, reject) => {
    let settled = false
    let killed = false
    let timer: NodeJS.Timeout

    let child: SpawnedProcess
    try {
      child = spawnImpl(argv[0]!, argv.slice(1), {
        // detached 让 POSIX 下能整组杀；Windows 上 killProcessTree 走 taskkill
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(options.env !== undefined ? { env: options.env } : {}),
      })
    } catch (err) {
      reject(
        new DpError('DP.CONFIG.INVALID', `无法启动 ${label}：${(err as Error).message}`, {
          cause: err,
          hint: '检查可执行文件是否存在、是否被安全软件拦截',
        }),
      )
      return
    }

    const done = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }

    const kill = (): void => {
      killed = true
      killProcessTree(child.pid)
      try {
        child.kill('SIGKILL')
      } catch {
        /* 杀不掉就靠下面的 reject 兜底 */
      }
    }

    /**
     * 快速失败：**先**占住 settled 再杀进程。
     *
     * 顺序反了会出事：`child.kill()` 可能同步触发 'close'，于是在
     * `done(reject)` 之前先跑掉了 `done(resolve)`，超时/命中 prompt 会被
     * 报成"以 exit -1 正常结束" —— 一个假成功。占位必须先做。
     */
    const failFast = (err: DpError): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      kill()
      reject(err)
    }

    timer = setTimeout(() => {
      failFast(
        new DpError('DP.TIMEOUT.EXEC', `传输超时 ${timeoutMs}ms：${label}`, {
          hint: '增大 transport.timeout，或检查链路是否卡在等待输入（若是，先配好免密）',
        }),
      )
    }, timeoutMs)

    const outChunks: Buffer[] = []
    const errChunks: Buffer[] = []
    let bytes = 0

    const sniff = (buf: Buffer, isErr: boolean): void => {
      bytes += buf.length
      if (bytes <= maxBytes) (isErr ? errChunks : outChunks).push(buf)
      const matched = detectPrompt(buf.toString('utf8'))
      if (matched === undefined) return
      failFast(
        new DpError('DP.INTERACTIVE_PROMPT_DETECTED', `检测到交互式提示 ${matched}，已终止：${label}`, {
          hint: '配置免密 sudo / 密钥直登 / SSH_ASKPASS。铁律 0：永不交互，我们不会等人类输入',
        }),
      )
    }

    child.stdout.on('data', (c: Buffer) => sniff(c, false))
    child.stderr.on('data', (c: Buffer) => sniff(c, true))

    if (options.stdin === undefined) child.stdin.end()
    else child.stdin.end(options.stdin)
    child.stdin.on('error', () => {
      /* 子进程提前退出 → EPIPE，忽略 */
    })

    child.on('error', (err: Error) => {
      done(() =>
        reject(
          new DpError('DP.SSH.TOOL_MISSING', `无法启动 ${label}：${err.message}`, {
            cause: err,
            hint: '这个可执行文件不存在。传输方式的选择是按 facts.tools 的实证结果做的，所以这通常意味着 facts 是陈旧的 —— 重新探测再试',
          }),
        ),
      )
    })

    child.on('close', (code: number | null) => {
      done(() =>
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(outChunks).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8'),
          killed,
        }),
      )
    })
  })
}

/** stderr → 可进 message 的一句话。沿用 @dp/ssh 的取法：首行、截断。 */
export function summarizeFailure(stderr: string, max = 300): string {
  const first = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (first === undefined) return ''
  return first.length > max ? `${first.slice(0, max)}…` : first
}
