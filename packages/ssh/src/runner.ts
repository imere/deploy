/**
 * 远端 Runner —— 把 `Runner` 接口落到 SSH 上。
 *
 * 与 packages/local/src/runner.ts 形状完全一致，target 与 core 不需要知道
 * 对面是本机子进程还是三跳之外的机器（transport.md §1 纪律 3）。
 *
 * 路径安全的落点：**任何路径在发出去之前**都先过两道 ——
 *  1. `normalizeRemotePath`：归一化 + 绝对路径 + 允许根校验（防 `..` 逃逸）
 *  2. `checkSourcePaths`（@dp/core）：平台保留名 / 非法字符 / 长度 / 大小写碰撞
 * 传输**第一个字节之前**就发现问题，这正是预检关口的意义。
 *
 * 通道选择：sftp 批量 > POSIX 命令。二进制**只走 base64**，绝不用 echo
 * （echo 会吃掉反斜杠，`printf '%s\n'` 会多补一个换行 —— 都会破坏字节）。
 */
import { DpError, type ExecOptions, type ExecResult, type Facts, type FileStat, type Runner } from '@dp/ports'
import { checkSourcePaths } from '@dp/core'
import type { SshDriver } from './driver.js'
import { DEFAULT_MAX_OUTPUT_BYTES, resolveTimeoutMs } from './driver.js'
import { quoteArg, quoteArgv } from './argv.js'
import { ioError, parseStatLine } from './parse.js'
import {
  listDirScript,
  mkdirScript,
  OP_REALPATH,
  readFileScript,
  readlinkScript,
  realpathScript,
  removeScript,
  renameScript,
  statScript,
  symlinkScript,
  writeFileScript,
} from './posix.js'

// ------------------------------------------------------------
// 退出码 → 错误（约定见 posix.ts）
// ------------------------------------------------------------

const EXIT_NOT_FOUND = 3
const EXIT_NOT_LINK = 4
const EXIT_DENIED = 5
const EXIT_NO_BASE64 = 6

export class RemoteCommandError extends DpError {
  constructor(
    code: 'DP.PATH.NOT_WRITABLE' | 'DP.SSH.TOOL_MISSING',
    message: string,
    options: { hint?: string; cause?: unknown } = {},
  ) {
    super(code, message, options)
  }
}

function raiseForExit(op: string, path: string, code: number, stderr: string): void {
  const detail = stderr.trim().split(/\r?\n/)[0] ?? ''
  switch (code) {
    case EXIT_NOT_FOUND:
      throw ioError('ENOENT', path, detail)
    case EXIT_NOT_LINK:
      throw ioError('EINVAL', path, '不是软链')
    case EXIT_NO_BASE64:
      throw new DpError('DP.SSH.TOOL_MISSING', '远端没有 base64，无法按字节搬运文件', {
        hint: '装 coreutils（提供 base64）；或让本机改走 sftp 通道（sftp 走的是长度前缀二进制协议，不需要 base64）',
      })
    case EXIT_DENIED:
      throw ioError('EACCES', `${op} ${path}`, detail)
    default:
      throw ioError('EIO', `${op} ${path}`, detail === '' ? `远端退出码 ${code}` : detail)
  }
}

// ------------------------------------------------------------
// 路径校验
// ------------------------------------------------------------

export interface PathGuardOptions {
  readonly platform: Facts['platform']
  /** 允许的根。给了就要求每个路径归一化后落在其中一个之下 */
  readonly allowedRoots?: readonly string[]
}

/**
 * 归一化 + 允许根校验。
 *
 * 词法归一化（不解软链）是**故意的**：realpath 需要另一趟往返，而在预检阶段
 * 我们要的是"这个路径字面上能不能接受"。真要防软链逃逸，`Runner.realpath`
 * 之后再查一遍才是那一层 —— 两层分工不同。
 */
export function normalizeRemotePath(path: string, options: PathGuardOptions): string {
  if (path.includes('\0')) {
    throw new DpError('DP.PATH.ILLEGAL_CHAR', '路径含 NUL 字节', {
      path,
      hint: 'NUL 会截断 C 层字符串，是纯粹的注入面',
    })
  }
  if (path === '') {
    throw new DpError('DP.CONFIG.INVALID', '路径为空', { hint: '空路径没有意义' })
  }
  if (!path.startsWith('/')) {
    throw new DpError('DP.PATH.ILLEGAL_CHAR', `远端路径必须是绝对路径：${path}`, {
      path,
      hint: '相对路径取决于登录时的 cwd，而 cwd 随环境而变 —— 部署必须是可重复的',
    })
  }

  const parts: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length === 0) {
        throw new DpError('DP.PATH.ILLEGAL_CHAR', `路径逃出根目录：${path}`, {
          path,
          hint: '不允许越过 / 往上走。要写 /a/../b 就直接写 /b',
        })
      }
      parts.pop()
      continue
    }
    parts.push(seg)
  }
  const normalized = `/${parts.join('/')}`

  // 复用 core 的跨平台校验（保留名 / 非法字符 / 长度 / 大小写碰撞）
  checkSourcePaths([normalized], options.platform)

  if (options.allowedRoots !== undefined) {
    const ok = options.allowedRoots.some((root) => isUnder(normalized, root))
    if (!ok) {
      throw new DpError('DP.PATH.ILLEGAL_CHAR', `路径不在允许根之下：${normalized}`, {
        path: normalized,
        hint: `允许根：${options.allowedRoots.join(' | ')}。越过它们写文件就是路径穿越`,
      })
    }
  }
  return normalized
}

/** `child` 是否等于或在 `root` 之下（按路径段比较，避免 `/srv/appx` 冒充 `/srv/app`） */
export function isUnder(child: string, root: string): boolean {
  const c = root === '/' ? '/' : root.replace(/\/+$/, '')
  if (c === '/') return child.startsWith('/')
  return child === c || child.startsWith(`${c}/`)
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------

export interface SshRunnerOptions {
  readonly driver: SshDriver
  readonly facts: Facts
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  /** 允许写入的根；不给则只做绝对路径 + 平台校验 */
  readonly allowedRoots?: readonly string[]
  /** 请求的环境变量（不含凭据） */
  readonly env?: Readonly<Record<string, string>>
}

const toB64 = (data: string | Uint8Array): string =>
  Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64')

export function createSshRunner(options: SshRunnerOptions): Runner {
  const { driver, facts } = options
  const id = `ssh:${options.facts.host}`

  const guard = (p: string): string =>
    normalizeRemotePath(p, { platform: facts.platform, allowedRoots: options.allowedRoots })

  /** 跑一条 POSIX 脚本，返回 `{ code, stdout, stderr }`；非 0 由调用方判定 */
  const sh = async (
    scriptText: string,
    path: string,
    op: string,
    execOptions?: ExecOptions,
  ): Promise<ExecResult> => {
    const res = await driver.exec({
      argv: ['sh', '-c', scriptText],
      timeoutMs: execOptions?.timeoutMs ?? resolveTimeoutMs(options.timeoutMs),
      env: options.env,
    })
    if (res.code !== 0) raiseForExit(op, path, res.code, res.stderr)
    return res
  }

  return {
    id,
    facts,

    // ------------------------------------------------------ exec

    /**
     * 只接 argv，**没有 execShell** —— 注入的面在接口层就被掐掉了
     * （packages/ports/src/index.ts 明确说明）。
     * 要用管道/`&&` 就显式传 `['sh','-c', quoteArgv([...])]`。
     */
    exec(argv: readonly string[], execOptions: ExecOptions = {}): Promise<ExecResult> {
      if (argv.length === 0) {
        return Promise.reject(
          new DpError('DP.CONFIG.INVALID', 'exec 收到空 argv', { hint: '至少给出可执行文件名' }),
        )
      }
      return driver.exec({
        argv,
        timeoutMs: execOptions.timeoutMs ?? resolveTimeoutMs(options.timeoutMs),
        env: options.env,
      })
    },

    // ------------------------------------------------ filesystem

    async stat(path: string): Promise<FileStat | null> {
      const p = guard(path)
      const res = await driver.exec({ argv: ['sh', '-c', statScript(p)], timeoutMs: resolveTimeoutMs(options.timeoutMs) })
      if (res.code === EXIT_NOT_FOUND) return null
      if (res.code !== 0) raiseForExit('stat', p, res.code, res.stderr)
      const parsed = parseStatLine(res.stdout)
      if (parsed === undefined) {
        throw ioError('EIO', `stat ${p}`, `远端输出无法解析：${res.stdout.slice(0, 120)}`)
      }
      return {
        isDirectory: parsed.kind === 'dir',
        isSymbolicLink: parsed.kind === 'link',
        size: parsed.size,
        mtimeMs: parsed.mtimeSec * 1000,
      }
    },

    async listDir(path: string): Promise<readonly string[]> {
      const p = guard(path)
      const res = await driver.exec({
        argv: ['sh', '-c', listDirScript(p)],
        timeoutMs: resolveTimeoutMs(options.timeoutMs),
      })
      // 与 packages/local/src/runner.ts 对齐：不存在返回空数组而不是抛错
      if (res.code === EXIT_NOT_FOUND) return []
      if (res.code !== 0) raiseForExit('listDir', p, res.code, res.stderr)
      return res.stdout.split(/\r?\n/).filter((l) => l !== '')
    },

    async mkdir(path: string, opts?: { recursive?: boolean; mode?: number }): Promise<void> {
      const p = guard(path)
      await sh(mkdirScript(p, opts?.recursive ?? true, opts?.mode ?? 0o755), p, 'mkdir')
    },

    async writeFile(path: string, data: string | Uint8Array, opts?: { mode?: number }): Promise<void> {
      const p = guard(path)
      await sh(writeFileScript(p, toB64(data), opts?.mode ?? 0o644), p, 'writeFile')
    },

    async readFile(path: string): Promise<string> {
      const p = guard(path)
      const res = await sh(readFileScript(p), p, 'readFile')
      return Buffer.from(res.stdout.replace(/\s+/g, ''), 'base64').toString('utf8')
    },

    async readBinary(path: string): Promise<Uint8Array> {
      const p = guard(path)
      const res = await sh(readFileScript(p), p, 'readBinary')
      // 显式转 Uint8Array：Buffer 越过 Runner 边界会绑死 Node 语义
      // （与 packages/local/src/runner.ts 的注释同一理由）
      return new Uint8Array(Buffer.from(res.stdout.replace(/\s+/g, ''), 'base64'))
    },

    async remove(path: string): Promise<void> {
      const p = guard(path)
      await sh(removeScript(p), p, 'remove')
    },

    async rename(from: string, to: string): Promise<void> {
      const a = guard(from)
      const b = guard(to)
      await sh(renameScript(a, b), `${a} → ${b}`, 'rename')
    },

    async symlink(target: string, linkPath: string): Promise<void> {
      // 目标可以是相对路径（软链本来就常用相对形式），所以不做绝对校验；
      // 落点（linkPath）必须校验 —— 那是真正被创建的东西
      const l = guard(linkPath)
      const res = await driver.exec({
        argv: ['sh', '-c', symlinkScript(target, l)],
        timeoutMs: resolveTimeoutMs(options.timeoutMs),
      })
      if (res.code !== 0) {
        throw new DpError('DP.PATH.NOT_WRITABLE', `无法创建软链 ${l} → ${target}`, {
          hint: '检查落点所在目录是否可写、文件系统是否支持软链、目标是否已存在且指向目录（需要加 -n 或先删）',
        })
      }
    },

    async readlink(path: string): Promise<string | null> {
      const p = guard(path)
      const res = await driver.exec({
        argv: ['sh', '-c', readlinkScript(p)],
        timeoutMs: resolveTimeoutMs(options.timeoutMs),
      })
      if (res.code === EXIT_NOT_FOUND) return null
      // 按契约：不是软链返回 null，让调用方自己判断
      if (res.code === EXIT_NOT_LINK) return null
      if (res.code !== 0) raiseForExit('readlink', p, res.code, res.stderr)
      const out = res.stdout.split(/\r?\n/)[0]
      return out === undefined || out === '' ? null : out
    },

    async realpath(path: string): Promise<string> {
      const p = guard(path)
      const res = await sh(realpathScript(p), p, OP_REALPATH)
      const line = res.stdout.split(/\r?\n/)[0]?.trim() ?? ''
      if (line === '') throw ioError('EIO', `realpath ${p}`, '远端返回空路径')
      // 解析结果可能落在允许根之外（软链指向别处）—— 再查一次，这是路径逃逸的真正防线
      return normalizeRemotePath(line, {
        platform: facts.platform,
        allowedRoots: options.allowedRoots,
      })
    },
  }
}

export { quoteArg, quoteArgv }
export const SSH_DEFAULT_MAX_OUTPUT = DEFAULT_MAX_OUTPUT_BYTES
