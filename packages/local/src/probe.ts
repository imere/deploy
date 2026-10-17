import { createServer } from 'node:net'
import { homedir as osHomedir, tmpdir as osTmpdir, platform as osPlatform, arch as osArch } from 'node:os'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { POSIX_WRITE_CANDIDATES, PROBE_TOOLS_SHARED, type Arch, type Capabilities, type Facts, type InitSystem, type Platform } from '@dp/ports'
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

/**
 * 采集一份环境变量**快照**。
 *
 * @returns 不可变副本，键固定为 PATH 加白名单各项（不存在的键为 undefined 而非缺省 '')
 */
export function snapshotEnv(): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = { PATH: process.env.PATH ?? process.env.Path }
  for (const k of ENV_KEYS) out[k] = process.env[k]
  return out
}

/** 探测文件的删除动作。抽成参数是为了让「删不掉」这条路径可测 —— 真机器上要靠权限异常才碰得到。 */
export type ProbeRemove = (path: string) => Promise<unknown>

/**
 * 一次可写性实测的结果。
 */
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
 *
 * @param paths 待实测的路径，通常是候选目录。**必须传**而不是内部取默认：
 * 「探哪些目录」是部署布局的推导结果，探测层自己决定候选就等于把推导复制一份，
 * 两份候选不一致时同一份配置会在本地与远端得出不同的结论
 * @param options 目前只有 remove（注入删除动作）；生产用 fs.rm，测试注入必定失败的版本
 * @returns 每个输入路径一条结论（key 与入参一一对应），外加清理失败的残留路径。
 * 路径互相独立，一个失败不影响其余
 * @throws 理论上不抛：建文件失败按「不可写」记录而不是中断
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

/**
 * 探测参数。全可选，且**缺省值就是「按平台该探的那一套」**。
 */
export interface ProbeOptions {
  /** 需要实测写权限的路径（通常是发布目录候选展开后的结果） */
  readonly writeProbePaths?: readonly string[]
  readonly tools?: readonly string[]
  /** 替换探测文件的删除动作。默认 fs.rm；注入必定失败的版本即可断言「删不掉不改判定、但必须留痕」 */
  readonly removeProbeFile?: ProbeRemove
}

/**
 * 交集成员出自 `@dp/ports` 的 `PROBE_TOOLS_SHARED`（与 `@dp/ssh` 共点同一张表），名字
 * 在这里只写成引用；本文件保住的只有 local 侧的独家成员与顺序。共享表按 ssh 侧的
 * 历史顺序排，本侧顺序不同 —— 顺序是 facts 的可观察面，必须原样保住。
 */
function sharedTool(name: string): string {
  if (PROBE_TOOLS_SHARED.includes(name)) return name
  throw new Error(`共享探测成员 ${name} 已不在 @dp/ports 的 PROBE_TOOLS_SHARED 里：删除它，或把它重新上收两端`)
}

const TOOLS_TO_PROBE: readonly string[] = [
  sharedTool('node'),
  sharedTool('rsync'),
  sharedTool('ssh'),
  sharedTool('tar'),
  sharedTool('gzip'),
  sharedTool('nginx'),
  sharedTool('docker'),
  sharedTool('systemctl'),
  sharedTool('loginctl'),
  // 独家：Windows 服务控制器，init 判「winsvc 是否可达」只认它
  'sc',
  sharedTool('java'),
  sharedTool('python3'),
  sharedTool('git'),
]

// 反向也要钉住：共享表新增成员而本侧没排进探测清单，同样是分叉 —— 装载时立即失败，
// 比两台机器各探各的、facts 对不上要早得多
const UNSORTED_SHARED = PROBE_TOOLS_SHARED.filter((t) => !TOOLS_TO_PROBE.includes(t))
if (UNSORTED_SHARED.length > 0) {
  throw new Error(`@dp/ports 的 PROBE_TOOLS_SHARED 有本侧没排入清单的成员：${UNSORTED_SHARED.join('、')}`)
}

/**
 * 本地事实探测的入口。产出的 `Facts` 是纯数据，**不缓存** ——部署途中权限可能变（提权后、写满磁盘后），拿一份十分钟前的结论去决定当前能不能写，恰好是这类工具最要避免的那种自信。
 *
 * @param options 见 ProbeOptions；不传即按平台取默认候选与默认工具表
 * @returns 目标机事实。值全部是实测结果，`'unknown'` / `'none'` 表示探过但结论为否，
 * 不表示没探 —— 上层靠这个区分「确认不可用」与「还没查」
 */
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

  // 互相独立的四项能力探测并行发出（前三段已经并行；这里照同一形状收敛）。
  // 结论按对象字面量的固定键序落位，可观察顺序不因谁先返回而变
  const [systemdScope, lingerEnabled, canBindPrivilegedPort, sudoAllowlist] = await Promise.all([
    detectSystemdScope(tools, canWrite),
    detectLinger(tools),
    probePrivilegedPort(),
    probeSudoAllowlist(),
  ])

  const capabilities: Capabilities = {
    canWrite,
    canChown: [],
    canSymlink,
    systemdScope,
    lingerEnabled,
    canBindPrivilegedPort,
    sudoAllowlist,
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
