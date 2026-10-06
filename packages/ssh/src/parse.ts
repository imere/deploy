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

/**
 * 截断标记。**导出是因为报告与测试都要断言它在场** ——
 * 被砍掉的输出若不留痕，一份缺了尾部报错的日志与完整的那份长得一样，
 * 而读日志的人无法知道后面曾经有过东西。
 *
 * 字节数由调用方插在标记中间（见 truncateOutput），不是这里的一部分。
 */
export const TRUNCATE_MARK = '…(truncated '

/**
 * 保留头尾的截断。一条 `cat /dev/zero` 或 `tar -tvf` 百万行目录能打爆内存，
 * 而我们只要头尾（错误信息里有用的是头部的命令回显与尾部的报错）。
 *
 * 按字节切而不是按字符切：多字节字符被劈开会变成替换字符，
 * 截出来的日志里凭空冒出 `�`，读者会以为远端真的输出了乱码。
 *
 * @param text 原始输出。可以远大于 maxBytes —— 截断发生在这里，不在采集端，
 *   因为调用方常常要在返回之后才知道总长度
 * @param maxBytes 字节预算，**不是**最终长度上限：标记本身与头尾之间的换行也占字节，
 *   所以结果可能略大于它。小于等于 0 时会一路折到空串，此时只余标记
 * @returns 未超预算时**原样返回**同一字符串引用（不复制）；超了才拼成 `头 + 标记 + 字节数 + 尾`
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
 *
 * @param text `ssh -G` 的 stdout。注释行与空行跳过；不含 `=` 的行视为值空串的键，
 *   不丢 —— 丢掉会让"这个键我们没查到"与"这个键的值就是空"变得无法区分
 * @returns 键 → **值数组**（不是单值）。第一条通常是命令行/配置里最靠前的那次出现，
 *   取值请走 {@link sshGValue} 而不是直接 `[0]`，否则哪天键的语义变了，
 *   "取第一条"这条约定就散落到了每个调用点
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

/**
 * `ssh -G` 里第一条匹配项；没有则 undefined
 *
 * 为什么取**第一条**而不是最后一条：`ssh -G` 按 ssh_config 的首次出现生效，
 * 后面几行是同名的其它匹配块。取末条会在用户写了多个 Host 别名时拿到不相干那条。
 *
 * @param g {@link parseSshG} 的结果
 * @param key 键名，大小写敏感（`ssh -G` 原样输出小写键）
 * @returns 首条值；键不存在或值数组为空时 `undefined` —— 调用方据此区分「没配」与「配成空」
 */
export function sshGValue(g: Record<string, string[]>, key: string): string | undefined {
  return g[key]?.[0]
}

// ------------------------------------------------------------
// 指纹
// ------------------------------------------------------------

/**
 * 一台主机在 known_hosts 里的指纹。**信任判定只认 `sha256: true` 的那种** ——
 * MD5 形式留着只是为了能在提示里告诉用户「你现在看到的是一份旧格式的记录」。
 */
export interface HostKeyFingerprint {
  /** 统一 SHA256 形式：`SHA256:base64` */
  readonly fingerprint: string
  /** 密钥算法，如 `ssh-ed25519` */
  readonly keyType: string
  /** 密钥位数。填进来是因为老 ssh-keygen 的输出里它排在最前面 */
  readonly bits: number
  /** 是否已经是 SHA256（MD5 形式会被标 false，因为 SHA-1 已经不可信） */
  readonly sha256: boolean
}

/**
 * 解析 `ssh-keygen -l -E sha256 -f <known_hosts>`：
 *   `256 SHA256:7bKx0... comment ED25519 (ED25519)`
 * 老版本可能给 MD5 形式 `2048 aa:bb:cc...`。MD5 只在提示里标注为 sha256:false，
 * **不当作可信匹配依据**。
 *
 * @param text ssh-keygen 的 stdout。只看**首个非空行** —— 它打印多条时（一个文件里多台机器），
 *   调用方传的路径应该只对应一条，多出来的行不是我们要比较的对象
 * @returns 解析结果；两种指纹格式都不匹配时返回 `undefined` 而不是造一个空指纹，
 *   因为一个看起来存在、实则不可信的指纹比"没查到"危险得多
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

/**
 * `uname -s` → Platform。**认不出就返回 unknown，不往 linux 上兜底** ——
 * 猜错平台的后果是整条路径规则（保留名、非法字符、大小写碰撞）按另一套语义跑，
 * 而这些判定不会报错，只会让部署在某个平台上把文件写错地方。
 *
 * @param unameS `uname -s` 的输出，允许带尾随换行，大小写不敏感
 * @returns 四个已知平台之一，或 `'unknown'`（**不是**平台推导出的默认值）
 */
export function parsePlatform(unameS: string): Platform {
  const s = unameS.trim().toLowerCase()
  if (s === 'linux') return 'linux'
  if (s === 'darwin' || s === 'freebsd' || s === 'openbsd' || s === 'netbsd') return s as Platform
  return 'unknown'
}

/**
 * `uname -m` → Arch。认不出返回 `'other'` 而不是 `'x64'` ——
 * `'other'` 在决策上被当成「行为不保证一致」，而猜成 x64 会让上层照常走 x64 的路径。
 *
 * @param unameM `uname -m` 的输出。同一架构有多个拼写（`x86_64`/`amd64`），
 *   它们指的是同一件事，所以这里允许别名而 platform 不允许
 * @returns 已知架构之一，或 `'other'`（显式的「不知道」）
 */
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
 *
 * 名字认不出时退到工具弱证据，**反过来不行**：只认名字会让 systemd 装在
 * 一个 PID 1 被改名/被容器截断的机器上被判成 `'none'`，于是 unit 文件
 * 写给一个不存在的 init。
 *
 * @param pid1 PID 1 的可执行名（`/proc/1/comm` 的内容）。允许带路径与数字后缀，
 *   因为容器里它常被截断成 15 字符
 * @param tools 探到的工具路径。**用 `!= null` 而不是真值判断**：
 *   `''` 与 `null` 同样表示"没有"，但它们都是有效的"没装"信号
 * @returns init 系统；连工具都没探到时给 `'none'`（不是 unknown）——
 *   `'none'` 是一个结论：这里确实没有 init，调用方据此写不依赖 init 的部署路径
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

/**
 * `Linger=yes` / `Linger=no`。缺字段、拼错、权限不足 → 一律 false（保守）
 *
 * 保守的方向是刻意选的：报 false 的后果是用户态 unit 在注销后停掉（能看见），
 * 报 true 的后果是它以为自己能常驻而实际随时被停（看不见）。
 *
 * @param stdout `loginctl show-user <me> --property=Linger` 的输出。
 *   权限不足时 loginctl 会**正常退出并打印 `Linger=`**，所以判据必须落在整行上
 * @returns `true` 仅当存在一行完整的 `Linger=yes`
 */
export function parseLinger(stdout: string): boolean {
  return /^Linger=yes\s*$/im.test(stdout)
}

// ------------------------------------------------------------
// sudo -n -l
// ------------------------------------------------------------

/**
 * 解析 `sudo -n -l`。
 *
 * 目标是「**能 sudo 哪几条命令**」而不是「能不能 sudo」。
 * 典型输出：
 *   Matching Defaults ...
 *   User deploy may run the following commands on host:
 *       (ALL) NOPASSWD: ALL
 *       (root) NOPASSWD: /usr/bin/systemctl, /usr/bin/tar
 * 无权时是 `Sorry, user deploy may not run sudo on host.` —— 返回 []。
 *
 * **保守策略**：只认 `NOPASSWD:` 后面明确列出的命令；带密码的条目（`ALL` 但
 * 没有 NOPASSWD）不计入 —— 它们会挂住，与铁律 0 冲突。
 *
 * @param stdout `sudo -n -l` 的 stdout
 * @param stderr 同一个命令的 stderr，**默认空串**。只用于判"无权限"
 *   （`may not run sudo` / `is not in the sudoers file`）—— 那句话可能落在任一个流里，
 *   少看一个流就会把"明确无权限"读成"有一条 ALL 白名单"
 * @returns 可免密执行的命令路径数组。`ALL` 作为**字面量 `ALL`** 保留在数组里，
 *   不展开成"任意命令"：调用方要的是一张能拿去比对具体命令的清单
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
 *
 * @param stdout 复合探测脚本的 stdout。**只认以 `DPT\t` 开头的行**，
 *   其它一切输出（含远端 shell 的横幅与告警）一律忽略 —— 解析器去猜别的行属于
 *   「从噪声里读事实」，那是本文件开头就禁掉的事
 * @returns 工具名 → 绝对路径；值为 `''` 或 `-`（脚本里表示 `command -v` 没命中）
 *   归一为 `null`。**没出现在输出里的工具不会出现在结果里**，
 *   由调用方按"没返回结果就是没有"补齐
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

/**
 * 远端 `stat` 的结果。**秒而不是毫秒**是远端的原生粒度（脚本直接用
 * `stat -c %Y`），换算成毫秒留在 Runner 里做 —— 在这里换会让读到这个类型的人
 * 以为它与本机 `FileStat` 已经同形，而两者其实差一个数量级。
 */
export interface RemoteStat {
  /** 四选一。`'other'` 是显式的"认识但不是这三种"，不是解析失败 */
  readonly kind: 'file' | 'dir' | 'link' | 'other'
  /** 字节数。**软链取链接本身的长度**（脚本里是 `readlink | wc -c`），不是目标的长度 —— 用目标的长度会让一个软链看起来像个大文件 */
  readonly size: number
  /** 秒级 mtime（远端 stat 的原生粒度） */
  readonly mtimeSec: number
}

/**
 * 解析 `DPSTAT\t<kind>\t<size>\t<mtime>` 那行。**读不到就返回 undefined**，
 * 调用方据此抛错：探测脚本改了格式却没人发现的话，本部署会带着一个恒为空的 stat 跑完全程。
 *
 * @param stdout 脚本 stdout。前面的 `DPT\t` 等其它输出全部跳过，只认 `DPSTAT\t` 前缀的行
 * @returns 解析结果；没有该行、字段不足 4 段时返回 `undefined`。
 *   数值字段解析失败时归零（只读探针不该因此失败），kind 认不出时归 `'other'`
 */
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

/**
 * 一次 ssh 失败的归类结果。`code` 是全仓登记过的码，调用方按它分派处置方式，
 * 所以归错的后果是**走向相反的建议** —— 这就是 parse.ts 里宁可笼统也不误判的原因。
 */
export interface SshFailure {
  /** 归类后的错误码。`HOST_KEY_*` 两码与 `AUTH_FAILED` 的处置方式互不相同 */
  readonly code: DpErrorCode
  /** 人话原因。取自远端原文首行，不做翻译 —— 翻译会丢掉具体措辞里的线索 */
  readonly reason: string
  /** 主机密钥类错误才有的指纹信息 */
  readonly expected?: string
  /** 实际拿到的指纹。只有 MISMATCH 会带 —— 它是"重新采集前不要盲目信任"的唯一依据 */
  readonly actual?: string
  /** 密钥算法（MISMATCH 时从 OpenSSH 印出的那行公钥里取）。给不出就 undefined，不猜 */
  readonly keyType?: string
}

/**
 * 把 OpenSSH 的 stderr 归类成结构化失败。
 *
 * 顺序敏感：先判主机密钥（MISMATCH 必须在 UNKNOWN 前面 —— "changed" 那种
 * 报错里也含 "unknown"，反过来会全归成 UNKNOWN），再判认证，最后才是连接。
 * 判不出来的走 CONNECT_FAILED 并带上 stderr 首行 —— **宁可笼统也不要误判**，
 * 误判成 AUTH_FAILED 会把用户引到完全错误的方向。
 *
 * @param stderr OpenSSH 的 stderr 原文。判据全部落在这段文本上，
 *   所以**不要**在传进来之前裁剪或改写
 * @param exitCode ssh 的退出码。只在文本里找不到任何线索时用来兜底成一句
 *   `ssh 退出码 N` —— 它本身不足以判因（255 同时覆盖认证失败与连不上）
 * @returns 归类结果。`expected` 恒为 undefined（我们不持有 known_hosts 里的原值，
 *   那是调用方的数据），`actual` / `keyType` 只有 MISMATCH 才有
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

/**
 * 主机密钥失败的统一提示 —— mismatch 场景下必须让用户知道「我们不会自动改」
 *
 * @param failure {@link classifySshError} 的结果。只认它的 `code`：
 *   `expected` / `actual` 缺失时措辞会退成「未知」，那是有意的 ——
 *   编一个占位指纹会让用户去比对一个不存在的东西
 * @returns 给用户看的下一步说明。**MISMATCH 分支里必须保留"我们不会自动改"**，
 *   自动改 known_hosts 恰好是中间人攻击最想要的效果
 */
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

/**
 * 把 runner 层的 IO 错误映射成 DpError（对齐 packages/local/src/runner.ts 的措辞）
 *
 * 全部映射到 `DP.PATH.NOT_WRITABLE` 这一族，因为它们对调用方的处置是同一件事：
 * 换个地方再试一次不会好。真正需要不同处置的（连不上、没工具）不在这里。
 *
 * @param code Node 的 errno 码。**认不出一律落到 default**，不为新码单开分支 ——
 *   猜一个语义去匹配一个没见过的 errno，比诚实地说"这是 I/O 错误"更坏
 * @param path 出问题的路径。拼进 message 是为了让用户在远端找得到位置
 * @param detail 补充细节，通常是远端 stderr 首行
 * @returns 一个 `DpError`（不是抛出）。ENOENT / EACCES / EPERM / EROFS / ENOSPC
 *   各带自己的 hint；default 用 `detail` 原样成句
 */
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
