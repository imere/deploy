import { quoteArg } from './argv.js'

const OP_STAT = 'stat'
const OP_LIST = 'list'
const OP_MKDIR = 'mkdir'
const OP_WRITE = 'write'
const OP_READ = 'read'
const OP_REMOVE = 'remove'
const OP_RENAME = 'rename'
const OP_SYMLINK = 'symlink'
const OP_READLINK = 'readlink'
export const OP_REALPATH = 'realpath'

/**
 * 一条脚本的机器可读意图。**存在的理由是测试**：真机上这两行就是注释，零行为影响，但 FakeSshDriver 能据此在不执行 shell 的前提下断言 Runner 的每个方法 ——否则整条文件操作链就只能靠 e2e 覆盖，而 e2e 跑不起所有错误分支。
 */
export interface RemoteOp {
  /** {@link OP_STAT} 等常量之一。与名字不符的 op 一律按不认处理 */
  readonly op: string
  /** 脚本的实参。用 Record 而非元组，因为断言关心的是"传了哪个路径"而不是顺序 */
  readonly args: Readonly<Record<string, unknown>>
}

const b64url = (json: string): string => Buffer.from(json, 'utf8').toString('base64url')

/**
 * 头两行 = 意图；后面 = 可执行体。`sh -c` 拿到它就是完整脚本。
 *
 * @param op 操作名，写进 `#dp-op=`
 * @param args 实参，JSON 序列化后 base64url 写进 `#dp-arg=`
 * @param body 可执行的 POSIX 片段。**不校验它** —— 它由本文件里的其它函数拼，
 * 参数早在到达这里之前就被 `@dp/runner-ssh` 的路径校验与 quoteArg 处理过了
 * @returns 三段拼成的一条字符串，头两行与 body 之间各一个换行
 */
export function script(op: string, args: Readonly<Record<string, unknown>>, body: string): string {
  return `#dp-op=${op}\n#dp-arg=${b64url(JSON.stringify(args))}\n${body}`
}

/**
 * 从脚本里读回意图。FakeSshDriver 用它；生产路径不需要。
 *
 * @param scriptText 完整的脚本文本。**只认行首的 `#dp-op=` / `#dp-arg=`**：
 * 写在正文中段不算，否则脚本体里恰好出现这两个字串时会被读成意图
 * @returns 意图；没有 `#dp-op=` 行、或 `#dp-arg=` 解不开时返回
 * `{ op, args: {} }` 或 `undefined`。**解码失败不抛** —— 断言时它只是一个
 * 说明「这条脚本不是按约定造的」，不该让测试跑挂在异常上
 */
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

/**
 * 软链/目录/文件三态 + 大小 + mtime 的探测脚本。
 *
 * @param path 路径。会经 quoteArg 转义后**重新赋给变量 p 再用 `"$p"`**：
 * 直接把路径内联进 test/`stat` 会让引号与空格变成脚本语法，而不是路径的一部分
 * @returns 一条 `sh -c` 脚本；不存在时以退出码 3 结束，解析层据此区分"没有"与"坏了"
 */
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

/**
 * 列目录。**不递归** —— 调用方要的是一层条目，递归会让一个 node_modules直接变成一次跑不完的远端遍历。
 *
 * @param path 要列的目录
 * @returns 一条 `sh -c` 脚本。`-A` 去掉 `.` 与 `..`（调用方不该看到它们），
 * `-1` 每行一个；不是目录时退出码 3。**已知限制**：名字里含换行会被拆成两行 ——
 * 这就是传输层改走 sftp 的原因，那里是长度前缀协议
 */
export function listDirScript(path: string): string {
  return script(
    OP_LIST,
    { path },
    [
      `p=${q(path)}`,
      '[ -d "$p" ] || exit 3',
      // -A 去掉 . 与 ..，-1 每行一个。名字含换行会被拆错 —— 已知限制，
      "ls -1A -- \"$p\" 2>/dev/null || exit 5",
    ].join('\n'),
  )
}

/**
 * 建目录。**递归时 mode 固定 0755 而不是跟随 fileMode**：中间目录是我们自己造的容器，把用户为「内容文件」指定的 mode 套上去，会让某个部署把整条路径链的权限一起改掉。
 *
 * @param path 目录路径
 * @param recursive 递归与否。非递归时父目录不存在由 mkdir 自己失败（退出码 5）——
 * 显式探一次父目录能把 3/5 分得更准，但要多一趟远端往返，不值
 * @param fileMode 八进制权限位，**仅非递归时**用作 `-m`。三位显式写出，
 * 因为 `umask` 会吃掉 `mkdir -m 7` 里的最后一位
 * @returns 一条 `sh -c` 脚本；任何 mkdir 失败都以退出码 5 结束
 */
export function mkdirScript(path: string, recursive: boolean, fileMode: number): string {
  const body = [
    `p=${q(path)}`,
    recursive ? 'mkdir -p -m 0755 -- "$p" || exit 5' : `mkdir -m ${mode(fileMode)} -- "$p" || exit 5`,
  ]
  // 非递归时父目录不存在 → mkdir 自己会失败(5)；显式区分成 3 会更准但不额外探测
  return script(OP_MKDIR, { path, recursive, fileMode }, body.join('\n'))
}

/**
 * 写一个文件（内容已由调用方 base64 编码）。
 *
 * @param path 目标文件路径
 * @param dataB64 内容的 base64。**只能是 base64 字母表**（含 `=` / `+` / `/`），
 * 其它内容解出来是垃圾字节，而远端解码失败时只会以退出码 5 含糊地失败
 * @param fileMode 八进制权限位，三位显式写出
 * @returns 一条 `sh -c` 脚本。父目录用 `-p` 顺带创建（失败也不管 ——
 * 接下来的重定向失败会给出一个更准的错误）；写或 chmod 失败退出码 5
 */
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

/**
 * 读一个文件，输出 base64。
 *
 * @param path 要读的文件路径。**必须是普通文件**：软链与目录都按退出码 3 处理，
 * 因为读一个目录在 `base64 < dir` 上的行为取决于实现，不是我们的契约
 * @returns 一条 `sh -c` 脚本，stdout 是无换行的 base64；文件不存在退出码 3，
 * 远端没有 base64 退出码 6（这两码不同，才能给出不同建议）
 */
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

/**
 * 删一个路径（文件或目录树）。
 *
 * @param path 要删的路径
 * @returns 一条 `sh -c` 脚本。**路径不存在时也成功**（`-f` 吞掉 ENOENT）：
 * 删除操作在重试语义下必须是幂等的，否则第二次部署就会死在"删一个已经不在的东西"上
 */
export function removeScript(path: string): string {
  return script(OP_REMOVE, { path }, [`p=${q(path)}`, 'rm -rf -- "$p" || exit 5'].join('\n'))
}

/**
 * 原子改名/移动，语义对齐 `rename(2)`：目标存在就被**替换**。
 *
 * 为什么必须先试 `-T`：不带 `-T` 的 `mv` 在目标是「指向目录的软链」时，不会替换
 * 那个软链，而是把源**挪进它指着的目录**。真机实测的后果是第二次部署之后
 * `current` 仍旧指向上一版（站点还是旧内容），而换向前建的临时软链作为残留留在
 * 旧版本目录里 —— 整个过程退出码 0，报告也说成功。
 *
 * 不支持 `-T` 的 `mv`（busybox 那侧）退回「先摘软链再 mv」：那一刻不再原子
 * （current 会短暂不存在），但结论是对的 —— 结论错而过程看着漂亮，比不原子糟。
 * 只在目标是软链或不存在时才摘，绝不 `rm` 一个真实目录。
 *
 * @param from 源路径
 * @param to 目标路径。**存在就被覆盖**（`-f`）：发布流程里"覆盖上一个版本"
 * 是常态，为此失败只会让第二次部署莫名其妙地报错
 * @returns 一条 `sh -c` 脚本；`mv` 失败（跨设备、只读、目标是真实目录）退出码 5
 */
export function renameScript(from: string, to: string): string {
  const body = [
    `a=${q(from)}`,
    `b=${q(to)}`,
    'if mv -T -f -- "$a" "$b" 2>/dev/null; then exit 0; fi',
    'if [ -L "$b" ] || [ ! -d "$b" ]; then',
    '  rm -f -- "$b"',
    '  mv -f -- "$a" "$b" || exit 5',
    '  exit 0',
    'fi',
    'exit 5',
  ].join('\n')
  return script(OP_RENAME, { from, to }, body)
}

/**
 * 建软链。**`-f`**：目标已存在时替换掉，而不是报 "File exists" ——部署要能重复执行，而"这里已经有一个软链了"从来不是需要人来处理的故障。
 *
 * @param target 软链指向。**可以是相对路径**（相对软链本来就常用相对形式，
 * 换个挂载点也不会失效），所以它不进路径校验
 * @param linkPath 软链落点。**它要进路径校验** —— 那才是真正被创建的东西，
 * 而 target 只是软链里的一段字符串
 * @returns 一条 `sh -c` 脚本；落点已有实文件（非软链）等失败退出码 5
 */
export function symlinkScript(target: string, linkPath: string): string {
  return script(
    OP_SYMLINK,
    { target, linkPath },
    [`t=${q(target)}`, `l=${q(linkPath)}`, 'ln -s -f -- "$t" "$l" || exit 5'].join('\n'),
  )
}

/**
 * 读软链指向的目标路径（不是 `stat` 的跟随结果 —— 后者永远拿不到原值）。
 *
 * @param path 待读的路径。**先判 `-L`**：不是软链就退出一条专用的退出码 4，
 * 因为「它不是软链」与「它不存在」对调用方是两条不同的结论
 * @returns 一条 `sh -c` 脚本；不是软链退出码 4，不存在退出码 3，
 * `readlink` 本身失败（无权限等）退出码 5
 */
export function readlinkScript(path: string): string {
  return script(
    OP_READLINK,
    { path },
    [`p=${q(path)}`, '[ -L "$p" ] || exit 4', 'readlink "$p" || exit 5'].join('\n'),
  )
}

/**
 * 解析软链，得到真实绝对路径。
 *
 * @param path 要解析的路径
 * @returns 一条 `sh -c` 脚本，stdout 是绝对路径；父目录不存在时退出码 3。
 * 已存在的路径走 `pwd -P`（`-P` 会跟随软链，不带它拿到的是逻辑路径）
 */
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
