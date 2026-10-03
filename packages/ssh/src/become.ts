/**
 * 提权包装 —— **纯函数，零 IO**。
 *
 * 关键设计：提权是两个正交问题 ——
 *  **包装**（`wrap(argv) → argv`，本文件）与**投喂**（提示符出现时怎么答，运行期）。
 * 本文件只管包装，且只管**不产生任何等待 stdin 的命令**（铁律 0）。
 *
 * 为什么 `su` 只做包装、不保证可用：实测 busybox `su` 缺 suid 位，
 * `su -c 'id' root` 直接报 `su: must be suid to work properly`。`command -v su`
 * 却返回有 —— 这就是「能力必须实证」的典型样本。
 * 所以能不能用由 `canElevate()` 跑一次 `sudo -n true` 说了算，不由本函数决定。
 */
import { DpError, type BecomeConfig } from '@dp/ports'
import { quoteArg, quoteArgv } from './argv.js'

export type { BecomeConfig }

export interface WrapOptions {
  /** 替换默认的 POSIX 转义器。测试与自定义 shell 可以换掉它 */
  readonly shellEscape?: (arg: string) => string
  /**
   * 调用方是否已准备好密码通道（stdin 投喂 / pty 会话）。
   * `nonInteractive: false` 时**必须**为 true，否则拒绝 —— 铁律 0。
   */
  readonly passwordChannel?: boolean
}

const escape = (o: WrapOptions | undefined): ((a: string) => string) => o?.shellEscape ?? quoteArg

function refuseInteractive(what: string): never {
  throw new DpError('DP.CONFIG.INVALID', `become.${what} 会产生一个等待 stdin 的命令，已拒绝`, {
    path: `become.${what}`,
    hint: '铁律 0：永不交互。要么配免密（sudoers NOPASSWD 白名单，实测 `sudo -n` 可用），要么由调用方显式提供密码通道（options.passwordChannel = true，走 stdin 投喂 / pty 会话）',
  })
}

/**
 * 按 shell 语义切分渲染后的模板：尊重单引号与 `'\''` 续接。
 *
 * 为什么需要它（这个函数存在的全部理由）：`${cmd}` 替换进去的是**已转义**的
 * 命令串，如果切分时不理解引号，`echo 'a b'` 会被切成 `echo`、`'a`、`b'`
 * 三个 argv —— 部署到 `/srv/my app` 这种带空格的路径时会静默写错地方。
 */
function splitShellWords(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let started = false
  let i = 0
  while (i < input.length) {
    const c = input[i]!
    if (c === ' ' || c === '\t' || c === '\n') {
      if (started) {
        out.push(cur)
        cur = ''
        started = false
      }
      i++
      continue
    }
    if (c === "'") {
      started = true
      i++
      while (i < input.length) {
        if (input[i] === "'") {
          // `'\''`：闭引号 + 转义的单引号 + 重开引号
          if (input[i + 1] === '\\' && input[i + 2] === "'" && input[i + 3] === "'") {
            cur += "'"
            i += 4
            continue
          }
          i++
          break
        }
        cur += input[i]
        i++
      }
      continue
    }
    started = true
    cur += c
    i++
  }
  if (started) out.push(cur)
  return out
}

/**
 * 把一条远端命令包装成提权后的 argv。
 *
 * 五种 become 的产出形状（`--` 一律带上，防止命令参数被 sudo/doas 自己吃掉）：
 *  - `none`    → 原样返回
 *  - `sudo`    → `sudo -n [-g group] [-u user] -- <argv...>`
 *  - `doas`    → `doas -n [-u user] -- <argv...>`
 *  - `su`      → `su <user> [-s <shell>] -c <escaped script>`
 *  - `custom`  → 模板里 `${cmd}` 替换为**已转义的整条命令**，再按 shell 引号语义切 argv
 */
export function wrapCommand(
  argv: readonly string[],
  become: BecomeConfig,
  opts?: WrapOptions,
): readonly string[] {
  if (argv.length === 0) {
    throw new DpError('DP.CONFIG.INVALID', 'wrapCommand 收到空 argv', {
      hint: '提权一个不存在的命令没有意义；检查调用方',
    })
  }
  const esc = escape(opts)

  switch (become.type) {
    case 'none':
      return argv

    case 'sudo': {
      const nonInteractive = become.nonInteractive ?? true
      if (!nonInteractive && opts?.passwordChannel !== true) refuseInteractive('sudo.nonInteractive=false')
      const out = ['sudo']
      if (nonInteractive) out.push('-n')
      if (become.group !== undefined) out.push('-g', become.group)
      if (become.user !== undefined) out.push('-u', become.user)
      // 永远不带 -E：默认不保留用户环境，否则 LD_PRELOAD 之类会跟着过去
      out.push('--', ...argv)
      return out
    }

    case 'doas': {
      const out = ['doas', '-n']
      if (become.user !== undefined) out.push('-u', become.user)
      out.push('--', ...argv)
      return out
    }

    case 'su': {
      // su 的密码走 tty，wrap 阶段管不了。能不能用由 canElevate() 实证。
      const out = ['su', become.user]
      if (become.shell !== undefined) out.push('-s', become.shell)
      // 双层引号是这里最容易写错的地方：
      // 逐参数转义后再拼，所以用户输入里的单引号已经变成 '\''。
      out.push('-c', argv.map(esc).join(' '))
      return out
    }

    case 'custom': {
      const cmd = argv.map(esc).join(' ')
      if (!become.template.includes('${cmd}')) {
        throw new DpError('DP.CONFIG.INVALID', 'become.template 不含 ${cmd} 占位', {
          path: 'become.template',
          hint: '模板必须有一个 ${cmd} 占位，例如 `dzdo -u root ${cmd}`；没有占位的话原命令会被丢掉',
        })
      }
      const rendered = become.template.replaceAll('${cmd}', cmd)
      const parts = splitShellWords(rendered)
      if (parts.length === 0) {
        throw new DpError('DP.CONFIG.INVALID', 'become.template 渲染后为空', {
          path: 'become.template',
          hint: '检查模板里 ${cmd} 两侧的内容',
        })
      }
      return parts
    }
  }
}

/** 提权失败时的统一 hint —— 三种机制共用，因为建议的动作是同一个：在目标机配免密白名单 */
export const ELEVATE_FAILED_HINT =
  '在目标机给这几条命令加 sudoers NOPASSWD 白名单（实测 `sudo -n` 可用），或改用 become.type=none 以普通用户身份部署到可写目录。我们不会替你改 /etc/sudoers.d/ —— 授权必须由运维显式完成'

/** 把远端 `sudo -n` 的原话转成安全的、可进 message 的一句话 */
export function summarizeElevateFailure(stderr: string): string {
  const first = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (first === undefined) return '（目标机没有输出任何原因）'
  return first.slice(0, 200)
}

export { quoteArg, quoteArgv }
