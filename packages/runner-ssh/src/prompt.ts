/** 交互式 prompt 的种类 —— 每一种都对应一条「拒绝交互」的处置方式。 */
export type PromptKind =
  | 'password'
  | 'passphrase'
  | 'host-key-confirm'
  | 'sudo-no-tty'
  | 'pin'
  | 'otp'
  | 'su-password'
  | 'doas-password'

/**
 * 一条提示符模式。`kind` 决定给出的建议，**必须**是一个已知的 kind：认不出的 kind 会让上层给不出建议，于是这条提示符变成一句没用的报错。
 */
export interface PromptPattern {
  /** 提示符的类别。查 `HINT_BY_KIND` 取对应建议 */
  readonly kind: PromptKind
  /**
   * 模式本身。**必须行锚定且不含 `g`/`y` 标志** ——不带 `m` 的 `^` 锚在整段字符串开头，跨行日志里一条都没命中；带 `y` 的话 `/` 与 `'` 这类常见字符会漏掉整行的匹配。
   */
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
  { kind: 'host-key-confirm', re: /^[ \t]*(?:Are you sure|Do you want to continue)[^\n]*\?[ \t]*$/i },
  // 独立的 `(y/n)` / `[Y/n]` 一行
  { kind: 'host-key-confirm', re: /^[ \t]*[[(]?[Yy]\/[Nn][\])]?[ \t]*\??[ \t]*$/ },
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
  { kind: 'pin', re: /^[ \t]*Enter[ \t]+PIN[ \t]+for[^\n]*:[ \t]*$/i },
  { kind: 'pin', re: /^[ \t]*Verification[ \t]+code:[ \t]*$/i },
  { kind: 'otp', re: /^[ \t]*(?:One-time|OTP)[ \t]*code[^\n]*:[ \t]*$/i },
]

/**
 * 一次命中。`line` 会进错误 message，所以它必须是被截断过的原文 ——提示符行本身很短，而远端同一批输出里可能还有别的东西不该出现在报告里。
 */
export interface PromptMatch {
  /** 命中的类别，决定给出哪条建议 */
  readonly kind: PromptKind
  /** 命中的模式源码（`re.source`）。要它是为了让"为什么判成提示符"可复查 */
  readonly pattern: string
  /** 命中的那一行。会进 message，所以必须是原文（不含凭据） */
  readonly line: string
}

/**
 * 命中即说明对端在等输入，调用方据此终止而不是继续等
 *
 * @param text 已收到的输出。空串直接返回 undefined 而不进循环 ——
 * 「没有输出」是绝大多数正常执行的形态，不该为它付出逐行扫描的代价
 * @param extra 调用方追加的模式。**排在内置表之后**：同一段文本先按内置判，
 * 这样本地定制只能补盲区，不能把内置的结论改掉
 * @returns 第一个命中；没有任何模式匹配时返回 `undefined`
 * （**不是**"未检查"—— 没命中与没检查在这条链上等价：都是没有等待输入就失败了）
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

/**
 * 提示符类别 → 用户该做什么。
 *
 * @param kind {@link detectPrompt} 报出的类别
 * @returns 一句话建议。类别不在表里时返回 `undefined`（`Record` 不做兜底），
 * 调用方必须处理这个 case：静默给 `undefined` 的 hint 会让错误消息里少一整段指引
 */
export function promptHint(kind: PromptKind): string {
  return HINT_BY_KIND[kind]
}
