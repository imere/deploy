/**
 * 交互式 prompt 嗅探 —— **纯函数，零 IO**。
 *
 * 为什么要在运行时嗅探：`sudo` 的措辞、`su` 的措辞、`ssh` 的确认提示，
 * 各发行版/各语言都不同，穷举不完（local/src/exec.ts 也留了同样的口子）。
 * 与其穷举，不如**认出一个就立刻失败** —— 挂起等人类输入是比失败恶劣得多的
 * 行为，在 CI 里表现为永久挂起（铁律 0）。
 *
 * 难点是**别误伤**：远端日志里出现 `password` 这个词是极常见的
 * （`nginx: password file updated`、`sshd: PasswordAuthentication changed`）。
 * 所以所有模式都**行锚定**且要求提示符出现在行尾或冒号后 —— 只有
 * `Password:` 这种「一行里只有提示符」的形态才算命中。
 */
export type PromptKind =
  | 'password'
  | 'passphrase'
  | 'host-key-confirm'
  | 'sudo-no-tty'
  | 'pin'
  | 'otp'
  | 'su-password'
  | 'doas-password'

export interface PromptPattern {
  readonly kind: PromptKind
  readonly re: RegExp
}

/**
 * 模式表。全部行锚定（`^`/`$` + `m` 标志），命中行必须**整行**是提示符形态。
 */
export const PROMPT_PATTERNS: readonly PromptPattern[] = [
  // `Password: ` —— 独占一行（允许尾随空格）
  { kind: 'password', re: /^[ \t]*(?:\[[^\]\n]*\][ \t]+)?(?:[Ss]udo[ \t]+)?(?:[Pp]assword|[Pp]asswd)[ \t]*:[ \t]*$/ },
  // `[sudo] password for deploy:` / `sudo password:`
  { kind: 'password', re: /^[ \t]*\[sudo\][ \t]+password[ \t]+for[ \t]+\S+:[ \t]*$/ },
  // `user@host's password:`（ssh 密码提示的常见形态）
  { kind: 'password', re: /^\S+@[^:\n]*'s[ \t]+password:[ \t]*$/ },
  // `Enter passphrase for key '/x/id_ed25519':` / `Enter passphrase for key:`
  { kind: 'passphrase', re: /^[ \t]*Enter[ \t]+passphrase[ \t]+for[ \t]+(?:key|PKCS#11|it).*:[ \t]*$/ },
  { kind: 'passphrase', re: /^[ \t]*(?:Enter[ \t]+)?passphrase[ \t]*:[ \t]*$/ },
  // 首次连接的主机指纹确认。OpenSSH 至少有三种措辞。
  { kind: 'host-key-confirm', re: /Are you sure you want to continue connecting[^\n]*/i },
  // 泛化形态：**必须以问号结尾**。少了这个约束，`y/n is not a question here`
  // 这种普通日志会被误判成提示符 —— 宁可漏判也不误杀。
  { kind: 'host-key-confirm', re: /^[ \t]*(?:Are you sure|Do you want to continue)[^\n]*\?[ \t]*$/i },
  // 独立的 `(y/n)` / `[Y/n]` 一行
  { kind: 'host-key-confirm', re: /^[ \t]*[\[(]?[Yy]\/[Nn][\])]?[ \t]*\??[ \t]*$/ },
  // sudo 在没有 tty 时拒绝读密码 —— 挂着的最主要来源
  { kind: 'sudo-no-tty', re: /^[ \t]*sudo:[ \t]*no tty present[^\n]*$/i },
  { kind: 'sudo-no-tty', re: /^[ \t]*sudo:[ \t]*a terminal is required[^\n]*$/i },
  // `su:` 自己的措辞（busybox / util-linux 不一样）
  { kind: 'su-password', re: /^[ \t]*su(?:\[[^\]\n]*\])?:[ \t]*$/ },
  { kind: 'su-password', re: /^[ \t]*Password:[ \t]*$/ },
  // doas 走 OpenBSD 的问法
  { kind: 'doas-password', re: /^[ \t]*doas[ \t]*\(?.*\)?[ \t]*:[ \t]*$/ },
  // 双重认证 / 硬件密钥
  { kind: 'pin', re: /^[ \t]*(?:Enter[ \t]+)?PIN[ \t]*:[ \t]*$/ },
  // `Enter PIN for 'My Token':` / `Enter PIN for 'PIV Card':` —— 只认裸 `PIN:` 会漏掉
  // 这种带对象的写法，漏判的后果是挂在那里等人类输入（铁律 0）
  { kind: 'pin', re: /^[ \t]*Enter[ \t]+PIN[ \t]+for[^\n]*:[ \t]*$/i },
  { kind: 'pin', re: /^[ \t]*Verification[ \t]+code:[ \t]*$/i },
  { kind: 'otp', re: /^[ \t]*(?:One-time|OTP)[ \t]*code[^\n]*:[ \t]*$/i },
]

export interface PromptMatch {
  readonly kind: PromptKind
  readonly pattern: string
  /** 命中的那一行。会进 message，所以必须是原文（不含凭据） */
  readonly line: string
}

/**
 * 在一段输出里找 prompt。
 *
 * `extra` 允许调用方追加本机特有的模式（比如某个发行版的 su）。
 * 返回第一个命中（按模式表顺序，不是按出现位置）—— 提示符形态都很独特，
 * 位置顺序没有诊断价值。
 */
export function detectPrompt(text: string, extra: readonly PromptPattern[] = []): PromptMatch | undefined {
  if (text === '') return undefined
  // 逐行扫而不是整段正则：整段锚定容易在有前导内容的行上漏判
  const lines = text.split(/\r?\n/)
  for (const { kind, re } of [...PROMPT_PATTERNS, ...extra]) {
    for (const line of lines) {
      // 上限 200 字符：提示符行都很短，长的多半是普通日志
      if (line.length > 200) continue
      if (re.test(line)) {
        return { kind, pattern: re.source, line: line.trim().slice(0, 120) }
      }
    }
  }
  return undefined
}

const HINT_BY_KIND: Readonly<Record<PromptKind, string>> = {
  password: '改用密钥（auth.type=key）或 agent；或配 passwordRef 让 SSH_ASKPASS 无交互喂密码',
  passphrase: '密钥有 passphrase 但没有免密通道：把密钥加进 agent（ssh-add），或用 passphraseRef + SSH_ASKPASS',
  'host-key-confirm': '把目标机的主机密钥写进 known_hosts，或显式配置 knownHosts: accept-new / tofu；我们不会自动接受未知的指纹',
  'sudo-no-tty': 'sudo 需要 tty：给该命令加 NOPASSWD 白名单（`sudo -n` 实测可用），或改用 become.type=none 以普通用户部署到可写目录',
  pin: '目标是带 PIN 的硬件密钥：换密钥认证；我们不做交互式 token 询问',
  otp: '目标是 TOTP/一次性口令：无法无交互处理，请换密钥认证',
  'su-password': 'su 必须读 tty 才会给密码 —— 铁律 0 禁止等待输入。改用 sudo NOPASSWD 白名单，或 become.type=none',
  'doas-password': 'doas 需要 tty：给 doas.conf 配不询问的规则，或改用 sudo NOPASSWD',
}

export function promptHint(kind: PromptKind): string {
  return HINT_BY_KIND[kind]
}
