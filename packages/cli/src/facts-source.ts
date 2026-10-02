/**
 * 目标机事实的获取 —— `plan` 与 `facts` 两个命令共用。
 *
 * 这是本包**唯一**组装具体实现的地方（DESIGN.md §12 第 4 条）：core / local /
 * ssh 都互不认识，只有 CLI 知道「local 主机走 probeLocalFacts，ssh 主机走
 * connectSsh」。
 *
 * 铁律 0 落在两处：连接一定带 timeout；ssh 连接的认证只从**已存在的**密钥材料
 * 或 agent 推断，绝不弹窗 —— 推断不出来就报错，不猜。
 */
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { existsSync, promises as fs } from 'node:fs'
import { DpError, type Facts, type Platform, type Runner } from '@dp/ports'
import type { HostConfig } from '@dp/schema'
import type { Logger } from '@dp/log'
import { probeLocalFacts, probeWritable } from '@dp/local'
import { connectSsh, type SshConnectionOptions } from '@dp/ssh'
import { RELEASE_ROOT_CANDIDATES, expandTemplate } from '@dp/core'

export const DEFAULT_CONNECT_TIMEOUT_MS = 30_000

/**
 * 展开某个项目名在**当前平台的所有布局**下的发布根候选。
 *
 * 为什么必须做这一步：probeLocalFacts 默认探测的是 /srv、/opt 这类**通用**目录，
 * 而 pickReleaseRoot 查的是 `canWrite[<root>/<name>]` —— 展开后的具体路径。
 * 不补这一次探测，plan 在任何没显式写 release.root 的项目上都会报
 * 「没有可写的发布目录」，而这恰恰是最常见的情况。
 *
 * **只展开当前平台的候选**：RELEASE_ROOT_CANDIDATES 是按 platform 分组的，
 * 在 Windows 上展开 `/srv/<name>` 会退化成 `F:\srv\<name>`，于是
 * nearestExistingDir 一路冒到盘符根，去探测 `F:\` 能不能写 —— 既慢（实测 2.4s/个，
 * 一次 plan 因此多花 20s），又会在结果里塞进一堆毫无意义的 POSIX 路径，
 * 让「发布根候选」这一栏变成噪音。
 */
export function releaseRootCandidates(
  name: string,
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: Platform,
): string[] {
  const byLayout = RELEASE_ROOT_CANDIDATES[platform] ?? RELEASE_ROOT_CANDIDATES.unknown
  const out: string[] = []
  for (const templates of Object.values(byLayout)) {
    for (const tpl of templates) out.push(expandTemplate(tpl, { name, homedir: home, env }))
  }
  return [...new Set(out)]
}

export interface FactsRequest {
  readonly hostId: string
  readonly host: HostConfig
  readonly logger?: Logger
  readonly env?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  /** 给了就补测该项目展开后的发布根候选（只对 local 有意义） */
  readonly projectName?: string
  /** 配置里显式写的 release.root：它优先于候选，必须单独实测 */
  readonly releaseRoot?: string
}

export interface FactsResult {
  readonly facts: Facts
  readonly probeNotes: readonly string[]
  /** 有连接需要关时非空；调用方必须在 finally 里调它 */
  readonly close: (() => Promise<void>) | undefined
  /**
   * 已连上的那台机器的 Runner —— **只有 ssh 路径有**。
   *
   * 为什么单独交出来而不是让 apply 自己再连一次：探测要跑十几条命令，
   * 重复连接既慢又可能因为主机密钥/瞬时抖动而第二次失败。复用同一条连接
   * 也保证了「探测看到的机器」与「写入的机器」物理上就是同一台。
   *
   * 刻意保持可选且可缺省：local 路径**不**填（Runner 由调用方按需用
   * createLocalRunner(facts) 现造，不需要 IO），plan/facts 两条只读命令也
   * 完全不读这个字段 —— 所以既有调用方一行都不用改。
   */
  readonly runner?: Runner
}

/** `user@host[:port]` —— 纯解析，不猜端口（SSH 的默认端口由驱动自己决定） */
export function parseSshTarget(value: string, path: string): { host: string; user?: string; port?: number } {
  const at = value.lastIndexOf('@')
  const userPart = at >= 0 ? value.slice(0, at) : undefined
  const hostPart = at >= 0 ? value.slice(at + 1) : value
  if (hostPart === '') {
    throw new DpError('CONFIG_INVALID', `ssh 目标为空：${JSON.stringify(value)}`, {
      path,
      hint: '写成 user@host 或 user@host:port，例如 deploy@10.0.0.5:2222',
    })
  }
  const colon = hostPart.lastIndexOf(':')
  if (colon > 0) {
    const portText = hostPart.slice(colon + 1)
    const port = Number(portText)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new DpError('CONFIG_INVALID', `端口不合法：${portText}`, {
        path,
        hint: '端口必须是 1–65535 的整数。不写端口就用 SSH 的默认值（22）',
      })
    }
    return { user: userPart, host: hostPart.slice(0, colon), port }
  }
  return { user: userPart, host: hostPart }
}

/**
 * 认证方式。**只认非交互来源**：
 *  - DP_SSH_KEY 指向的密钥文件 → key
 *  - 否则 ~/.ssh 下存在的常规私钥 → key
 *  - 都没有 → agent（交给系统 ssh 决定；没有 agent 时它会立刻失败，不会等输入）
 *
 * 导出：apply 的传输层要构造自己的 ssh argv（rsync 的 -e / tar 的远端命令），
 * 必须用**同一套**判定 —— 另立一套就会出现「探测用密钥 A、传输用 agent」
 * 这种探测成功但传输要密码的死锁。
 */
export function resolveAuth(env: NodeJS.ProcessEnv, path: string): SshConnectionOptions['auth'] {
  const explicit = env['DP_SSH_KEY']
  if (explicit !== undefined && explicit !== '') {
    return { type: 'key', identityFile: explicit }
  }
  const candidates = ['id_ed25519', 'id_rsa', 'id_ecdsa']
  const dir = join(env['HOME'] ?? homedir(), '.ssh')
  for (const name of candidates) {
    if (existsSync(join(dir, name))) return { type: 'key', identityFile: join(dir, name) }
  }
  return { type: 'agent' }
}

/** 向上找第一个**已存在**的祖先目录。候选发布根通常还不存在，直接测必然失败。 */
export function nearestExistingDir(path: string): string {
  let dir = path
  for (;;) {
    if (existsSync(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) return dir
    dir = parent
  }
}

/**
 * 探测「能不能把发布根建出来」。
 *
 * probeWritable 只能测已存在的目录，而 pickReleaseRoot 查的是 canWrite[<root>/<name>]，
 * 那个路径多数时候还不存在。所以这里退一步：路径不存在就测它最近的已存在祖先
 * —— 祖先可写即意味着这条路径可被创建。
 *
 * 保守性：只沿**祖先**回退，不跨盘符判断，也不假设中间目录都已存在。
 */
export async function probeCreatable(
  paths: readonly string[],
  /** 已经测过的目录 → 结论。重复建文件去测同一个目录纯属浪费（每次都是真实 IO） */
  known: Readonly<Record<string, boolean>> = {},
): Promise<Record<string, boolean>> {
  const probes = paths.map((p) => nearestExistingDir(p))
  const pending = [...new Set(probes)].filter((p) => known[p] === undefined)
  const measured = await probeWritable(pending)
  const resolved: Record<string, boolean> = { ...known, ...measured }
  const out: Record<string, boolean> = {}
  for (let i = 0; i < paths.length; i += 1) {
    // 祖先可写即意味着这条路径可被创建 —— 实测的语义是「在 probe 目录里建文件成功」
    out[paths[i] as string] = resolved[probes[i] as string] === true
  }
  return out
}

export async function acquireFacts(request: FactsRequest): Promise<FactsResult> {
  const env = request.env ?? process.env
  const timeoutMs = request.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const host = request.host

  if (host.local === true) {
    const base = await probeLocalFacts()
    const facts: Facts = { ...base, host: request.hostId }
    if (request.projectName === undefined) {
      return { facts, probeNotes: [], close: undefined }
    }
    // 补测发布根：只加 key，不覆盖 probeLocalFacts 已给出的结论。
    // 写了显式 release.root 时**只测它一个** —— pickReleaseRoot 见到 explicitRoot 就短路，
    // 候选列表根本不会被读，此时再展开十几个候选去逐个建文件，纯属白干。
    const targets =
      request.releaseRoot === undefined
        ? releaseRootCandidates(request.projectName, base.homedir, base.env, base.platform)
        : [request.releaseRoot]
    const extra = await probeCreatable(targets, base.capabilities.canWrite)
    return {
      facts: {
        ...facts,
        capabilities: {
          ...base.capabilities,
          canWrite: { ...base.capabilities.canWrite, ...extra },
        },
      },
      probeNotes: [],
      close: undefined,
    }
  }

  if (host.ssh === undefined) {
    throw new DpError('CONFIG_INVALID', `主机 ${request.hostId} 既没有 local: true 也没有 ssh`, {
      path: `hosts.${request.hostId}`,
      hint: '写 { "local": true } 指向本机，或写 { "ssh": "user@host:port" } 指向远端。两者都没有就无法确定目标',
    })
  }

  const target = parseSshTarget(host.ssh, `hosts.${request.hostId}.ssh`)
  const options: SshConnectionOptions = {
    host: target.host,
    auth: resolveAuth(env, `hosts.${request.hostId}.ssh`),
    knownHosts: 'strict',
    timeoutMs,
    // 端口与用户不写就交给驱动默认值（22 / 本机用户名），不猜
    ...(target.user !== undefined ? { user: target.user } : {}),
    ...(target.port !== undefined ? { port: target.port } : {}),
  }

  const connected = await connectSsh(options, {
    ...(request.logger !== undefined ? { logger: request.logger } : {}),
    timeoutMs,
  })
  return {
    facts: { ...connected.facts, host: request.hostId },
    probeNotes: connected.probeNotes,
    close: () => connected.close(),
    // 同一条连接上的 Runner 交给调用方复用，别让人为了写文件再连一次
    runner: connected.runner,
  }
}

/**
 * 读 `--facts <file>`。存在的意义就是让 CI 能把 `dp facts --json > facts.json`
 * 存下来，之后 `dp plan --facts facts.json` 完全离线跑 —— 复现问题与单元测试
 * 都靠它，且顺带避免了测试环境里真的去连目标机。
 */
export async function readFactsFile(path: string): Promise<Facts> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (err) {
    throw new DpError('CONFIG_INVALID', `读 facts 文件失败：${path}`, {
      path: '--facts',
      hint: '先跑 `dp facts --json > facts.json` 生成它；注意主机名要与你现在选的 --host 一致',
      cause: err,
    })
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new DpError('CONFIG_INVALID', `facts 文件不是合法 JSON：${path}`, {
      path: '--facts',
      hint: '必须是 `dp facts --json` 的原样输出',
      cause: err,
    })
  }
  const value = (raw as { facts?: unknown }).facts ?? raw
  return assertFacts(value, path)
}

/** 只校验 makePlan 真正读到的字段。整份 Facts 逐字段校验是过度工程，且会让夹具难写。 */
function assertFacts(value: unknown, path: string): Facts {
  if (value === null || typeof value !== 'object') {
    throw new DpError('CONFIG_INVALID', `facts 文件内容不是对象：${path}`, { path: '--facts' })
  }
  const v = value as Record<string, unknown>
  const missing = ['host', 'platform', 'arch', 'init', 'homedir', 'tmpdir'].filter((k) => v[k] === undefined)
  if (missing.length > 0) {
    throw new DpError('CONFIG_INVALID', `facts 文件缺少必填字段：${missing.join(' | ')}`, {
      path: '--facts',
      hint: '重新用 `dp facts --json > facts.json` 生成',
    })
  }
  const caps = (v['capabilities'] ?? {}) as Record<string, unknown>
  if (typeof caps['canWrite'] !== 'object' || caps['canWrite'] === null) {
    throw new DpError('CONFIG_INVALID', 'facts 文件缺少 capabilities.canWrite', {
      path: '--facts',
      hint: '发布根候选的可写性全靠它推导，缺了 plan 就无法确定发布目录',
    })
  }
  return value as unknown as Facts
}
