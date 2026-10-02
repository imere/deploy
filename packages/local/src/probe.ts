/**
 * 本机事实探测。
 *
 * 铁律：**能力一律实证，不推断。** 不看 uid 就断定能写 /etc，不看平台就断定有 systemd。
 * 每条结论都是「真的做了一次」，代价是一点启动耗时，收益是预检不会说谎
 * （docs/privilege.md §1、docs/preflight.md）。
 */
import { createServer } from 'node:net'
import { homedir as osHomedir, tmpdir as osTmpdir, platform as osPlatform, arch as osArch } from 'node:os'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { Arch, Capabilities, Facts, InitSystem, Platform } from '@dp/ports'
import { resolveTool, run } from './exec.js'

function mapPlatform(p: NodeJS.Platform): Platform {
  switch (p) {
    case 'linux':
      return 'linux'
    case 'darwin':
      return 'darwin'
    case 'win32':
      return 'win32'
    case 'freebsd':
      return 'freebsd'
    default:
      return 'unknown'
  }
}

function mapArch(a: string): Arch {
  switch (a) {
    case 'x64':
      return 'x64'
    case 'arm64':
      return 'arm64'
    case 'ia32':
      return 'x86'
    case 'arm':
      return 'arm'
    default:
      return 'other'
  }
}

const ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_RUNTIME_DIR',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramData',
  'USERPROFILE',
  'ComSpec',
  'Path',
] as const

export function snapshotEnv(): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = { PATH: process.env.PATH ?? process.env.Path }
  for (const k of ENV_KEYS) out[k] = process.env[k]
  return out
}

/**
 * 真实写权限实测：建一个随机名临时文件，成功即算可写，随即删除。
 * 只看 `access(W_OK)` 是不够的 —— 只读挂载、SELinux 标签、WSL `/mnt` 挂载点
 * 都可能让 W_OK 通过而实际写失败。
 */
export async function probeWritable(paths: readonly string[]): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {}
  await Promise.all(
    paths.map(async (dir) => {
      const probe = join(dir, `.dp-w-${randomBytes(6).toString('hex')}`)
      try {
        const handle = await fs.open(probe, 'wx')
        await handle.close()
        await fs.rm(probe, { force: true })
        result[dir] = true
      } catch {
        result[dir] = false
      }
    }),
  )
  return result
}

async function probeSymlink(): Promise<boolean> {
  const base = join(osTmpdir(), `.dp-s-${randomBytes(6).toString('hex')}`)
  const link = `${base}-link`
  try {
    await fs.mkdir(base, { recursive: true })
    await fs.symlink(base, link, process.platform === 'win32' ? 'junction' : 'dir')
    return true
  } catch {
    return false
  } finally {
    await fs.rm(link, { force: true })
    await fs.rm(base, { recursive: true, force: true })
  }
}

/** 真的 bind 一次特权端口 —— 「uid 是否为 0」这种推断在容器 / macOS 上都会失真 */
async function probePrivilegedPort(): Promise<boolean> {
  return new Promise((r) => {
    const server = createServer()
    server.once('error', () => r(false))
    server.listen(1, '127.0.0.1', () => {
      server.close(() => r(true))
    })
  })
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

async function detectInit(tools: Record<string, string | null>): Promise<InitSystem> {
  if (process.platform === 'darwin') return 'launchd'
  if (process.platform === 'win32') return tools.sc !== null ? 'winsvc' : 'none'
  if (await exists('/run/systemd/system')) return 'systemd'
  if (await exists('/sbin/openrc-run')) return 'openrc'
  if (await exists('/etc/init.d')) return 'sysvinit'
  return 'none'
}

async function detectSystemdScope(
  tools: Record<string, string | null>,
  canWrite: Record<string, boolean>,
): Promise<Capabilities['systemdScope']> {
  const systemctl = tools.systemctl ?? null
  if (systemctl === null) return 'none'
  if (canWrite['/etc/systemd/system'] === true) return 'system'
  if (process.env.XDG_RUNTIME_DIR !== undefined) {
    try {
      const res = await run([systemctl, '--user', 'status'], { timeoutMs: 5000 })
      if (res.code === 0 || !/Failed to connect/.test(res.stderr)) return 'user'
    } catch {
      /* 视为不可用 */
    }
  }
  return 'none'
}

async function detectLinger(tools: Record<string, string | null>): Promise<boolean> {
  const loginctl = tools.loginctl ?? null
  if (loginctl === null || process.platform === 'win32') return false
  try {
    const res = await run([loginctl, 'show-user', process.env.USER ?? '', '--property=Linger'], {
      timeoutMs: 5000,
    })
    return /Linger=yes/.test(res.stdout)
  } catch {
    return false
  }
}

/**
 * 「能 sudo 哪些命令」而不是「能不能 sudo」。
 * `sudo -n true` 成功说明**完全免密**；更常见的情况是只有白名单里的几条免密，
 * 那种精细情形留给 sudoers 解析（TODO），这里老实返回保守结果。
 */
async function probeSudoAllowlist(): Promise<readonly string[]> {
  if (process.platform === 'win32') return []
  try {
    const res = await run(['sudo', '-n', 'true'], { timeoutMs: 5000 })
    return res.code === 0 ? ['ALL'] : []
  } catch {
    return []
  }
}

export interface ProbeOptions {
  /** 需要实测写权限的路径（通常是发布目录候选展开后的结果） */
  readonly writeProbePaths?: readonly string[]
  readonly tools?: readonly string[]
}

const TOOLS_TO_PROBE = [
  'node',
  'rsync',
  'ssh',
  'tar',
  'gzip',
  'nginx',
  'docker',
  'systemctl',
  'loginctl',
  'sc',
  'java',
  'python3',
  'git',
] as const

export async function probeLocalFacts(options: ProbeOptions = {}): Promise<Facts> {
  const env = snapshotEnv()
  const home = osHomedir()

  const toolNames = options.tools ?? TOOLS_TO_PROBE
  const tools: Record<string, string | null> = {}
  for (const name of toolNames) {
    tools[name] = resolveTool(name, env)
  }

  const platform = mapPlatform(osPlatform())
  const dataHome = env.XDG_DATA_HOME ?? join(home, '.local', 'share')
  const localAppData = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')

  // 候选按平台分流：/srv、/opt 这类 POSIX 目录在 Windows 上会被解析成 C:\srv 之类
  // 根本不存在的位置，探它们既没意义又拖慢启动（每次探测都是一次真实建文件+删除）。
  // `/etc/nginx/conf.d` 在表里的理由：@dp/ssh 的 DEFAULT_WRITE_PATHS 有它，nginx 目标
  // 的 confd 推导只读 `canWrite` —— 两份 facts 来源的候选不一致，会让同一份配置在
  // 远端能推出来、在本机推不出来（表现为「ssh 目标成功、local 目标报权限错」）。
  const posixDirs = [
    '/srv',
    '/opt',
    '/usr/local',
    '/var/lib',
    '/var/www',
    '/etc/systemd/system',
    '/etc/nginx/conf.d',
  ]
  const candidates =
    options.writeProbePaths ??
    [
      ...(platform === 'win32' ? [] : posixDirs),
      join(home, 'apps'),
      dataHome,
      env.ProgramData ?? 'C:/ProgramData',
      localAppData,
    ].filter(Boolean)

  const [canWrite, canSymlink, init] = await Promise.all([
    probeWritable(candidates),
    probeSymlink(),
    detectInit(tools),
  ])

  const capabilities: Capabilities = {
    canWrite,
    canChown: [],
    canSymlink,
    systemdScope: await detectSystemdScope(tools, canWrite),
    lingerEnabled: await detectLinger(tools),
    canBindPrivilegedPort: await probePrivilegedPort(),
    sudoAllowlist: await probeSudoAllowlist(),
  }

  return {
    host: 'local',
    platform,
    arch: mapArch(osArch()),
    init,
    homedir: home,
    tmpdir: osTmpdir(),
    env,
    capabilities,
    tools,
  }
}
