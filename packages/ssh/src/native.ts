import { spawn } from 'node:child_process'
import { accessSync, closeSync, constants as fsConstants, openSync, readSync } from 'node:fs'
import { delimiter, extname, join, resolve as resolvePath } from 'node:path'
import { DpError } from '@dp/ports'
import type {
  DriverAvailability,
  DriverExecResult,
  ExecRequest,
  SshConnectionOptions,
  SshDriver,
  SshDriverKind,
  Tunnel,
} from './driver.js'
import { DEFAULT_MAX_OUTPUT_BYTES, resolveTimeoutMs } from './driver.js'
import { buildExecArgv, buildRshArgv, buildSshArgv, defaultPinPath, hostTarget, type SshArgvOptions } from './argv.js'
import { createAskpassHelper, type AskpassHelper } from './askpass.js'
import { classifySshError, hostKeyHint, truncateOutput } from './parse.js'
import { detectPrompt, promptHint } from './prompt.js'

// 可执行文件解析

/**
 * 解析 ssh 的绝对路径。**必须解析** —— 不能把 `ssh` 原样交给 spawn：Windows 上 `PATH` 里可能先命中别的东西，而 exec 里我们也不再走 shell去找 .cmd/.bat（那正是 local/exec.ts 里 `buildCmdArgv` 存在的原因，而我们**不应该**为 ssh 引入 cmd.exe 这一层）。
 */
/**
 * 包装脚本后缀。`.cmd`/`.bat`/`.ps1` 不是可执行文件，必须借 `cmd.exe` /PowerShell 才能跑 —— 而我们**从不**经过 shell（`spawn` 的 `shell` 恒为false，local/exec.ts 里那套 `buildCmdArgv` 对我们是刻意不引入的）。
 */
const WRAPPER_EXT = /\.(cmd|bat|ps1)$/i

/**
 * 解析结果必须是**原生可执行文件**。返回原路径，或抛 `DP.SSH.TOOL_MISSING`。
 *
 * @param path 待检查的路径。**不检查它存不存在** —— 存在性由 resolveTool 用 X_OK 判，
 * 这里只判形状，免得把「权限不足」误说成「这是个脚本」
 * @param name 工具名（`ssh` / `sftp`…）。只用于错误消息，让用户知道该动哪个工具
 * @returns **原样返回**同一个路径字符串。规范化相对路径请在调用前做完 ——
 * 悄悄改写调用方给的路径会让日志里出现的命令与实际执行的不是一个
 * @throws DpError `DP.SSH.TOOL_MISSING` 且带 hint：它是包装脚本或带 shebang 的脚本。
 * **不降级**成「换个工具试试」—— 找到了却不能用，与没找到是两种不同的配置问题
 */
export function assertNativeExecutable(path: string, name: string): string {
  const isWrapper = WRAPPER_EXT.test(path)
  const isShebang = extname(path) === '' && hasShebang(path)
  if (!isWrapper && !isShebang) return path

  const why = isWrapper
    ? '它是 cmd/PowerShell 包装脚本，不是原生可执行文件'
    : '它是一个带 shebang 的脚本，不是原生可执行文件'
  throw new DpError('DP.SSH.TOOL_MISSING', `${name} 解析到不可执行的东西：${path} —— ${why}`, {
    hint: '我们从不经过 shell（spawn 的 shell 恒为 false），所以包装脚本无法执行。Windows 上需要原生的 ssh.exe / sftp.exe：装 OpenSSH for Windows，或在配置里直接给出 .exe 的绝对路径',
  })
}

/** 只看前两个字节是不是 `#!`；读不动就当作不是（不因探测失败而误杀合法工具） */
function hasShebang(path: string): boolean {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(2)
    return readSync(fd, buf, 0, 2, 0) === 2 && buf[0] === 0x23 && buf[1] === 0x21
  } catch {
    return false
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * 在 PATH 里解析一个**原生可执行文件**。
 *
 * @param name 工具名。**含 `/` 或 `\` 时按路径处理**，不走 PATH 查找 ——
 * 这样调用方可以给绝对路径，而 `PATH` 里的顺序不再对它有影响
 * @param env 环境变量。只读 `PATH` / `Path`（Windows 大小写不敏感，两种拼法都认）
 * @returns 第一个**能执行且是原生程序**的绝对路径；全部候选都不合格时返回 `null`。
 * `null` 表示「没找到」，而"找到了但不能用"会抛 DpError —— 两者必须能区分
 * @throws DpError 候选中存在包装脚本 / 带 shebang 的脚本（见 {@link assertNativeExecutable}）。
 * 读不动文件（权限不足）**不算**这种错，按"没找到"继续找下一个候选
 */
export function resolveTool(
  name: string,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (name.includes('/') || name.includes('\\')) {
    try {
      accessSync(name, fsConstants.X_OK)
      return assertNativeExecutable(resolvePath(name), name)
    } catch (err) {
      if (err instanceof DpError) throw err
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
        return assertNativeExecutable(candidate, name)
      } catch (err) {
        // 包装脚本要**继续往上抛**（它"找到了"但不能用）；
        if (err instanceof DpError) throw err
      }
    }
  }
  return null
}

const sshCandidates = (): readonly string[] => (process.platform === 'win32' ? ['ssh', 'ssh.exe'] : ['ssh'])

// 杀进程树

/**
 * 杀掉子进程**及其后代**。
 *
 * @param pid 目标进程号。`undefined`（进程还没起来 / 已经退了）直接返回 ——
 * 这不是错误，超时路径上它出现得太常见，为它抛错只会把真错误挤掉
 */
export function killProcessTree(pid: number | undefined): void {
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      }).unref()
    } catch {
      /* 杀不掉就靠超时失败返回，不在这里抛 —— 掩盖真实错误 */
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 已经退了 */
    }
  }
}

// 驱动

/**
 * 优先于内嵌实现：复用系统 known_hosts 与 agent
 */
export class NativeSshDriver implements SshDriver {
  readonly kind: SshDriverKind = 'native-ssh'
  private readonly sshPath: string | null
  /** resolveTool 拒绝了 PATH 里的候选（包装脚本）时留下的原因 */
  private sshReject: string | undefined
  private sshRejectHint: string | undefined

  constructor(private readonly options: SshConnectionOptions) {
    this.sshPath = this.findSsh()
  }

  private findSsh(): string | null {
    const env = process.env as Readonly<Record<string, string | undefined>>
    for (const name of sshCandidates()) {
      try {
        const found = resolveTool(name, env)
        if (found !== null) return found
      } catch (err) {
        // 找到的是包装脚本 → 记下原因，让 available() 报得具体；
        if (err instanceof DpError) {
          this.sshReject = err.message
          this.sshRejectHint = err.hint
          return null
        }
        throw err
      }
    }
    return null
  }

  async available(): Promise<DriverAvailability> {
    if (this.sshPath === null) {
      if (this.sshReject !== undefined) {
        return { ok: false, reason: this.sshReject, hint: this.sshRejectHint }
      }
      return {
        ok: false,
        reason: `PATH 里找不到 ssh（试过 ${sshCandidates().join(' / ')}）`,
        hint: '装 OpenSSH 客户端：Windows 10+ 自带 ssh.exe；Debian/RHEL 用 openssh-client；macOS 自带。没有它就只能降级到 ssh2，而 ssh2 不支持抗量子 KEX',
      }
    }
    return { ok: true }
  }

  /**
   * `knownHosts: off` 的告警**不在这里发**。
   */

  private sshArgvBase(setEnv?: Readonly<Record<string, string>>): SshArgvOptions {
    const opts = this.options
    return {
      authKind: opts.auth.type,
      port: opts.port,
      identityFile: opts.identityFile ?? (opts.auth.type === 'key' ? opts.auth.identityFile : undefined),
      knownHostsMode: opts.knownHosts ?? 'strict',
      userKnownHostsFile:
        opts.knownHosts === 'tofu' ? (opts.pinnedHostKeysPath ?? opts.userKnownHostsFile ?? defaultPinPath()) : opts.userKnownHostsFile,
      proxyJump: opts.proxyJump,
      ...(opts.hops !== undefined && opts.hops.length > 0 ? { hops: opts.hops } : {}),
      extraOptions: opts.extraOptions,
      setEnv,
    }
  }

  async exec(req: ExecRequest): Promise<DriverExecResult> {
    if (this.sshPath === null) {
      const availability = await this.available()
      throw new DpError('DP.SSH.DRIVER_UNAVAILABLE', availability.reason ?? '找不到 ssh', {
        hint: availability.hint,
      })
    }
    if (req.argv.length === 0) {
      throw new DpError('DP.CONFIG.INVALID', '远端命令 argv 为空', {
        hint: '至少给出可执行文件名。空 argv 没有语义',
      })
    }

    const timeoutMs = resolveTimeoutMs(req.timeoutMs ?? this.options.timeoutMs)
    const maxBytes = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

    // 密码类认证才需要 askpass；密钥/agent 走 BatchMode，不造临时文件
    const needsAskpass =
      this.options.auth.type === 'password' ||
      this.options.auth.type === 'keyboard-interactive' ||
      (this.options.auth.type === 'key' && this.options.secrets?.passphrase !== undefined)

    let askpass: AskpassHelper | undefined
    if (needsAskpass) {
      const secret = this.options.secrets?.password ?? this.options.secrets?.passphrase
      if (secret === undefined) {
        throw new DpError('DP.SSH.AUTH_FAILED', `认证方式是 ${this.options.auth.type}，但没有解析出凭据`, {
          hint: '本包不解析 passwordRef（那是 schema/config 层的职责）。请在 SshConnectionOptions.secrets 里传入明文',
        })
      }
      askpass = createAskpassHelper(secret)
    }

    const env: Record<string, string> = { ...process.env } as Record<string, string>
    if (askpass !== undefined) Object.assign(env, askpass.env)

    // 远端环境变量走 OpenSSH 的 `-o SetEnv=K=V`（OpenSSH 7.6+）。
    // argv 的形状由 buildExecArgv 统一管（选项 → 主机 → 命令）：三者的顺序错了都还能"成功"，
    // 只是连到别的地方去 —— 命令放到主机前面，ssh 会把它当主机名解析。
    const argv = buildExecArgv(
      this.sshPath,
      this.sshArgvBase(req.env),
      hostTarget(this.options.host, this.options.user),
      req.argv,
    )

    try {
      return await this.spawn(argv, { timeoutMs, maxBytes, env, remoteArgv: req.argv })
    } finally {
      askpass?.dispose()
    }
  }


  private spawn(
    argv: readonly string[],
    ctx: { timeoutMs: number; maxBytes: number; env: Record<string, string>; remoteArgv: readonly string[] },
  ): Promise<DriverExecResult> {
    return new Promise<DriverExecResult>((resolve, reject) => {
      let settled = false
      // detached 让 POSIX 下能建进程组，超时时能一次杀干净
      const child = spawn(argv[0]!, argv.slice(1), {
        env: ctx.env,
        // stdin 给 'ignore' 而不是 'pipe'：铁律 0，本地 ssh 连一个字节都不该收到
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      })

      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }

      const timer = setTimeout(() => {
        killProcessTree(child.pid)
        done(() =>
          reject(
            new DpError('DP.TIMEOUT.EXEC', `SSH 执行超时 ${ctx.timeoutMs}ms`, {
              hint: '增大 timeouts.execMs，或检查远端是否在等待输入。超时已杀掉整个进程树，不会有残留的 ssh 子进程',
            }),
          ),
        )
      }, ctx.timeoutMs)

      const out: Buffer[] = []
      const err: Buffer[] = []

      const onChunk = (sink: Buffer[]) => (chunk: Buffer): void => {
        sink.push(chunk)
        const hit = detectPrompt(chunk.toString('utf8'))
        if (hit !== undefined) {
          killProcessTree(child.pid)
          done(() =>
            reject(
              new DpError('DP.INTERACTIVE_PROMPT_DETECTED', `检测到交互式提示（${hit.kind}）：${hit.line}`, {
                hint: promptHint(hit.kind),
              }),
            ),
          )
        }
      }

      child.stdout.on('data', onChunk(out))
      child.stderr.on('data', onChunk(err))

      child.on('error', (e) => {
        done(() =>
          reject(
            new DpError('DP.SSH.DRIVER_UNAVAILABLE', `无法启动 ${argv[0]}：${e.message}`, {
              cause: e,
              hint: '检查 ssh 是否被安全软件拦截、PATH 是否正确',
            }),
          ),
        )
      })

      child.on('close', (code) => {
        const stdout = truncateOutput(Buffer.concat(out).toString('utf8'), ctx.maxBytes)
        const stderr = truncateOutput(Buffer.concat(err).toString('utf8'), ctx.maxBytes)
        const exitCode = code ?? -1

        // 主机密钥 / 认证类失败**永远**归成结构化错误，不当普通非零退出码返回 ——
        //
        // 只认 255：那是 ssh 客户端自己的失败码。其余非 0 是**远端命令**的退出码，
        // 它的 stderr 里出现 "Permission denied"（比如 mkdir 没权限）与认证失败
        // 长得一样 —— 按文字判就会把一次文件系统错误报成「ssh 认证失败」，
        // 而 hint 还指向 known_hosts，排障方向整个错了。
        if (exitCode === 255) {
          const failure = classifySshError(stderr, exitCode)
          if (
            failure.code === 'DP.SSH.HOST_KEY_MISMATCH' ||
            failure.code === 'DP.SSH.HOST_KEY_UNKNOWN' ||
            failure.code === 'DP.SSH.AUTH_FAILED'
          ) {
            done(() =>
              reject(
                new DpError(failure.code, failure.reason, {
                  hint: hostKeyHint(failure),
                  path: 'hosts.*.ssh.knownHosts',
                }),
              ),
            )
            return
          }
        }

        // 非 0 退出码**不抛** —— 由调用方决定（Runner.exec 的契约）。
        done(() => resolve({ code: exitCode, stdout, stderr }))
      })
    })
  }


  /**
   * 给 rsync 的 `--rsh` 前缀。
   */
  async openTunnel(): Promise<Tunnel> {
    if (this.sshPath === null) {
      const availability = await this.available()
      throw new DpError('DP.SSH.TUNNEL_FAILED', availability.reason ?? '找不到 ssh', {
        hint: availability.hint,
      })
    }
    const rshArgv = buildRshArgv({ ...this.sshArgvBase(), sshPath: this.sshPath })
    return {
      rshArgv,
      close: async () => {
        /* 没有常驻资源：rsync 自己会 spawn 我们给的 rsh，我们只提供 argv */
      },
    }
  }

  async close(): Promise<void> {
    /* 无常驻连接 */
  }

  /** sftp 批量通道（远端文件系统首选路径，见 runner.ts） */
  async runSftpBatch(commands: readonly string[], timeoutMs: number): Promise<DriverExecResult> {
    if (this.sshPath === null) {
      throw new DpError('DP.SSH.TOOL_MISSING', '找不到本地 ssh，无法走 sftp 通道', {
        hint: '降级到 POSIX 命令通道（runner.ts 会自动降级）',
      })
    }
    const sftpPath = resolveTool('sftp', process.env as Readonly<Record<string, string | undefined>>)
    if (sftpPath === null) {
      throw new DpError('DP.SSH.TOOL_MISSING', '找不到本地 sftp', {
        hint: '降级到 POSIX 命令通道（sh -c + base64），功能等价，只是没有 sftp 的长度前缀协议',
      })
    }
    const argv = [
      sftpPath,
      '-b',
      '-',
      ...buildSshArgv(this.sshArgvBase()),
      hostTarget(this.options.host, this.options.user),
    ]
    // 批量脚本从 stdin 喂 —— 这是**协议数据**，不是"喂人类输入"，不违反铁律 0
    return this.spawnWithStdin(argv, commands.join('\n'), timeoutMs)
  }

  private spawnWithStdin(
    argv: readonly string[],
    stdin: string,
    timeoutMs: number,
  ): Promise<DriverExecResult> {
    return new Promise<DriverExecResult>((resolve, reject) => {
      let settled = false
      const child = spawn(argv[0]!, argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      })
      const done = (fn: () => void): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn()
      }
      const timer = setTimeout(() => {
        killProcessTree(child.pid)
        done(() =>
          reject(
            new DpError('DP.TIMEOUT.EXEC', `sftp 批量执行超时 ${timeoutMs}ms`, {
              hint: '检查远端 sftp-server 是否可用，或增大 timeout',
            }),
          ),
        )
      }, timeoutMs)

      const out: Buffer[] = []
      const err: Buffer[] = []
      const onChunk = (sink: Buffer[]) => (chunk: Buffer): void => {
        sink.push(chunk)
        const hit = detectPrompt(chunk.toString('utf8'))
        if (hit !== undefined) {
          killProcessTree(child.pid)
          done(() =>
            reject(
              new DpError('DP.INTERACTIVE_PROMPT_DETECTED', `检测到交互式提示（${hit.kind}）：${hit.line}`, {
                hint: promptHint(hit.kind),
              }),
            ),
          )
        }
      }
      child.stdout.on('data', onChunk(out))
      child.stderr.on('data', onChunk(err))
      child.on('error', (e) =>
        done(() => reject(new DpError('DP.SSH.TOOL_MISSING', `无法启动 ${argv[0]}：${e.message}`, { cause: e }))),
      )
      child.on('close', (code) => {
        const max = this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
        done(() =>
          resolve({
            code: code ?? -1,
            stdout: truncateOutput(Buffer.concat(out).toString('utf8'), max),
            stderr: truncateOutput(Buffer.concat(err).toString('utf8'), max),
          }),
        )
      })

      child.stdin.on('error', () => {
        /* sftp 提前退出时 EPIPE，错误在 close 里已能判出来 */
      })
      child.stdin.end(stdin, 'utf8')
    })
  }
}

/**
 * 偏好链的工厂。**函数而不是 class 导出**：ssh2 走的是按需加载，让调用方只在真正轮到那条驱动时才 import 它，免得一个没装 ssh2 的机器在 import 阶段就炸掉。
 *
 * @param options 与偏好链选出来的那条相同的连接配置
 * @returns 一条**尚未校验可用性**的驱动；能不能用要问它的 `available()`。
 * 工厂不做任何 IO
 */
export function createNativeDriver(options: SshConnectionOptions): SshDriver {
  return new NativeSshDriver(options)
}
