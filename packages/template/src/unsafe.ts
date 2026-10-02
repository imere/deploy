/**
 * 危险字符校验 —— 分档的最后一道闸门。
 *
 * 「分档」而不是一刀切的理由：模板里出现换行是**正常**的（nginx server 块就是多行），
 * 而把一个带换行的环境变量塞进 `root` 指令里是**事故**。同一个字符在不同落点
 * 危险程度完全不同，所以严格程度由 usage 决定，而不是由字符表一刀切。
 *
 * 明确不做的事：这里不防注入，只防字符级污染。真正防注入靠结构化生成 conf
 * （@dp/target-nginx 的职责：谁在什么位置、拼什么 token），那是另一个层次的问题。
 */
import { DpError } from '@dp/ports'
import { checkSourcePaths } from '@dp/core'
import type { Usage } from './context.js'

/** 各档下"这个值会被写进哪里"—— 错误必须说清后果，否则用户不知道该改哪 */
const DESTINATION: Readonly<Record<Usage, string>> = {
  text: '普通文本字段',
  path: '远端文件路径（会出现在 conf 或 mv/mkdir 的参数里）',
  shell: '远端命令的参数（以 exec(argv[]) 传入，不经过 shell 解析）',
  conf: 'nginx conf / compose yaml 文件',
}

/** 每档额外放行的空白字符。控制字符（C0 + DEL）在任何一档都拒绝 */
const ALLOWED: Readonly<Record<Usage, ReadonlySet<number>>> = {
  text: new Set([0x09, 0x0a, 0x0d]),
  // path 连换行都不给：路径里出现换行会让「一个参数」变成两行日志 / 两条命令
  path: new Set([0x09]),
  // shell 档**不拦 `;`**：`;` 在合法路径里可能出现（`/srv/web;backup` 这类备份目录
  // 命名），而本仓从不拼 shell 字符串 —— Runner 只有 exec(argv[])，参数被交给
  // 目标机的 execve，中间没有 shell 去解释分号。为它报错只会误伤，
  // 真正该拦的是换行：换行会破坏「一个 argv 元素」的边界。
  shell: new Set<number>(),
  conf: new Set<number>(),
}

/**
 * 字符的**转义**形式。
 *
 * 错误信息里绝不放原始控制字符：一个裸 NUL 或 ESC 进了日志，会让终端、
 * JSONL 文件、乃至 diff 全部错乱 —— 排查者看到的只会是"日志坏了"。
 */
export function escapeChar(ch: string): string {
  const code = ch.charCodeAt(0)
  if (ch === '\n') return '<LF>'
  if (ch === '\r') return '<CR>'
  if (ch === '\t') return '<TAB>'
  if (code >= 0x20 && code !== 0x7f) return ch
  return `\\u${code.toString(16).padStart(4, '0')}`
}

/** 给不可打印片段用的整体转义（错误 message 的位置片段用） */
export function escapeFragment(text: string): string {
  let out = ''
  for (const ch of text) out += escapeChar(ch)
  return out
}

function firstControlChar(value: string, usage: Usage): string | undefined {
  const allowed = ALLOWED[usage]
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if (code > 0x1f && code !== 0x7f) continue
    if (allowed.has(code)) continue
    return ch
  }
  return undefined
}

/**
 * 盘符（`C:`）与 UNC 前缀（`\\host\share`）。
 *
 * 必须先把它们摘掉再校验：core 的 win32 判定把 `:` 列为非法字符，因为它原本校验的
 * 是**源路径条目**（`dist/index.html` 这类相对路径，永远不会有盘符）。而这里的
 * value 是渲染出来的完整路径，Windows 目标机上必然是 `C:/srv/web/current` ——
 * 不摘前缀就等于宣布「path 档不支持 Windows 目标机」，与分档的初衷正好相反。
 */
const VOLUME_PREFIX = /^(?:[A-Za-z]:|\\\\[^\\/]+\\[^\\/]+)/

/**
 * 路径档复用 core 已有的非法字符 / 保留名判定 —— **不重写一遍**。
 *
 * 那套判定（core/src/paths.ts 的 WIN_ILLEGAL / WIN_RESERVED）现在是源路径校验的
 * 单一事实来源；这里再抄一份就等于有两套规则，迟早漂移。固定按 win32 档筛：
 * 那是三个平台里字符集最严的一档（linux 档只查长度与大小写冲突），用最严的一档
 * 做前置闸门，代价是多拒一些极少出现在路径里的字符（`<` `>` `|` `?` `*`），
 * 收益是本地与远端行为一致。
 */
function assertPathRules(value: string, path: string | undefined): void {
  const body = value.slice(VOLUME_PREFIX.exec(value)?.[0].length ?? 0)
  try {
    checkSourcePaths([body], 'win32')
  } catch (err) {
    if (!(err instanceof DpError)) throw err
    // 定位到具体字符：逐字符问 core 同一个判定（单字符不可能命中保留名，
    // 那需要 ≥3 字节），复用规则而不复制正则。值都很短，逐字扫可接受。
    let offender: string | undefined
    for (const ch of body) {
      try {
        checkSourcePaths([ch], 'win32')
        continue
      } catch {
        offender = ch
        break
      }
    }
    const which = offender !== undefined ? escapeChar(offender) : err.code
    throw new DpError(
      'DP.TPL.UNSAFE_VALUE',
      `渲染结果含路径不允许的字符 ${which}：${escapeFragment(value)}（该值会被写进${DESTINATION.path}）`,
      {
        ...(path !== undefined ? { path } : {}),
        hint:
          offender !== undefined
            ? '路径里不能有 < > : " | ? * 与控制字符（跨 Windows 拷贝、改名、rsync 都会出问题）；改配置里的路径，或把它挪到不会进路径的位置'
            : `${err.hint ?? '路径不符合目标平台要求'}；若确实需要，请调整该配置项而不是绕过校验`,
      },
    )
  }
}

/**
 * 字符级闸门。不通过抛 `DP.TPL.UNSAFE_VALUE`。
 *
 * 渲染路径上只校验**被替换进去的那个值**，不校验整份模板 —— 模板自身的多行结构
 * 是作者写的、是被允许的；危险的是注入进来的内容。
 */
export function assertSafe(value: string, usage: Usage, path?: string): void {
  const bad = firstControlChar(value, usage)
  if (bad !== undefined) {
    const code = bad.charCodeAt(0)
    const why =
      usage === 'text'
        ? 'NUL 与控制字符会破坏日志与传输边界'
        : code === 0x0a || code === 0x0d
          ? '换行会把一个值拆成两行 —— 落到这个位置就意味着参数与指令的边界不再是代码划定的那条'
          : '控制字符没有正当用途'
    throw new DpError(
      'DP.TPL.UNSAFE_VALUE',
      `渲染结果含被拒字符 ${escapeChar(bad)}：${escapeFragment(value)}（该值会被写进${DESTINATION[usage]}）`,
      {
        ...(path !== undefined ? { path } : {}),
        hint: `${why}。修掉变量来源里的这个字符（环境变量 / git 标签 / 版本号都可能被人工塞进奇怪内容），或改用不会落到这个位置的形式`,
      },
    )
  }
  if (usage === 'path') assertPathRules(value, path)
}
