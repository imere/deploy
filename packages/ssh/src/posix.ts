/**
 * 远端 POSIX 脚本构造 —— **纯函数，零 IO**。
 *
 * 每条脚本的头两行是**给测试看的机器可读意图**：
 *   `#dp-op=<op>` / `#dp-arg=<base64url(JSON)>`
 * 它们在真实目标机上就是两行注释（零开销、零行为影响），但让 FakeSshDriver
 * 能**不执行 shell**就理解这条命令要干什么，从而对 Runner 的每个方法做
 * 真断言 —— 正常 / 不存在 / 权限失败 / 超时 / prompt 命中。
 *
 * 诚实说明这个测试边界：它验证的是**客户端逻辑**（argv 构造、路径校验、
 * 退出码映射、截断、超时、prompt 嗅探），脚本**体**本身只在真机上被执行 ——
 * 那是 e2e 套件的职责。
 *
 * 退出码约定（runner.ts 据此映射，跨发行版稳定，因为是我们自己定的）：
 *   0 成功 · 3 不存在 · 4 不是软链 · 5 权限/其他失败 · 6 缺 base64
 */
import { quoteArg } from './argv.js'

export const OP_STAT = 'stat'
export const OP_LIST = 'list'
export const OP_MKDIR = 'mkdir'
export const OP_WRITE = 'write'
export const OP_READ = 'read'
export const OP_REMOVE = 'remove'
export const OP_RENAME = 'rename'
export const OP_SYMLINK = 'symlink'
export const OP_READLINK = 'readlink'
export const OP_REALPATH = 'realpath'

export interface RemoteOp {
  readonly op: string
  readonly args: Readonly<Record<string, unknown>>
}

const b64url = (json: string): string => Buffer.from(json, 'utf8').toString('base64url')

/** 头两行 = 意图；后面 = 可执行体。`sh -c` 拿到它就是完整脚本。 */
export function script(op: string, args: Readonly<Record<string, unknown>>, body: string): string {
  return `#dp-op=${op}\n#dp-arg=${b64url(JSON.stringify(args))}\n${body}`
}

/** 从脚本里读回意图。FakeSshDriver 用它；生产路径不需要。 */
export function readIntent(scriptText: string): RemoteOp | undefined {
  const opM = /^#dp-op=([a-z]+)$/m.exec(scriptText)
  const argM = /^#dp-arg=([A-Za-z0-9_-]+)$/m.exec(scriptText)
  if (opM === null) return undefined
  if (argM === null) return { op: opM[1]!, args: {} }
  try {
    return { op: opM[1]!, args: JSON.parse(Buffer.from(argM[1]!, 'base64url').toString('utf8')) as Record<string, unknown> }
  } catch {
    return { op: opM[1]!, args: {} }
  }
}

const q = quoteArg

/** mode 一律三位八进制显式写出：umask 会吃掉 `mkdir -m 7` 的意思 */
const mode = (m: number): string => `0${(m & 0o7777).toString(8).padStart(3, '0')}`

export function statScript(path: string): string {
  return script(
    OP_STAT,
    { path },
    [
      `p=${q(path)}`,
      'if [ -L "$p" ]; then k=link; sz=$(readlink "$p" 2>/dev/null | wc -c)',
      'elif [ -d "$p" ]; then k=dir; sz=0',
      'elif [ -f "$p" ]; then k=file; sz=$(wc -c < "$p")',
      'else exit 3; fi',
      // stat 的选项在 GNU 与 BSD 上不同，都试一遍；都不行就记 0（只读探针，不该因此失败）
      'mt=$(stat -c %Y "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null || echo 0)',
      `printf 'DPSTAT\\t%s\\t%s\\t%s\\n' "$k" "$sz" "$mt"`,
    ].join('\n'),
  )
}

export function listDirScript(path: string): string {
  return script(
    OP_LIST,
    { path },
    [
      `p=${q(path)}`,
      '[ -d "$p" ] || exit 3',
      // -A 去掉 . 与 ..，-1 每行一个。名字含换行会被拆错 —— 已知限制，
      // 传输层用的是 sftp 通道，那里是长度前缀协议，没有这个问题
      "ls -1A -- \"$p\" 2>/dev/null || exit 5",
    ].join('\n'),
  )
}

export function mkdirScript(path: string, recursive: boolean, fileMode: number): string {
  const body = [
    `p=${q(path)}`,
    recursive ? 'mkdir -p -m 0755 -- "$p" || exit 5' : `mkdir -m ${mode(fileMode)} -- "$p" || exit 5`,
  ]
  // 非递归时父目录不存在 → mkdir 自己会失败(5)；显式区分成 3 会更准但不额外探测
  return script(OP_MKDIR, { path, recursive, fileMode }, body.join('\n'))
}

export function writeFileScript(path: string, dataB64: string, fileMode: number): string {
  return script(
    OP_WRITE,
    { path, fileMode, bytes: Math.floor((dataB64.length * 3) / 4) },
    [
      `p=${q(path)}`,
      `d=${q(dataB64)}`,
      'mkdir -p -m 0755 -- "$(dirname -- "$p")" 2>/dev/null || true',
      // 二进制必须走 base64：echo 会吃掉反斜杠、printf '%s\n' 会多补一个换行
      'printf %s "$d" | base64 -d > "$p" || exit 5',
      `chmod ${mode(fileMode)} -- "$p" || exit 5`,
    ].join('\n'),
  )
}

export function readFileScript(path: string): string {
  return script(
    OP_READ,
    { path },
    [
      `p=${q(path)}`,
      '[ -f "$p" ] || exit 3',
      // -w0 只有 GNU 有；tr -d '\n' 各家都行，所以只做后者
      'base64 < "$p" | tr -d "\\n" || exit 6',
    ].join('\n'),
  )
}

export function removeScript(path: string): string {
  return script(OP_REMOVE, { path }, [`p=${q(path)}`, 'rm -rf -- "$p" || exit 5'].join('\n'))
}

export function renameScript(from: string, to: string): string {
  return script(
    OP_RENAME,
    { from, to },
    [`a=${q(from)}`, `b=${q(to)}`, 'mv -f -- "$a" "$b" || exit 5'].join('\n'),
  )
}

export function symlinkScript(target: string, linkPath: string): string {
  return script(
    OP_SYMLINK,
    { target, linkPath },
    [`t=${q(target)}`, `l=${q(linkPath)}`, 'ln -s -f -- "$t" "$l" || exit 5'].join('\n'),
  )
}

export function readlinkScript(path: string): string {
  return script(
    OP_READLINK,
    { path },
    [`p=${q(path)}`, '[ -L "$p" ] || exit 4', 'readlink "$p" || exit 5'].join('\n'),
  )
}

export function realpathScript(path: string): string {
  return script(
    OP_REALPATH,
    { path },
    [
      `p=${q(path)}`,
      'if [ -d "$p" ]; then cd -- "$p" && pwd -P',
      // 不存在的路径：解析父目录再拼回 basename，这样预检能在创建之前就发现路径逃逸
      'else d=$(dirname -- "$p"); b=$(basename -- "$p"); cd -- "$d" 2>/dev/null || exit 3; printf "%s/%s\\n" "$(pwd -P)" "$b"; fi',
    ].join('\n'),
  )
}
