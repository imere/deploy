import type { Arch, Capabilities, Facts, InitSystem, Platform } from '@dp/ports'
import { DpError, POSIX_WRITE_CANDIDATES, PROBE_TOOLS_SHARED } from '@dp/ports'
import type { SshDriver } from './driver.js'
import { resolveTimeoutMs } from './driver.js'
import {
  parseArch,
  parseInit,
  parseLinger,
  parsePlatform,
  parseSudoList,
  parseToolPaths,
} from './parse.js'
import { wrapCommand, ELEVATE_FAILED_HINT } from './become.js'
import type { BecomeConfig } from '@dp/ports'

/**
 * 交集成员出自 `@dp/ports` 的 `PROBE_TOOLS_SHARED`（两台 facts 来源都从那张表点名），
 * 名字在这里只写成引用；本文件保住的只有本侧的独家成员与顺序 ——
 * 双份手抄交集正是「同一份配置远端推得出来、本地推不出来」的分叉温床。
 */
function sharedTool(name: string): string {
  if (PROBE_TOOLS_SHARED.includes(name)) return name
  throw new Error(`共享探测成员 ${name} 已不在 @dp/ports 的 PROBE_TOOLS_SHARED 里：删除它，或把它重新上收两端`)
}

const TOOLS_TO_PROBE: readonly string[] = [
  sharedTool('ssh'),
  // 独家：scp 传输档判的是**两端**都要有 —— 目标机这份必须实测，local 目标不跨机、不用探
  'scp',
  // 独家：sftp 的客户端由驱动在本地现解析（服务端是 sshd 子系统，不是独立命令），
  // 目标机探它只为 facts 能摆出这台机器的全貌
  'sftp',
  sharedTool('rsync'),
  sharedTool('tar'),
  sharedTool('gzip'),
  // 独家：按字节读写走 sh -c 通道时要在目标机端过 base64 管道；本地传输直接 node fs，没有这一段
  'base64',
  // 独家：become.type=sudo 的包装 argv 只发生在被连接这一端 ——本机的提权探测不记这张工具表
  'sudo',
  // 独家：become.type=su 同理；busybox su 缺 suid 位这类实证也只有连着的那台机器给得出
  'su',
  // 独家：become.type=doas 的包装，同样只在被连接的一端
  'doas',
  sharedTool('systemctl'),
  sharedTool('loginctl'),
  sharedTool('nginx'),
  sharedTool('docker'),
  sharedTool('git'),
  sharedTool('python3'),
  sharedTool('node'),
  sharedTool('java'),
  // 独家：暂无消费者，探到即留在这端的表里（不进共享表的处置见 @dp/ports 那份说明）
  'openssl',
]

// 反向也要钉住：共享表新增成员而本侧没排进探测清单，同样是分叉 —— 装载时立即失败，
// 比两台机器各探各的、facts 对不上要早得多
const UNSORTED_SHARED = PROBE_TOOLS_SHARED.filter((t) => !TOOLS_TO_PROBE.includes(t))
if (UNSORTED_SHARED.length > 0) {
  throw new Error(`@dp/ports 的 PROBE_TOOLS_SHARED 有本侧没排入清单的成员：${UNSORTED_SHARED.join('、')}`)
}

/**
 * 与 `@dp/local` 共用同一份候选（`@dp/ports` 的那张表），只多一个 `/tmp`：本地探测有 `os.tmpdir()` 可用，远端没有，只能把它列进候选里实测。
 */
const DEFAULT_WRITE_PATHS = [...POSIX_WRITE_CANDIDATES, '/tmp'] as const

/**
 * 探测的开关。**全可选、且都有对应的"默认值来源"**：工具表与候选目录见本文件顶部，环境变量由 `resolveTimeoutMs` 兜底，没有任何一项需要调用方自己算一遍。
 */
export interface ProbeOptions {
  /** 要探测的工具名。给空数组则**一个都不探**，而不是退回默认表 —— 想省往返的调用方要能说清自己在省什么 */
  readonly tools?: readonly string[]
  /** 探测可写性的候选目录。与本地那份共享同一张表，只多一个 `/tmp` */
  readonly writeProbePaths?: readonly string[]
  /** 单次探测的毫秒上限。不给则走 `resolveTimeoutMs` 的三级回落 */
  readonly timeoutMs?: number
  /** 目标机标识。**只进 facts 与日志，不参与任何判定** */
  readonly host: string
  /** sudo 探测的目标用户；不给则用远端自己的 `id -un`（不猜 root） */
  readonly sudoAsUser?: string
}

/**
 * 探测结果。
 */
export interface ProbeResult {
  readonly facts: Facts
  /** 哪些没探到、为什么。plan 必须能打印它 */
  readonly probeNotes: readonly string[]
}

/** 标签前缀：远端脚本按 `DP<NAME>\t<值>` 逐行打，解析层只认这些标签 */
function tagField(stdout: string, tag: string): string | undefined {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith(`${tag}\t`)) continue
    const value = line.slice(tag.length + 1).trim()
    if (value === '') continue
    return value
  }
  return undefined
}

function tagFields(stdout: string, tag: string): readonly string[] {
  const out: string[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith(`${tag}\t`)) continue
    out.push(line.slice(tag.length + 1).trim())
  }
  return out
}

/**
 * 一次远端事实探测。**一条复合脚本拿完所有字段** ——每次 exec 都要穿整条连接（多跳时每多一跳就多一次往返），把 20 次往返合并成 1 次，比把脚本写得多漂亮都值。
 *
 * @param driver 已建立的驱动。**只用它 exec，不开第二条连接** ——
 * 探测用的凭据若与实际执行用的那条不是同一条，探出来的可写性就说明不了任何事
 * @param options 见 {@link ProbeOptions}
 * @returns 事实与全部说明。`facts` 里每个保守默认值都必然在 `probeNotes` 里有一条对应记录，
 * 两者不是各自独立的产出
 */
export async function probeFacts(driver: SshDriver, options: ProbeOptions): Promise<ProbeResult> {
  const notes: string[] = []
  const timeoutMs = resolveTimeoutMs(options.timeoutMs)
  const toolNames = options.tools ?? TOOLS_TO_PROBE
  const writePaths = options.writeProbePaths ?? DEFAULT_WRITE_PATHS

  const tools: Record<string, string | null> = {}
  for (const name of toolNames) tools[name] = null

  let stdout = ''
  try {
    const res = await driver.exec({
      // 一条复合脚本拿完平台/身份/工具/可写性 —— 每次 exec 都要穿整条连接
      argv: ['sh', '-c', compositeProbe(toolNames, writePaths)],
      timeoutMs,
    })
    if (res.code !== 0) {
      notes.push(`复合探测脚本退出码 ${res.code}，平台与工具信息可能不完整`)
    }
    stdout = res.stdout
  } catch (err) {
    notes.push(`复合探测失败：${(err as Error).message}。下面的字段全部是安全默认值，不是实测结论`)
  }

  const platform: Platform = parsePlatform(tagField(stdout, 'DPOS') ?? '')
  if (tagField(stdout, 'DPOS') === undefined) notes.push('platform 未能探到（uname -s 无输出），记为 unknown')
  const arch: Arch = parseArch(tagField(stdout, 'DPARCH') ?? '')
  if (tagField(stdout, 'DPARCH') === undefined) notes.push('arch 未能探到（uname -m 无输出），记为 other')

  const idLine = tagField(stdout, 'DPID')
  const user = idLine?.split('\t')[0]
  if (user === undefined) notes.push('当前用户未能探到（id -un 无输出）')

  const toolsOut = parseToolPaths(stdout)
  for (const name of toolNames) {
    const value = toolsOut[name]
    if (value === undefined) notes.push(`工具 ${name} 未返回结果，记为不存在`)
    tools[name] = value ?? null
  }

  const canWrite: Record<string, boolean> = {}
  for (const raw of tagFields(stdout, 'DPW')) {
    const [p, v] = raw.split('\t')
    if (p === undefined) continue
    canWrite[p] = v === '1'
  }
  for (const p of writePaths) {
    if (canWrite[p] === undefined) {
      canWrite[p] = false
      notes.push(`${p} 的可写性未能探到（没有结果行），保守记为不可写`)
    }
  }

  const canSymlink = tagField(stdout, 'DPLINK') === '1'
  if (tagField(stdout, 'DPLINK') === undefined) {
    notes.push('canSymlink 未能探到，保守记为 false（调用方会退化成 copy）')
  }

  const init = detectInitFromProbe(tagField(stdout, 'DPPID1') ?? '', tools)
  const homedir = tagField(stdout, 'DPHOME') ?? '/'
  if (tagField(stdout, 'DPHOME') === undefined) notes.push('$HOME 为空，homedir 记为 /')
  const tmpRaw = tagField(stdout, 'DPTMP')
  const tmpdir = tmpRaw === undefined || tmpRaw === '' ? '/tmp' : tmpRaw
  if (tmpRaw === undefined || tmpRaw === '') notes.push('$TMPDIR/$TMP/$TEMP 都为空，tmpdir 记为 /tmp')

  // 互相独立的四项探测并行发出；每项把自己的 notes 手稿带回来，最后**按串行期的固定
  // 次序**并入总表 —— 并行只消等待，notes 是可观察输出，最早说完哪项取决于谁先返回，
  // 不锚定次序的话同一次失败两次跑出两种报告
  const [canChown, systemdScope, privilegedPort, sudoAllowlist] = await Promise.all([
    probeCanChown(driver, timeoutMs),
    probeSystemdScope(driver, tools, timeoutMs),
    probePrivilegedPort(driver, tools, timeoutMs),
    probeSudoAllowlist(driver, user, timeoutMs),
  ])
  notes.push(
    ...canChown.notes,
    ...systemdScope.notes,
    ...privilegedPort.notes,
    ...sudoAllowlist.notes,
  )

  const capabilities: Capabilities = {
    canWrite,
    canChown: canChown.value,
    canSymlink,
    systemdScope: systemdScope.value,
    lingerEnabled: parseLinger(tagField(stdout, 'DPLINGER') ?? ''),
    canBindPrivilegedPort: privilegedPort.value,
    sudoAllowlist: sudoAllowlist.value,
  }

  const facts: Facts = {
    host: options.host,
    platform,
    arch,
    init,
    homedir,
    tmpdir,
    // 远端环境变量我们不整体导出：凭据可能就在里面。需要哪几个由调用方显式问
    env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' },
    capabilities,
    tools,
  }
  return { facts, probeNotes: notes }
}

/**
 * 远端版「这条路径建得出来吗」。
 *
 * 与 `@dp/cli` 里 `probeCreatable` 的本地语义严格对齐：**路径已存在就测它自己，不存在就往上找第一个存在的祖先测它**。
 * 不做这层回退的话，`/srv/<name>` 这种发布根在第一次部署时必然不存在，而在一个不存在的目录里建文件一定失败 ——
 * 于是 `canWrite` 里整张发布根候选表全是 false，plan 报「没有可写的发布目录」，而真机上它明明建得出来。
 *
 * 远端没有 `fs.existsSync`，所以「往上找」这一段只能在 shell 里做。
 *
 * @param driver 已建立的驱动。**必须**是实际执行用的那一条：探测用 A 凭据、写入用 B 凭据，探出来的可写性说明不了任何事
 * @param paths 要判定的**完整路径**（发布根候选或显式 `release.root`）
 * @param known 已实测过的结论（`facts.capabilities.canWrite`）。重复建文件去测同一个目录纯属浪费，每次都是真实 IO
 * @param options 超时，以及**写的时候用的身份**。`become` 给了就按提权后的身份探 ——
 * 配了免密 sudo 却只按登录用户去探，`/etc/nginx/conf.d` 这种目录会被判成不可写，
 * 而真写的时候 dp 明明是提权的：探测的身份与写入的身份必须是同一个
 * @returns 以入参路径为键的判定；`notes` 记的是「没能实测、保守记为不可写」的那些 —— 结论与依据必须一起交出去
 */
export async function probeCreatableRemote(
  driver: SshDriver,
  paths: readonly string[],
  known: Readonly<Record<string, boolean>> = {},
  options: { readonly timeoutMs?: number; readonly become?: BecomeConfig } = {},
): Promise<{ canWrite: Record<string, boolean>; notes: readonly string[] }> {
  const notes: string[] = []
  const out: Record<string, boolean> = {}
  const pending: string[] = []

  for (const p of paths) {
    const v = known[p]
    if (v === undefined) {
      if (!pending.includes(p)) pending.push(p)
      continue
    }
    out[p] = v === true
  }
  if (pending.length === 0) return { canWrite: out, notes }

  const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`
  const script = [
    // 往上找第一个存在的目录。`dirname` 走到根就不再变（`dirname /` === `/`），那时停 —— 不判会死循环
    'nearest() { d=$1; while [ ! -d "$d" ]; do n=$(dirname "$d"); [ "$n" = "$d" ] && break; d=$n; done; printf "%s" "$d"; }',
    // 真的建一个文件再删掉。只读挂载 / SELinux / ACL 都可能让 access(W_OK) 通过而实际写失败
    'probeW() { p=$1; f="$p/.dp-w-$$"; if (set -C; : > "$f") 2>/dev/null; then rm -f "$f"; return 0; else return 1; fi; }',
    ...pending.map(
      (p) =>
        `if probeW "$(nearest ${q(p)})"; then printf 'DPW\\t%s\\t1\\n' ${q(p)}; else printf 'DPW\\t%s\\t0\\n' ${q(p)}; fi`,
    ),
  ].join('\n')

  // 提权包住的是**整条 sh**：只把 `sh` 换成 `sudo sh` 的话，重定向与 `set -C` 仍在
  // 登录用户那一侧执行，探到的还是没提权的结果
  const argv =
    options.become === undefined || options.become.type === 'none'
      ? ['sh', '-c', script]
      : wrapCommand(['sh', '-c', script], options.become)

  try {
    const res = await driver.exec({ argv, timeoutMs: resolveTimeoutMs(options.timeoutMs) })
    for (const raw of tagFields(res.stdout, 'DPW')) {
      const [p, v] = raw.split('\t')
      if (p !== undefined) out[p] = v === '1'
    }
  } catch (err) {
    notes.push(`发布根可写性补测失败：${(err as Error).message}。这些路径保守记为不可写`)
  }

  for (const p of pending) {
    if (out[p] === undefined) {
      out[p] = false
      notes.push(`${p} 没能实测出可写性（补测无结果行），保守记为不可写`)
    }
  }
  return { canWrite: out, notes }
}

/** 复合探测脚本：一次往返拿完（标签化输出，见 tagField） */
function compositeProbe(toolNames: readonly string[], writePaths: readonly string[]): string {
  const q = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`
  const lines = [
    `printf 'DPOS\\t%s\\n' "$(uname -s 2>/dev/null)"`,
    `printf 'DPARCH\\t%s\\n' "$(uname -m 2>/dev/null)"`,
    `printf 'DPID\\t%s\\t%s\\n' "$(id -un 2>/dev/null)" "$(id -u 2>/dev/null)"`,
    `printf 'DPPID1\\t%s\\n' "$(ps -p 1 -o comm= 2>/dev/null | tr -d ' \\n')"`,
    `printf 'DPHOME\\t%s\\n' "\${HOME:-}"`,
    `printf 'DPTMP\\t%s\\n' "\${TMPDIR:-\${TMP:-\${TEMP:-}}}"`,
    ...toolNames.map((n) => `printf 'DPT\\t${n}\\t%s\\n' "$(command -v ${q(n)} 2>/dev/null || printf -- '-')"`),
    // 真的建一个文件再删掉。只读挂载 / SELinux / ACL 都可能让 access(W_OK) 通过而实际写失败
    'probeW() { p=$1; f="$p/.dp-w-$$"; if (set -C; : > "$f") 2>/dev/null; then rm -f "$f"; printf "DPW\\t%s\\t1\\n" "$p"; else printf "DPW\\t%s\\t0\\n" "$p"; fi; }',
    ...writePaths.map((p) => `probeW ${q(p)}`),
    'l="$HOME/.dp-l-$$"; if ln -s "$HOME" "$l" 2>/dev/null; then rm -f "$l"; printf "DPLINK\\t1\\n"; else printf "DPLINK\\t0\\n"; fi',
    'printf "DPLINGER\\t%s\\n" "$(loginctl show-user "$(id -un 2>/dev/null)" -p Linger 2>/dev/null | sed -n "s/^Linger=//p")"',
  ]
  return lines.join('\n')
}

/**
 * 各探测单元把 notes 跟结论**一起**交还：并行下谁先返回谁先写共享表，notes 的次序
 * 就交给运气了 —— 顺序由调用方按固定次序并回总表来保证。
 */
interface ProbeOutcome<T> {
  readonly value: T
  readonly notes: readonly string[]
}

function detectInitFromProbe(pid1: string, tools: Readonly<Record<string, string | null>>): InitSystem {
  return parseInit(pid1, {
    systemctl: tools.systemctl ?? null,
    rcService: tools.rcService ?? null,
    service: tools.service ?? null,
  })
}

/**
 * canChown：**真的 chown 一次**到别的身份。
 */
async function probeCanChown(
  driver: SshDriver,
  timeoutMs: number,
): Promise<ProbeOutcome<readonly string[]>> {
  const out: string[] = []
  const notes: string[] = []
  for (const target of ['daemon', 'nobody', 'root']) {
    const script = [
      'f="${TMPDIR:-/tmp}/.dp-c-$$"',
      'touch "$f" 2>/dev/null || exit 3',
      `if chown ${target} "$f" 2>/dev/null; then printf 'DPC\\n'; fi`,
      'rm -f "$f" 2>/dev/null',
    ].join('\n')
    try {
      const res = await driver.exec({ argv: ['sh', '-c', script], timeoutMs })
      // stdout 有内容 = 这次 chown 真成了。**成功才有记录，失败不算错**
      if (res.code === 0 && res.stdout.includes('DPC')) out.push(target)
    } catch {
      notes.push(`canChown(${target}) 探测抛错，记为不可用`)
    }
  }
  if (out.length === 0) notes.push('canChown 为空：当前身份无法把文件 chown 给其他用户（无 root 时的正常结果）')
  return { value: out, notes }
}

async function probeSystemdScope(
  driver: SshDriver,
  tools: Readonly<Record<string, string | null>>,
  timeoutMs: number,
): Promise<ProbeOutcome<Capabilities['systemdScope']>> {
  if (tools.systemctl == null) {
    return { value: 'none', notes: ['没有 systemctl，systemdScope 记为 none'] }
  }
  // --user 成功 → user；系统级 status 成功 → system。**都真跑一次**，不看 uid
  for (const [argv, scope] of [
    [['--user', 'status'], 'user'],
    [['status'], 'system'],
  ] as const) {
    try {
      const res = await driver.exec({ argv: ['systemctl', ...argv], timeoutMs })
      if (res.code === 0 || !/Failed to connect|not been booted/i.test(res.stderr)) {
        return { value: scope, notes: [] }
      }
    } catch {
      /* 视为不可用，试下一个 */
    }
  }
  return { value: 'none', notes: ['systemctl 的 --user 与 system 两种查询都失败，systemdScope 记为 none'] }
}

/**
 * canBindPrivilegedPort：**真 bind 一次** 80/443。
 */
async function probePrivilegedPort(
  driver: SshDriver,
  tools: Readonly<Record<string, string | null>>,
  timeoutMs: number,
): Promise<ProbeOutcome<boolean>> {
  const notes: string[] = []
  const interp: string[] = []
  if (tools.python3 != null) interp.push('python3')
  if (tools.node != null) interp.push('node')
  if (interp.length === 0) {
    notes.push('canBindPrivilegedPort 记为 false：远端既没有 python3 也没有 node，无法做实测 bind')
    return { value: false, notes }
  }

  const lines = ['for port in 80 443; do', '  ok=0']
  for (const i of interp) {
    const probe =
      i === 'python3'
        ? `if python3 -c 'import socket,sys;s=socket.socket();s.bind(("127.0.0.1",int(sys.argv[1])));s.close()' "$port" 2>/dev/null; then ok=1; fi`
        : `if node -e 'require("net").createServer().listen(+process.argv[1],"127.0.0.1",function(){this.close()})' "$port" 2>/dev/null; then ok=1; fi`
    lines.push(`  ${probe}`)
  }
  lines.push('  printf "DPBIND\\t%s\\t%s\\n" "$port" "$ok"', 'done')

  try {
    const res = await driver.exec({ argv: ['sh', '-c', lines.join('\n')], timeoutMs })
    for (const raw of tagFields(res.stdout, 'DPBIND')) {
      const [, flag] = raw.split('\t')
      if (flag === '1') return { value: true, notes }
    }
    if (res.code !== 0) notes.push(`bind 探测退出码 ${res.code}，记为不可绑特权端口`)
  } catch (err) {
    notes.push(`canBindPrivilegedPort 探测抛错：${(err as Error).message}`)
  }
  return { value: false, notes }
}

/**
 * sudoAllowlist：`sudo -n -l`。
 */
async function probeSudoAllowlist(
  driver: SshDriver,
  user: string | undefined,
  timeoutMs: number,
): Promise<ProbeOutcome<readonly string[]>> {
  const notes: string[] = []
  try {
    const res = await driver.exec({ argv: ['sudo', '-n', '-l'], timeoutMs })
    const list = parseSudoList(res.stdout, res.stderr)
    if (res.code !== 0 && list.length === 0) {
      notes.push(`sudo -n -l 退出码 ${res.code} 且无可用条目：当前身份没有免密 sudo 白名单`)
    }
    return { value: list, notes }
  } catch (err) {
    notes.push(`sudoAllowlist 探测失败：${(err as Error).message}，记为 []`)
    return { value: [], notes }
  }
}

// 提权实证

/**
 * 提权的实证结论。`available: false` **不是一个错误**，是一个可以被 plan 用来改方案的正常结论 —— 部署到用户可写目录本来就不需要提权。
 */
export interface CanElevateResult {
  /** 能不能真的提权。由远端跑一次 `id -un` 得出，不由配置声明 */
  readonly available: boolean
  /** 不可用时是失败原因（远端原话首行，脱敏后）；可用时是实测依据 */
  readonly reason: string
  /** 真的提升后拿到的身份 —— 不由配置声明，由 `id -un` 的输出得到 */
  readonly targetUser?: string
}

/**
 * 提权能不能成 —— **实证**（`sudo -n true`），不推断。
 *
 * @param driver 已建立的驱动
 * @param become 配置里的提权方式。`none` 不做任何提权，只跑一次 `id -un`
 * 确认"普通用户身份确实可用" —— 连这都失败的话，后面每一次 exec 都会失败
 * @param options 只留超时。**没有**"允许交互"这类开关：需要密码的探测
 * 在这个位置永远是错的
 * @returns 结论。`reason` 在可用与不可用时都非空：可用时它记录的是"实证通过 + 拿到了什么身份"，
 * 这句话会进报告，读者需要能复核而不是只能看到一个 true
 */
export async function canElevate(
  driver: SshDriver,
  become: BecomeConfig,
  options: { timeoutMs?: number } = {},
): Promise<CanElevateResult> {
  const timeoutMs = resolveTimeoutMs(options.timeoutMs)
  if (become.type === 'none') {
    try {
      const res = await driver.exec({ argv: ['id', '-un'], timeoutMs })
      return { available: res.code === 0, reason: 'become.type=none，不做提权', targetUser: res.stdout.trim() }
    } catch (err) {
      return { available: false, reason: `become.type=none，但连 id -un 都失败：${(err as Error).message}` }
    }
  }

  // canElevate 内部**必须**用 nonInteractive：探测本身绝不能等密码
  const probeBecome: BecomeConfig =
    become.type === 'sudo' ? { type: 'sudo', user: become.user, nonInteractive: true } : become

  let argv: readonly string[]
  try {
    argv = wrapCommand(['id', '-un'], probeBecome)
  } catch (err) {
    return { available: false, reason: (err as Error).message }
  }

  try {
    const res = await driver.exec({ argv, timeoutMs })
    if (res.code === 0) {
      const who = res.stdout.trim()
      const first = res.stderr.split(/\r?\n/)[0]?.trim() ?? ''
      if (/must be suid/i.test(first) || /must be a suid/i.test(res.stderr)) {
        return { available: false, reason: `${first} —— 这台机器的 su 缺 suid 位（实测同款失败）` }
      }
      return { available: true, reason: `实证通过：${who}`, targetUser: who }
    }
    const first = res.stderr.split(/\r?\n/)[0]?.trim() ?? `退出码 ${res.code}`
    return { available: false, reason: first }
  } catch (err) {
    return { available: false, reason: (err as Error).message }
  }
}

/** canElevate 失败时给调用方的标准 hint */
export const ELEVATION_HINT = ELEVATE_FAILED_HINT

export { DpError }
