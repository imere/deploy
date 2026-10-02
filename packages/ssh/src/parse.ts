/**
 * 远端输出解析 —— **纯函数，零 IO**。
 *
 * 铁律：远端返回怪东西**必须报错或退到安全默认值，绝不猜**。
 * 所以这里每个解析器的签名都是「吃字符串 → 吐已校验的结构」，
 * 畸形输入一律返回保守结果 + 原因，而不是抛异常或静默取 `[0]`。
 */
import { DpError, type Arch, type DpErrorCode, type InitSystem, type Platform } from '@dp/ports'

// ------------------------------------------------------------
// 截断
// ------------------------------------------------------------

export const TRUNCATE_MARK = '…(truncated '

/**
 * 保留头尾的截断。一条 `cat /dev/zero` 或 `tar -tvf` 百万行目录能打爆内存，
 * 而我们只要头尾（错误信息里有用的是头部的命令回显与尾部的报错）。
 */
export function truncateOutput(text: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= maxBytes) return text

  const keep = Math.floor(maxBytes / 2)
  const head = takeHead(text, keep)
  const tail = takeTail(text, keep)
  return `${head}${TRUNCATE_MARK}${bytes - head.length - tail.length} bytes)${tail}`
}

function takeHead(text: string, maxBytes: number): string {
  let out = text
  while (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(0, Math.floor(out.length / 2))
  }
  return `${out}\n`
}

function takeTail(text: string, maxBytes: number): string {
  let out = text
  while (Buffer.byteLength(out, 'utf8') > maxBytes) {
    out = out.slice(Math.ceil(out.length / 2))
  }
  return `\n${out}`
}

// ------------------------------------------------------------
// ssh -G
// ------------------------------------------------------------

/**
 * 解析 `ssh -G <host>` —— ssh 打印它**实际会用的**完整配置。
 * 比读 `~/.ssh/config` 靠谱：匹配、Include、命令行覆盖全都在里面生效了。
 *
 * 重复键（`sendenv`、`match`、`canonicalizehostname`）保留全部值。
 */
export function parseSshG(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const sep = line.search(/\s/)
    const key = sep === -1 ? line : line.slice(0, sep)
    const value = sep === -1 ? '' : line.slice(sep + 1).trim()
    if (key === '') continue
    const existing = out[key]
    if (existing === undefined) out[key] = [value]
    else existing.push(value)
  }
  return out
}

/** `ssh -G` 里第一条匹配项；没有则 undefined */
export function sshGValue(g: Record<string, string[]>, key: string): string | undefined {
  return g[key]?.[0]
}

// ------------------------------------------------------------
// 指纹
// ------------------------------------------------------------

export interface HostKeyFingerprint {
  /** 统一 SHA256 形式：`SHA256:base64` */
  readonly fingerprint: string
  /** 密钥算法，如 `ssh-ed25519` */
  readonly keyType: string
  readonly bits: number
  /** 是否已经是 SHA256（MD5 形式会被标 false，因为 SHA-1 已经不可信） */
  readonly sha256: boolean
}

/**
 * 解析 `ssh-keygen -l -E sha256 -f <known_hosts>`：
 *   `256 SHA256:7bKx0... comment ED25519 (ED25519)`
 * 老版本可能给 MD5 形式 `2048 aa:bb:cc...`。MD5 只在提示里标注为 sha256:false，
 * **不当作可信匹配依据**。
 */
export function parseFingerprint(text: string): HostKeyFingerprint | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (line === undefined) return undefined

  const sha = /^(\d+)\s+(SHA256:[A-Za-z0-9+/]+)\s/.exec(line)
  if (sha !== null) {
    return { bits: Number(sha[1]), fingerprint: sha[2]!, keyType: keyTypeOf(line), sha256: true }
  }
  const md5 = /^(\d+)\s+((?:[0-9a-f]{2}:){15}[0-9a-f]{2})\s/i.exec(line)
  if (md5 !== null) {
    return { bits: Number(md5[1]), fingerprint: md5[2]!, keyType: keyTypeOf(line), sha256: false }
  }
  return undefined
}

/** 从行尾的 `(ED25519)` / `(RSA)` 里抠算法名；抠不到就报 unknown 而不是猜 */
function keyTypeOf(line: string): string {
  const tail = /\(([A-Z0-9][A-Za-z0-9-]*)\)\s*$/.exec(line)
  return tail?.[1]?.toLowerCase() ?? 'unknown'
}

// ------------------------------------------------------------
// uname / init
// ------------------------------------------------------------

export function parsePlatform(unameS: string): Platform {
  const s = unameS.trim().toLowerCase()
  if (s === 'linux') return 'linux'
  if (s === 'darwin' || s === 'freebsd' || s === 'openbsd' || s === 'netbsd') return s as Platform
  return 'unknown'
}

export function parseArch(unameM: string): Arch {
  const s = unameM.trim().toLowerCase()
  if (s === 'x86_64' || s === 'amd64') return 'x64'
  if (s === 'aarch64' || s === 'arm64') return 'arm64'
  if (s === 'i386' || s === 'i686' || s === 'x86') return 'x86'
  if (s === 'armv7l' || s === 'armv6l' || s === 'arm') return 'arm'
  return 'other'
}

/**
 * 判定 init 系统。
 *
 * 注意 `init` 的判定**不是**看平台：容器里 PID 1 可能就是 busybox init，
 * 而 macOS 的 launchd 根本不叫那个名字。所以判据是 PID 1 的真名 + 实测到的工具。
 */
export function parseInit(
  pid1: string,
  tools: { systemctl?: string | null; rcService?: string | null; service?: string | null },
): InitSystem {
  const p = pid1.trim().toLowerCase()
  if (p.includes('systemd')) return 'systemd'
  if (p.includes('openrc') || p.includes('init.openrc')) return 'openrc'
  if (p.includes('runit') || p.includes('s6') || p.includes('supervise')) return 'sysvinit'
  if (p.includes('launchd')) return 'launchd'
  // 名字认不出（空、容器里被截断的 comm、busybox 的怪名字）→ 退到工具弱证据。
  // 这里**不能**要求名字里含 "init"：那会让 "weird" 这类真实存在的 PID 1
  // 永远拿不到工具回退，明明 systemctl 就在那儿。
  if (tools.systemctl != null) return 'systemd'
  if (tools.rcService != null) return 'openrc'
  if (tools.service != null) return 'sysvinit'
  return 'none'
}

// ------------------------------------------------------------
// loginctl
// ------------------------------------------------------------

/** `Linger=yes` / `Linger=no`。缺字段、拼错、权限不足 → 一律 false（保守） */
export function parseLinger(stdout: string): boolean {
  return /^Linger=yes\s*$/im.test(stdout)
}

// ------------------------------------------------------------
// sudo -n -l
// ------------------------------------------------------------

/**
 * 解析 `sudo -n -l`。
 *
 * 目标是「**能 sudo 哪几条命令**」而不是「能不能 sudo」（privilege.md §1）。
 * 典型输出：
 *   Matching Defaults ...
 *   User deploy may run the following commands on host:
 *       (ALL) NOPASSWD: ALL
 *       (root) NOPASSWD: /usr/bin/systemctl, /usr/bin/tar
 * 无权时是 `Sorry, user deploy may not run sudo on host.` —— 返回 []。
 *
 * **保守策略**：只认 `NOPASSWD:` 后面明确列出的命令；带密码的条目（`ALL` 但
 * 没有 NOPASSWD）不计入 —— 它们会挂住，与铁律 0 冲突。
 */
export function parseSudoList(stdout: string, stderr = ''): string[] {
  if (/may not run sudo|is not in the sudoers file|a password is required/i.test(stderr + stdout)) {
    // 上面的正则只用来判"无权限"。注意 `a password is required` 只在 stderr 里
    // 出现时才算（stdout 里同名的 sudoers 描述是合法的），所以分开判：
    if (/may not run sudo|is not in the sudoers file/i.test(stderr + stdout)) return []
  }

  const out = new Set<string>()
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    const m = /\(.*?\)\s+NOPASSWD:\s*(.+)$/.exec(line)
    if (m === null) continue
    const list = m[1]!.trim()
    if (list === 'ALL') {
      out.add('ALL')
      continue
    }
    for (const raw2 of list.split(/,\s*/)) {
      // sudoers 允许在命令前挂 tag（`SETENV: /bin/ls`、`NOPASSWD: /bin/ls`）。
      // tag **不是命令** —— 留着它会让 `sudoAllowlist` 报出根本执行不了的东西。
      const cmd = raw2.trim().replace(/^[A-Z][A-Z0-9_]*:(?=[ \t])/, '').trim()
      // `ALL` 混在列表里时按整体处理；`VAR=value` 是 setenv 条目，不是可执行命令
      if (cmd === '' || cmd === 'ALL' || cmd.includes('=')) continue
      out.add(cmd)
    }
  }
  return [...out]
}

// ------------------------------------------------------------
// 工具路径
// ------------------------------------------------------------

/**
 * 解析 `command -v` 批量探测的输出。
 * 远端脚本按 `DPT\t<name>\t<path|->` 每行一条打印，这里还原成 Facts.tools 的形状。
 * 缺行的工具一律记 null —— **"没探到"就是没有**，不能因为没输出就当存在。
 */
export function parseToolPaths(stdout: string): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith('DPT\t')) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const name = parts[1]!
    const path = parts[2]!
    out[name] = path === '' || path === '-' ? null : path
  }
  return out
}

// ------------------------------------------------------------
// stat
// ------------------------------------------------------------

export interface RemoteStat {
  readonly kind: 'file' | 'dir' | 'link' | 'other'
  readonly size: number
  /** 秒级 mtime（远端 stat 的原生粒度） */
  readonly mtimeSec: number
}

export function parseStatLine(stdout: string): RemoteStat | undefined {
  const line = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.startsWith('DPSTAT\t'))
  if (line === undefined) return undefined
  const parts = line.split('\t')
  if (parts.length < 4) return undefined

  const rawKind = parts[1]!
  const kind: RemoteStat['kind'] =
    rawKind === 'file' || rawKind === 'dir' || rawKind === 'link' ? rawKind : 'other'
  const size = Number.parseInt(parts[2]!, 10)
  const mtimeSec = Number.parseInt(parts[3]!, 10)
  return {
    kind,
    size: Number.isFinite(size) ? size : 0,
    mtimeSec: Number.isFinite(mtimeSec) ? mtimeSec : 0,
  }
}

// ------------------------------------------------------------
// ssh 失败归类
// ------------------------------------------------------------

export interface SshFailure {
  readonly code: DpErrorCode
  readonly reason: string
  /** 主机密钥类错误才有的指纹信息 */
  readonly expected?: string
  readonly actual?: string
  readonly keyType?: string
}

/**
 * 把 OpenSSH 的 stderr 归类成结构化失败。
 *
 * 顺序敏感：先判主机密钥（MISMATCH 必须在 UNKNOWN 前面 —— "changed" 那种
 * 报错里也含 "unknown"，反过来会全归成 UNKNOWN），再判认证，最后才是连接。
 * 判不出来的走 CONNECT_FAILED 并带上 stderr 首行 —— **宁可笼统也不要误判**，
 * 误判成 AUTH_FAILED 会把用户引到完全错误的方向。
 */
export function classifySshError(stderr: string, exitCode: number): SshFailure {
  const s = stderr

  // 指纹不匹配：OpenSSH 会把实际拿到的整行公钥印出来
  const mismatch = /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(s)
  if (mismatch) {
    const actual = /^ssh-(?:ed25519|rsa|ecdsa-\S+)\s+(AAAA\S+)/m.exec(s)
    return {
      code: 'DP.SSH.HOST_KEY_MISMATCH',
      reason: '远端主机密钥与 known_hosts 里记录的不一致 —— 这意味着主机可能被重装/换密钥，也可能是一次中间人攻击',
      actual: actual?.[2] === undefined ? undefined : `SHA256:${actual[2]}`,
      keyType: actual?.[1],
    }
  }

  if (/REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s) === false && /Host key verification failed/i.test(s)) {
    return { code: 'DP.SSH.HOST_KEY_MISMATCH', reason: '主机密钥校验失败（known_hosts 无此主机或指纹不符）' }
  }

  const unknown =
    /No ED25519 host key is known for|Host key verification failed|The authenticity of host .* can't be established/i.test(
      s,
    )
  if (unknown) {
    return {
      code: 'DP.SSH.HOST_KEY_UNKNOWN',
      reason: 'known_hosts 里没有这台主机的指纹，且当前策略是 strict',
    }
  }

  if (
    /Permission denied|Too many authentication failures|Authentication refused|No supported authentication|publickey,password|Host key verification failed\.$|invalid password|Login incorrect/i.test(
      s,
    )
  ) {
    return { code: 'DP.SSH.AUTH_FAILED', reason: firstLine(s) ?? '认证被拒绝' }
  }

  if (/ssh: (?:Could not resolve|Name or service not known|Nexthop|connect to host .* Connection refused|timed out)/i.test(s)) {
    return { code: 'DP.SSH.CONNECT_FAILED', reason: firstLine(s) ?? `ssh 退出码 ${exitCode}` }
  }

  return { code: 'DP.SSH.CONNECT_FAILED', reason: firstLine(s) ?? `ssh 退出码 ${exitCode}` }
}

/** 主机密钥失败的统一提示 —— mismatch 场景下必须让用户知道「我们不会自动改」 */
export function hostKeyHint(failure: SshFailure): string {
  const expect = failure.expected === undefined ? '' : `期望 ${failure.expected}，实际 ${failure.actual ?? '未知'}`
  switch (failure.code) {
    case 'DP.SSH.HOST_KEY_MISMATCH':
      return `主机密钥不匹配（${expect}）。**请手动更新 known_hosts** —— 若你确认目标机是重装或换过密钥，用 \`ssh-keygen -R <host>\` 删掉旧记录后重新采集；我们不会自动改，那正好是中间人攻击最想要的效果。也可把该主机的指纹写进项目的 pinnedHostKeysPath`
    case 'DP.SSH.HOST_KEY_UNKNOWN':
      return `该主机的指纹不在 known_hosts 里。确认无误后可显式配置 knownHosts: accept-new（会自动写入）或 tofu（记到项目 pin 文件，不污染系统 known_hosts）；strict 是默认值，刻意保持这一步需要人来确认`
    default:
      return '检查网络、端口与该主机的 sshd 状态'
  }
}

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  return line?.slice(0, 300)
}

/** 把 runner 层的 IO 错误映射成 DpError（对齐 packages/local/src/runner.ts 的措辞） */
export function ioError(code: string, path: string, detail: string): DpError {
  switch (code) {
    case 'ENOENT':
      return new DpError('DP.PATH.NOT_WRITABLE', `路径不存在：${path}`)
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new DpError('DP.PATH.NOT_WRITABLE', `无权访问：${path}`, {
        hint: '检查权限 / 只读挂载 / SELinux 标签。我们绝不会替你 chown 系统目录也不改 ACL —— 授权必须由运维显式完成',
      })
    case 'ENOSPC':
      return new DpError('DP.PATH.NOT_WRITABLE', `磁盘已满：${path}`, {
        hint: '清理空间后重试；目标程序如果依赖写临时文件，即使空间腾出也要重启它',
      })
    default:
      return new DpError('DP.PATH.NOT_WRITABLE', `${path}：${detail}`)
  }
}
