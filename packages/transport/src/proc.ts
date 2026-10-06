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

/**
 * 传输子进程的兜底超时（毫秒）。
 *
 * 为什么必须有一个缺省值：rsync 连一台不可达的主机时不会自己退出，而是一个
 * 永远不返回的进程。没有兜底就是一次永不结束的部署 —— 在 CI 里表现为永久挂起，
 * 比失败难查得多。
 *
 * 为什么是 120 秒而不是更短：这里跑的是**整个构建产物**的传输，慢链路上几十秒
 * 很正常。定得太短会把「正常但慢」判成超时，用户只能不断把它调大 —— 那等于把
 * 兜底交回给用户，兜底就不存在了。（探测类命令是另一个量级，见 @dp/local 那份缺省。）
 */
export const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024

/**
 * 起子进程的可选项。
 *
 * 刻意**没有** `shell` 开关：本包只 `spawn(exe, argv[])`，经过 shell 就等于把
 * rsync/scp 的 argv 重新拼成一行命令。一个只能取 false 的选项不需要存在。
 *
 * 每一项缺省都对应一个本包能自己定的选择（超时走 `DEFAULT_TIMEOUT_MS`、
 * spawn 走系统实现、输出上限走 8 MiB），**没有一项的缺省是「不限」**：
 * `maxOutputBytes` 不传也要守住 8 MiB，否则一个死循环打日志的远端命令会把内存吃干。
 */
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

/**
 * 真实的 spawn —— 生产侧的实现，测试用 fake 顶替。
 *
 * `shell` 在这里硬写 false 而**不读**传入的 options：`SpawnOptions` 留着
 * `shell?: false` 只是为了让 fake 与真实实现共用一个签名，真实实现不接受打开它。
 *
 * @param file 可执行文件。可以是绝对路径（来自 `facts.tools`，如 rsync/scp）
 * @param args 参数数组，逐项传递，不拼成一行
 * @param options 只有 cwd / env / stdio / detached 会真的透传；`shell` 恒为 false
 * @returns 子进程句柄，按 `SpawnedProcess` 收窄 —— 只暴露本包用得到的那几个成员
 */
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
 *
 * @param argv 可执行文件 + 参数。空数组直接在起步前报错，不落到 spawn
 * @param options 超时 / env / spawn 注入 / stdin；`label` 决定超时消息里显示的名字
 *   （spawn 手里那个可能是绝对路径，人读不出是哪个工具）
 * @returns 退出码、stdout/stderr，以及 `killed`（区分「自己退的」与「被我们杀的」）。
 *   退出码**原样保留**，不归一化：信号杀死按 128+信号号，压成 1 会抹掉「是谁杀的」
 * @throws DpError DP.CONFIG.INVALID（argv 为空 / spawn 同步抛错）、DP.TIMEOUT.EXEC（超时，
 *   已杀进程树）、DP.INTERACTIVE_PROMPT_DETECTED（输出里嗅到 prompt，已杀进程）、
 *   DP.SSH.TOOL_MISSING（ENOENT：可执行文件不存在，通常说明 facts 已陈旧）
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

/**
 * stderr → 可以进 message 的一句话。
 *
 * 只取**首行非空**并截断：这句要进 `DpError.message`，而 message 会被日志与 JSON
 * 报告整条带走。整段 stderr 进去会淹没同行的其它字段，而真正的失败原因几乎总在第一行。
 * 取不到时返回空串而不是编一个「未知」—— 占位词会让上层以为手里有证据。
 *
 * @param stderr 子进程的原始 stderr。含远端路径与用户，进 message 前应先过 `@dp/log` 的脱敏
 * @param max 截断长度（字符数）。默认 300 是「够看清一条 ssh 报错」的量级
 * @returns 首行非空内容（超长则截断加省略号）；没有任何内容时为空串
 */
export function summarizeFailure(stderr: string, max = 300): string {
  const first = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (first === undefined) return ''
  return first.length > max ? `${first.slice(0, max)}…` : first
}
