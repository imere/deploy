/**
 * 测试用的假 SSH 驱动。
 *
 * 它**不执行 shell**：它读 posix.ts 在脚本头两行留下的意图（`#dp-op` / `#dp-arg`），
 * 然后在一份内存文件系统上直接给出与真实目标机一致的结果与退出码。
 *
 * 诚实说明这个 fixture 的边界：
 *  - 它验证的是**客户端逻辑** —— argv 构造、路径校验、退出码映射、二进制往返、
 *    截断、超时、prompt 传播。这部分不需要任何机器。
 *  - 它**不**验证脚本体本身。脚本体只有真机能跑，那是 e2e 套件（默认跳过）的职责。
 *
 * prompt / timeout 的处理刻意**模仿真实驱动**：真实驱动是在自己进程里嗅探到
 * prompt 后杀进程并 reject，嗅探逻辑本身由 prompt.test.ts 单独覆盖。
 */
import { DpError } from '@dp/ports'
import { readIntent } from './posix.js'
import { truncateOutput } from './parse.js'
import { detectPrompt, promptHint } from './prompt.js'
import type { DriverAvailability, DriverExecResult, ExecRequest, SshDriver, SshDriverKind } from './driver.js'

export interface ForcedResponse {
  readonly code: number
  readonly stdout?: string
  readonly stderr?: string
}

export interface FakeOptions {
  readonly kind?: SshDriverKind
  /** 命中的 argv → 响应。用于 exec / canElevate / probe 这类非 posix 脚本命令 */
  readonly responses?: Readonly<Record<string, ForcedResponse>>
}

const key = (argv: readonly string[]): string => argv.join(' ')

export class FakeSshDriver implements SshDriver {
  readonly kind: SshDriverKind
  /** 文件内容。目录不放这里，单独用 dirs 记 */
  readonly files = new Map<string, Uint8Array>()
  readonly dirs = new Set<string>(['/'])
  readonly links = new Map<string, string>()
  /** 落在这些路径上的写操作一律以 5（权限失败）结束 */
  readonly denied = new Set<string>()
  /** 按顺序消费的强制响应；用完就回落到内存文件系统 */
  readonly queue: ForcedResponse[] = []

  /** 命中就当作远端吐了交互式 prompt（与真实驱动同款：杀进程并 reject） */
  promptText: string | undefined
  /** 命中就当作超时（与真实驱动同款：杀进程树并 reject） */
  hangOn: string | undefined
  /** 每个 exec 记一笔，便于断言"我们到底发了什么" */
  readonly calls: ExecRequest[] = []
  closed = false

  private readonly responses: Record<string, ForcedResponse>

  constructor(options: FakeOptions = {}) {
    this.kind = options.kind ?? 'ssh2'
    this.responses = { ...(options.responses ?? {}) }
  }

  async available(): Promise<DriverAvailability> {
    return { ok: true }
  }

  async exec(req: ExecRequest): Promise<DriverExecResult> {
    this.calls.push(req)

    // 顺序要紧：prompt 与真实驱动一样是**最先**判定的事 ——
    // 哪怕这条命令本身我们没登记，远端吐了 prompt 依然是 prompt
    if (this.promptText !== undefined) {
      const hit = detectPrompt(this.promptText)
      if (hit !== undefined) {
        throw new DpError('DP.INTERACTIVE_PROMPT_DETECTED', `检测到交互式提示（${hit.kind}）：${hit.line}`, {
          hint: promptHint(hit.kind),
        })
      }
    }

    if (this.hangOn !== undefined && req.argv.join(' ').includes(this.hangOn)) {
      throw new DpError('DP.TIMEOUT.EXEC', `模拟超时：${this.hangOn}`, {
        hint: '真实驱动此时会杀掉整个进程树；假驱动没有进程可杀，但抛的是同一个错误码',
      })
    }

    // 强制响应优先：用来注入"远端返回怪东西"的场景
    const queued = this.queue.shift()
    if (queued !== undefined) return this.shape(queued)

    const named = this.responses[key(req.argv)]
    if (named !== undefined) return this.shape(named)

    if (req.argv[0] !== 'sh' || req.argv[1] !== '-c' || req.argv[2] === undefined) {
      // 非 posix 脚本的裸命令：没有登记就报"没这条命令"，而不是静默成功
      throw new DpError('DP.SSH.DRIVER_UNAVAILABLE', `假驱动没有登记这条命令：${req.argv.join(' ')}`, {
        hint: '在 FakeOptions.responses 里登记它',
      })
    }

    return this.shape(this.runPosix(req.argv[2], req.env))
  }

  async openTunnel(): Promise<{ rshArgv: readonly string[]; close(): Promise<void> }> {
    return { rshArgv: ['ssh', '-o', 'BatchMode=yes'], close: async () => {} }
  }

  async close(): Promise<void> {
    this.closed = true
  }

  // ------------------------------------------------------------

  private shape(r: ForcedResponse): DriverExecResult {
    return {
      code: r.code,
      stdout: truncateOutput(r.stdout ?? '', 1024 * 1024),
      stderr: truncateOutput(r.stderr ?? '', 1024 * 1024),
    }
  }

  private isDenied(p: string): boolean {
    for (const d of this.denied) if (p === d || p.startsWith(`${d}/`)) return true
    return false
  }

  private runPosix(scriptText: string, env?: Readonly<Record<string, string>>): ForcedResponse {
    const intent = readIntent(scriptText)
    if (intent === undefined) {
      return { code: 5, stderr: '脚本缺少 #dp-op 头，说明 posix.ts 的构造被改坏了' }
    }
    const arg = (k: string): string => (intent.args[k] as string | undefined) ?? ''

    switch (intent.op) {
      case 'stat': {
        const p = arg('path')
        if (this.links.has(p)) return { code: 0, stdout: statLine('link', this.links.get(p)!.length, 100) }
        if (this.dirs.has(p)) return { code: 0, stdout: statLine('dir', 0, 100) }
        const f = this.files.get(p)
        if (f !== undefined) return { code: 0, stdout: statLine('file', f.length, 100) }
        return { code: 3, stderr: `stat: ${p}: No such file or directory` }
      }

      case 'list': {
        const p = arg('path')
        if (this.isDenied(p)) return { code: 5, stderr: `ls: cannot open directory '${p}': Permission denied` }
        if (!this.dirs.has(p)) return { code: 3, stderr: `ls: cannot access '${p}'` }
        const prefix = p === '/' ? '/' : `${p}/`
        const names = new Set<string>()
        for (const key2 of [...this.files.keys(), ...this.dirs, ...this.links.keys()]) {
          if (!key2.startsWith(prefix)) continue
          const rest = key2.slice(prefix.length)
          if (rest === '' || rest.includes('/')) continue
          names.add(rest)
        }
        return { code: 0, stdout: [...names].join('\n') + (names.size > 0 ? '\n' : '') }
      }

      case 'mkdir': {
        const p = arg('path')
        if (this.isDenied(p)) return { code: 5, stderr: `mkdir: cannot create directory '${p}': Permission denied` }
        if (!intent.args.recursive) {
          const parent = p.slice(0, p.lastIndexOf('/')) || '/'
          if (!this.dirs.has(parent)) {
            return { code: 5, stderr: `mkdir: cannot create directory '${p}': No such file or directory` }
          }
        }
        for (let d = p; d !== '/' && d !== ''; d = d.slice(0, d.lastIndexOf('/'))) this.dirs.add(d)
        return { code: 0 }
      }

      case 'write': {
        const p = arg('path')
        if (this.isDenied(p)) return { code: 5, stderr: `bash: ${p}: Permission denied` }
        // 数据在脚本里是 `d=<base64>`（posix.ts 的 writeFileScript）。
        // base64 的字符集 `A-Za-z0-9+/=` 全在 quoteArg 的安全集里，所以
        // **不一定带引号** —— 两种形态都要认。
        const b64 = /^d='?([A-Za-z0-9+/=]*)'?$/m.exec(scriptText)?.[1] ?? ''
        this.files.set(p, new Uint8Array(Buffer.from(b64, 'base64')))
        this.dirs.add(p.slice(0, p.lastIndexOf('/')) || '/')
        return { code: 0 }
      }

      case 'read': {
        const p = arg('path')
        const f = this.files.get(p)
        if (f === undefined) {
          if (this.dirs.has(p) || this.links.has(p)) return { code: 3, stderr: `${p} is not a regular file` }
          return { code: 3, stderr: `cat: ${p}: No such file or directory` }
        }
        void env
        return { code: 0, stdout: Buffer.from(f).toString('base64') }
      }

      case 'remove': {
        const p = arg('path')
        if (this.isDenied(p)) return { code: 5, stderr: `rm: cannot remove '${p}': Permission denied` }
        const prefix = `${p}/`
        for (const k of [...this.files.keys()]) if (k === p || k.startsWith(prefix)) this.files.delete(k)
        for (const k of [...this.dirs]) if (k === p || k.startsWith(prefix)) this.dirs.delete(k)
        for (const k of [...this.links.keys()]) if (k === p || k.startsWith(prefix)) this.links.delete(k)
        return { code: 0 }
      }

      case 'rename': {
        const a = arg('from')
        const b = arg('to')
        if (this.isDenied(b)) return { code: 5, stderr: `mv: cannot move '${a}': Permission denied` }
        if (this.links.has(a)) {
          const target = this.links.get(a)!
          this.links.delete(a)
          this.links.set(b, target)
          return { code: 0 }
        }
        // mv 搬的是整棵子树，不是单个条目 —— 原子发布依赖这一点
        const from = [...this.files.keys()].filter((k) => k === a || k.startsWith(`${a}/`))
        if (from.length === 0 && !this.dirs.has(a)) return { code: 5, stderr: `mv: cannot stat '${a}'` }
        for (const k of from) {
          const data = this.files.get(k)!
          this.files.delete(k)
          this.files.set(b + k.slice(a.length), data)
        }
        for (const k of [...this.dirs]) {
          if (k === a || k.startsWith(`${a}/`)) {
            this.dirs.delete(k)
            this.dirs.add(b + k.slice(a.length))
          }
        }
        this.dirs.add(b)
        return { code: 0 }
      }

      case 'symlink': {
        const t = arg('target')
        const l = arg('linkPath')
        if (this.isDenied(l)) return { code: 5, stderr: `ln: failed to create symbolic link '${l}': Permission denied` }
        this.links.set(l, t)
        return { code: 0 }
      }

      case 'readlink': {
        const p = arg('path')
        const t = this.links.get(p)
        if (t === undefined) return { code: this.files.has(p) || this.dirs.has(p) ? 4 : 3 }
        return { code: 0, stdout: `${t}\n` }
      }

      case 'realpath': {
        const p = arg('path')
        let d = p
        while (d !== '/' && d !== '' && !this.dirs.has(d)) d = d.slice(0, d.lastIndexOf('/')) || '/'
        if (!this.dirs.has(d)) return { code: 3, stderr: `cd: ${p}: No such file or directory` }
        const base = p.slice(d.length + 1)
        return { code: 0, stdout: d === '/' ? `/${base}\n` : `${d}/${base}\n` }
      }

      default:
        return { code: 5, stderr: `假驱动不认识的 op：${intent.op}` }
    }
  }
}

const statLine = (kind: string, size: number, mtime: number): string =>
  `DPSTAT\t${kind}\t${size}\t${mtime}\n`
