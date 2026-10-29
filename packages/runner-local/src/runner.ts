import { promises as fs } from 'node:fs'
import { ERR, DpError, type ExecOptions, type ExecResult, type Facts, type FileStat, type Runner } from '@dp/ports'
import { run } from './exec.js'

function toDpError(err: unknown, path: string): DpError {
  const code = (err as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') {
    return new DpError(ERR.PATH.NOT_WRITABLE, `路径不存在：${path}`, { cause: err })
  }
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
    return new DpError(ERR.PATH.NOT_WRITABLE, `无权访问：${path}`, {
      cause: err,
      hint: '检查权限 / 只读挂载 / SELinux 标签。我们绝不会替你 chown 系统目录也不改 ACL —— 授权必须由运维显式完成',
    })
  }
  if (code === 'ENOSPC') {
    return new DpError(ERR.PATH.NOT_WRITABLE, `磁盘已满：${path}`, {
      cause: err,
      hint: '清理空间后重试；目标程序如果依赖写临时文件，即使空间腾出也要重启它',
    })
  }
  return new DpError(ERR.PATH.NOT_WRITABLE, `${path}：${(err as Error).message}`, { cause: err })
}

/**
 * 把端口契约落到本地文件系统与子进程上；除了透传进来的 facts，不持有任何跨调用的状态。
 *
 * @param facts 由 probeLocalFacts 实测得来。这里只做透传不校验：
 * Runner 无法重新核实一份 facts（那就等于把探测重做一遍），而目标层需要原样
 * 拿着它做决策
 * @returns 实现 ports.Runner 的对象，所有方法直接落到本地文件系统与子进程
 */
export function createLocalRunner(facts: Facts): Runner {
  const id = `local:${facts.host}`

  return {
    id,
    facts,

    exec(argv: readonly string[], options: ExecOptions = {}): Promise<ExecResult> {
      return run(argv, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        env: options.env,
        stdin: options.stdin,
      })
    },

    async stat(path: string): Promise<FileStat | null> {
      try {
        const s = await fs.lstat(path)
        return {
          isDirectory: s.isDirectory(),
          isSymbolicLink: s.isSymbolicLink(),
          size: s.size,
          mtimeMs: s.mtimeMs,
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw toDpError(err, path)
      }
    },

    async listDir(path: string): Promise<readonly string[]> {
      try {
        return await fs.readdir(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw toDpError(err, path)
      }
    },

    async mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> {
      try {
        await fs.mkdir(path, {
          recursive: options?.recursive ?? true,
          mode: options?.mode ?? 0o755,
        })
      } catch (err) {
        throw toDpError(err, path)
      }
    },

    async writeFile(path: string, data: string | Uint8Array, options?: { mode?: number }): Promise<void> {
      try {
        await fs.writeFile(path, data, { mode: options?.mode ?? 0o644 })
      } catch (err) {
        throw toDpError(err, path)
      }
    },

    async readFile(path: string): Promise<string> {
      try {
        return await fs.readFile(path, 'utf8')
      } catch (err) {
        throw toDpError(err, path)
      }
    },

    async readBinary(path: string): Promise<Uint8Array> {
      try {
        // 显式拷成 Uint8Array：Buffer 是 Node 特有的子类，越过 Runner 边界泄漏出去
        return new Uint8Array(await fs.readFile(path))
      } catch (err) {
        throw toDpError(err, path)
      }
    },

    async remove(path: string): Promise<void> {
      try {
        await fs.rm(path, { recursive: true, force: true })
      } catch (err) {
        throw toDpError(err, path)
      }
    },

    async rename(from: string, to: string): Promise<void> {
      try {
        await fs.rename(from, to)
      } catch (err) {
        throw toDpError(err, `${from} → ${to}`)
      }
    },

    async readlink(path: string): Promise<string | null> {
      try {
        return await fs.readlink(path)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        // 不是软链（EINVAL / UNKNOWN）—— 按契约返回 null，让调用方自己判断
        return null
      }
    },

    async symlink(target: string, linkPath: string): Promise<void> {
      try {
        await fs.symlink(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      } catch (err) {
        throw new DpError(ERR.PATH.NOT_WRITABLE, `无法创建软链 ${linkPath} → ${target}`, {
          cause: err,
          hint:
            process.platform === 'win32'
              ? 'Windows 创建 symlink 需要开发者模式或管理员权限；无特权时会退化为目录复制'
              : '检查目标是否存在、文件系统是否支持软链',
        })
      }
    },

    async realpath(path: string): Promise<string> {
      try {
        return await fs.realpath(path)
      } catch (err) {
        throw toDpError(err, path)
      }
    },
  }
}
