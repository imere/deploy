/**
 * 远端 Runner —— 把 `Runner` 接口落到 SSH 上。
 *
 * 与 packages/local/src/runner.ts 形状完全一致，target 与 core 不需要知道
 * 对面是本机子进程还是三跳之外的机器。
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

/**
 * 远端命令以本文件约定的退出码结束时的错误。
 *
 * 单列一个类而不是直接用 `DpError`：调用方需要区分「路径/工具问题」
 * 与「连接问题」，而两者的处置完全不同 —— 前者改配置，后者查机器。
 * 它仍然继承 `DpError`，所以 `catch (e) { e instanceof DpError }` 的老代码照常工作。
 */
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

/**
 * 路径守卫的配置。**不给 allowedRoots 就是不做那一层校验**，
 * 而不是"允许一切"—— 前者只是少一道检查，后者是一个听起来像默认放行的语义。
 */
export interface PathGuardOptions {
  /** 目标平台。决定保留名、非法字符、大小写碰撞这三组规则的哪一套生效 */
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
 *
 * 拒绝越过 `/` 的 `..` 而不是照着 pop 到空：那是把"路径逃出根目录"这件事
 * 交给调用方判断，而调用方不会判断 —— 它只会拿到一个看着正常的路径。
 *
 * @param path 待校验的远端路径。必须是绝对路径：相对路径取决于登录时的 cwd，
 *   而 cwd 随 sshd 配置与 shell 而变，同样的配置在两台机器上会落到不同地方
 * @param options 平台与允许根
 * @returns 归一化后的绝对路径（无冗余分隔符、无 `.`、无未消解的 `..`）。**原样返回**
 *   是允许的 —— 归一化不改变含义时不必制造一个看起来不同的字符串
 * @throws DpError 路径为空、含 NUL、非绝对、`..` 越过根、违反平台命名规则，
 *   或归一化后不在任何允许根之下（`DP.PATH.ILLEGAL_CHAR`）
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

/**
 * `child` 是否等于或在 `root` 之下（按路径段比较，避免 `/srv/appx` 冒充 `/srv/app`）
 *
 * 按字符串前缀比是这类检查的标准错法：`startsWith('/srv/app')` 会把
 * `/srv/application` 判成在里面，于是**路径穿越检查在一个字母之差上失效**。
 *
 * @param child 待检查的路径。**不做归一化**，所以调用方要先过
 *   {@link normalizeRemotePath} —— 这里只判段，不判 `..`
 * @param root 允许的根。`/` 是合法的根，表示"任意绝对路径"；尾部的 `/` 会被忽略，
 *   `/srv/` 与 `/srv` 等价
 * @returns `child === root` 或 `child` 以 `root + "/"` 开头时才为 true
 */
export function isUnder(child: string, root: string): boolean {
  const c = root === '/' ? '/' : root.replace(/\/+$/, '')
  if (c === '/') return child.startsWith('/')
  return child === c || child.startsWith(`${c}/`)
}

// ------------------------------------------------------------
// Runner
// ------------------------------------------------------------

/**
 * 组装 Runner 需要的全部东西。**facts 必填**而不是可选：
 * 路径校验要用平台与能力，权限判定要用实测结果，两样都只能来自 facts，
 * 这里没有任何"从环境变量猜一份"的余地。
 */
export interface SshRunnerOptions {
  /** 执行通道。Runner 不自己 spawn，只把它要跑的 argv 与超时交给它 */
  readonly driver: SshDriver
  /** 目标机事实。既用于路径校验，也原样挂在 `Runner.facts` 上供 plan 用 */
  readonly facts: Facts
  /** 全局超时（毫秒）。方法级 `ExecOptions.timeoutMs` 优先于它 */
  readonly timeoutMs?: number
  /** 单次执行保留的输出字节上限。**每次执行都套**，不是每次部署 —— 一条跑飞的远端命令会打爆的是本机内存 */
  readonly maxOutputBytes?: number
  /** 允许写入的根；不给则只做绝对路径 + 平台校验 */
  readonly allowedRoots?: readonly string[]
  /** 请求的环境变量（不含凭据） */
  readonly env?: Readonly<Record<string, string>>
}

const toB64 = (data: string | Uint8Array): string =>
  Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64')

/**
 * 把 {@link SshDriver} 装成 {@link Runner}。
 *
 * 路径安全集中在 `guard` 一处：每个方法在**发出第一个字节之前**先过
 * {@link normalizeRemotePath}，而不是在某个共用的 helper 里补一次 ——
 * 漏接一个方法的代价是「有一条 API 路径能写到允许根之外」，而它不会报错。
 *
 * `stat` / `listDir` / `readlink` 对"不存在"返回 `null` / 空数组，
 * `realpath` 的解析结果**再过一次 guard**：软链指向别处是路径逃逸的真正入口，
 * 而那一层只有解析之后才看得见。
 *
 * @param options 见 {@link SshRunnerOptions}。`id` 由 host 推导（`ssh:<host>`），
 *   两台不同驱动连同一台机器的 Runner 靠它区分
 * @returns 一个 {@link Runner}。它**不持有连接的生命周期** —— 关闭连接是
 *   `ConnectedSsh.close` 的事，否则一次 close 会把别人的 Runner 一起弄坏
 */
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
/**
 * 便捷重导出：调用方不必 import driver.ts 就能拿到同一个上限值。
 *
 * **别名而不是第二份字面量** —— 两个数字一旦各自定义，早晚会出现
 * 「限流用的上限」与「报告里说的上限」对不上的情况，而那种不一致只在事后才看得见。
 */
export const SSH_DEFAULT_MAX_OUTPUT = DEFAULT_MAX_OUTPUT_BYTES
