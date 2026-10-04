/**
 * 本机事实探测。
 *
 * 铁律：**能力一律实证，不推断。** 不看 uid 就断定能写 /etc，不看平台就断定有 systemd。
 * 每条结论都是「真的做了一次」，代价是一点启动耗时，收益是预检不会说谎。
 */
import { createServer } from 'node:net'
import { homedir as osHomedir, tmpdir as osTmpdir, platform as osPlatform, arch as osArch } from 'node:os'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { POSIX_WRITE_CANDIDATES, type Arch, type Capabilities, type Facts, type InitSystem, type Platform } from '@dp/ports'
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

/** 探测文件的删除动作。抽成参数是为了让「删不掉」这条路径可测 —— 真机器上要靠权限异常才碰得到。 */
export type ProbeRemove = (path: string) => Promise<unknown>

export interface WritableProbe {
  readonly canWrite: Readonly<Record<string, boolean>>
  /** 建成功、两次删除都没成功回收的探测文件。非空即表示目标目录里有 dp 留下的垃圾 */
  readonly leftovers: readonly string[]
}

const LEFTOVER_RETRY_DELAY_MS = 50

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 删一次就够的机会不多：占用多半是瞬时的（杀毒软件正在扫刚建的文件）。再失败就是真删不掉，不无限重试。 */
async function removeOnceWithRetry(path: string, remove: ProbeRemove): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await remove(path)
      return true
    } catch {
      if (attempt === 0) await sleep(LEFTOVER_RETRY_DELAY_MS)
    }
  }
  return false
}

/**
 * 真实写权限实测：建一个随机名临时文件，**建成功即算可写**，随即删除。
 * 只看 `access(W_OK)` 是不够的 —— 只读挂载、SELinux 标签、WSL `/mnt` 挂载点
 * 都可能让 W_OK 通过而实际写失败。
 *
 * 判定与清理是**两件事**，不放在同一个 try 里：文件真的建出来了，这就是可写的实证，
 * 后面删不掉只说明清理失败（占用 / ACL / 锁），拿它改写判定会把明明可写的目录报成
 * 不可写。清理失败也不吞掉 —— 路径进 `leftovers` 交出去，否则残留会悄悄攒成
 * 一堆、然后把所有候选目录拖成不可写，而没有任何线索指得到它。
 */
export async function probeWritable(
  paths: readonly string[],
  options: { readonly remove?: ProbeRemove } = {},
): Promise<WritableProbe> {
  const remove = options.remove ?? ((p: string) => fs.rm(p, { force: true }))
  const canWrite: Record<string, boolean> = {}
  const leftovers: string[] = []
  await Promise.all(
    paths.map(async (dir) => {
      const probe = join(dir, `.dp-w-${randomBytes(6).toString('hex')}`)
      let created = false
      try {
        const handle = await fs.open(probe, 'wx')
        created = true
        await handle.close()
      } catch {
        // 建不出来才是不可写。close 失败是 fd 的问题，不推翻「文件已经建出来」这个事实
      }
      canWrite[dir] = created
      if (created && !(await removeOnceWithRetry(probe, remove))) leftovers.push(probe)
    }),
  )
  return { canWrite, leftovers }
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
  /** 替换探测文件的删除动作。默认 fs.rm；注入必定失败的版本即可断言「删不掉不改判定、但必须留痕」 */
  readonly removeProbeFile?: ProbeRemove
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
  // 表本身取自 @dp/ports —— 与 @dp/ssh 那份同源。两份 facts 的候选不一致会让同一份
  // 配置在远端能推出 confd、在本机推不出来（表现为「ssh 目标成功、local 目标报权限错」）。
  const candidates =
    options.writeProbePaths ??
    [
      ...(platform === 'win32' ? [] : POSIX_WRITE_CANDIDATES),
      join(home, 'apps'),
      dataHome,
      env.ProgramData ?? 'C:/ProgramData',
      localAppData,
    ].filter(Boolean)

  const [write, canSymlink, init] = await Promise.all([
    probeWritable(candidates, { remove: options.removeProbeFile }),
    probeSymlink(),
    detectInit(tools),
  ])
  const canWrite = write.canWrite

  const capabilities: Capabilities = {
    canWrite,
    canChown: [],
    canSymlink,
    systemdScope: await detectSystemdScope(tools, canWrite),
    lingerEnabled: await detectLinger(tools),
    canBindPrivilegedPort: await probePrivilegedPort(),
    sudoAllowlist: await probeSudoAllowlist(),
    // 没残留时**不放这个键**：调用方用「键不存在」区分「全回收干净」与「压根没探过」
    ...(write.leftovers.length > 0 ? { probeLeftovers: [...write.leftovers] } : {}),
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
