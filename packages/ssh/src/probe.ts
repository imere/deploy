/**
 * 远端事实探测 —— 与 packages/local/src/probe.ts 同一套哲学：
 * **能力一律实证，不推断。**
 *
 * `command -v su` 返回了路径，但 `su` 本身可能是坏的（实测
 * busybox su 缺 suid 位，`su -c 'id' root` 直接失败）。所以：
 *  - 工具路径 = `command -v`（只能说明"存在"）
 *  - 能力     = 真做一次（建临时文件再删、真 bind 一次端口、真 `sudo -n`）
 *
 * 每一条探测命令都带超时；单条失败**不影响整体** —— 那一条记安全默认值，
 * 并在 `probeNotes` 里说明「哪项没探到、为什么」。静默降级比报错更危险。
 */
import type { Arch, Capabilities, Facts, InitSystem, Platform } from '@dp/ports'
import { DpError, POSIX_WRITE_CANDIDATES } from '@dp/ports'
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

const TOOLS_TO_PROBE = [
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'tar',
  'gzip',
  'base64',
  'sudo',
  'su',
  'doas',
  'systemctl',
  'loginctl',
  'nginx',
  'docker',
  'git',
  'python3',
  'node',
  'java',
  'openssl',
] as const

/**
 * 与 `@dp/local` 共用同一份候选（`@dp/ports` 的那张表），只多一个 `/tmp`：
 * 本机探测有 `os.tmpdir()` 可用，远端没有，只能把它列进候选里实测。
 * 这张表**不许**在这里另写一份 —— 两份 facts 的语义必须可比。
 */
const DEFAULT_WRITE_PATHS = [...POSIX_WRITE_CANDIDATES, '/tmp'] as const

export interface ProbeOptions {
  readonly tools?: readonly string[]
  readonly writeProbePaths?: readonly string[]
  readonly timeoutMs?: number
  readonly host: string
  /** sudo 探测的目标用户；不给则用远端自己的 `id -un` */
  readonly sudoAsUser?: string
}

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
      // （多跳环境里往返就是钱）
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

  const capabilities: Capabilities = {
    canWrite,
    canChown: await probeCanChown(driver, notes, timeoutMs),
    canSymlink,
    systemdScope: await probeSystemdScope(driver, tools, notes, timeoutMs),
    lingerEnabled: parseLinger(tagField(stdout, 'DPLINGER') ?? ''),
    canBindPrivilegedPort: await probePrivilegedPort(driver, tools, notes, timeoutMs),
    sudoAllowlist: await probeSudoAllowlist(driver, user, notes, timeoutMs),
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

function detectInitFromProbe(pid1: string, tools: Readonly<Record<string, string | null>>): InitSystem {
  return parseInit(pid1, {
    systemctl: tools.systemctl ?? null,
    rcService: tools.rcService ?? null,
    service: tools.service ?? null,
  })
}

/**
 * canChown：**真的 chown 一次**到别的身份。
 * 无 root 时通常返回空数组 —— 那就是事实，不是缺陷。
 */
async function probeCanChown(
  driver: SshDriver,
  notes: string[],
  timeoutMs: number,
): Promise<readonly string[]> {
  const out: string[] = []
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
  return out
}

async function probeSystemdScope(
  driver: SshDriver,
  tools: Readonly<Record<string, string | null>>,
  notes: string[],
  timeoutMs: number,
): Promise<Capabilities['systemdScope']> {
  if (tools.systemctl == null) {
    notes.push('没有 systemctl，systemdScope 记为 none')
    return 'none'
  }
  // --user 成功 → user；系统级 status 成功 → system。**都真跑一次**，不看 uid
  for (const [argv, scope] of [
    [['--user', 'status'], 'user'],
    [['status'], 'system'],
  ] as const) {
    try {
      const res = await driver.exec({ argv: ['systemctl', ...argv], timeoutMs })
      if (res.code === 0 || !/Failed to connect|not been booted/i.test(res.stderr)) return scope
    } catch {
      /* 视为不可用，试下一个 */
    }
  }
  notes.push('systemctl 的 --user 与 system 两种查询都失败，systemdScope 记为 none')
  return 'none'
}

/**
 * canBindPrivilegedPort：**真 bind 一次** 80/443。
 * 「uid 是不是 0」这种推断在容器、macOS、网络命名空间里都会失真
 * （ 明确禁止）。
 */
async function probePrivilegedPort(
  driver: SshDriver,
  tools: Readonly<Record<string, string | null>>,
  notes: string[],
  timeoutMs: number,
): Promise<boolean> {
  const interp: string[] = []
  if (tools.python3 != null) interp.push('python3')
  if (tools.node != null) interp.push('node')
  if (interp.length === 0) {
    notes.push('canBindPrivilegedPort 记为 false：远端既没有 python3 也没有 node，无法做实测 bind')
    return false
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
      if (flag === '1') return true
    }
    if (res.code !== 0) notes.push(`bind 探测退出码 ${res.code}，记为不可绑特权端口`)
  } catch (err) {
    notes.push(`canBindPrivilegedPort 探测抛错：${(err as Error).message}`)
  }
  return false
}

/**
 * sudoAllowlist：`sudo -n -l`。
 *
 * **绝不用 `sudo -S` 探测** —— 它会从 stdin 读密码，没有密码时挂在那里，
 * 而铁律 0 禁止任何等待。`-n` 是唯一安全的探测形式（实测：
 * `sudo -n id` 退出 1 并报 "a password is required"，这正是我们要的结论）。
 */
async function probeSudoAllowlist(
  driver: SshDriver,
  user: string | undefined,
  notes: string[],
  timeoutMs: number,
): Promise<readonly string[]> {
  try {
    const res = await driver.exec({ argv: ['sudo', '-n', '-l'], timeoutMs })
    const list = parseSudoList(res.stdout, res.stderr)
    if (res.code !== 0 && list.length === 0) {
      notes.push(`sudo -n -l 退出码 ${res.code} 且无可用条目：当前身份没有免密 sudo 白名单`)
    }
    return list
  } catch (err) {
    notes.push(`sudoAllowlist 探测失败：${(err as Error).message}，记为 []`)
    return []
  }
}

// ------------------------------------------------------------
// 提权实证
// ------------------------------------------------------------

export interface CanElevateResult {
  readonly available: boolean
  /** 不可用时是失败原因（远端原话首行，脱敏后）；可用时是实测依据 */
  readonly reason: string
  /** 真的提升后拿到的身份 —— 不由配置声明，由 `id -un` 的输出得到 */
  readonly targetUser?: string
}

/**
 * 提权能不能成 —— **实证**（`sudo -n true`），不推断。
 *
 * 这正是的教训：`command -v su` 有，但它缺 suid 位，
 * 实际调用会失败。所以每种 become 都要真跑一次。
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
