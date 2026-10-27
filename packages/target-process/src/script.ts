import { ERR, DpError, MANAGED_MARKER } from '@dp/ports'

export { MANAGED_MARKER }

/** 启动脚本的文件名。落在 `<release 目录>/.dp/` 之下 */
export const START_SCRIPT_NAME = 'start.sh'
/** 停止脚本的文件名。与启动脚本同目录 */
export const STOP_SCRIPT_NAME = 'stop.sh'

/** 脚本里不许出现的字符。脚本是逐行解释的，控制字符能让一行变成多行 */
// eslint-disable-next-line no-control-regex -- 这条规则防的是「正则里混进控制字符」，而这里要找的就是控制字符本身
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** 脚本文件的权限位。它会被直接 `sh` 执行，所以要带执行位 */
export const SCRIPT_MODE = 0o755

/** 优雅期的最小整秒数。0 会让 kill -0 的轮询一次都不跑 */
const MIN_GRACE_SECONDS = 1

/** 环境变量名的合法形状。它不是 POSIX 的强制要求，但 shell 里写不出别的形状 */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 「进程还活着吗」的判定体。**僵尸算死**。
 *
 * 只用 `kill -0` 是不够的：僵尸进程**已经退出**，只是父进程还没给它收尸，而
 * `kill -0` 对它照样返回成功。服务进程是被 `setsid` 摘出去的孤儿，父进程退出后
 * 由 1 号进程收养 —— 1 号进程不是 init（容器里常是 `sleep`）时没人收尸，于是
 * 一次**已经成功**的停止会被判成「优雅期与强杀之后仍然存活」，真因被这句报错盖住。
 *
 * 判定顺序：`kill -0` 先过一遍（不存在 / 无权限直接算死），有 procfs 再读状态位。
 * 没有 procfs 的非 Linux 目标机上退回 `kill -0` 的结论 —— 那一侧没有状态位可查，
 * 硬判僵尸反而会把活着的进程当成死的。
 *
 * `$1` 是 pid。函数体，所以结束时是 `return`，不是 `exit`。
 */
const ALIVE_BODY: readonly string[] = [
  'kill -0 "$1" 2>/dev/null || return 1',
  'if [ -r "/proc/$1/stat" ]; then',
  // 括号里的 comm 能含空格与 ')'，所以用「最长前缀」切到最后一个 ') ' 之后。
  // 先赋空串：read 读到空文件时不赋值，而这段体是能跑在 `set -u` 下的
  '  DP_LINE=""',
  '  read -r DP_LINE < "/proc/$1/stat" 2>/dev/null || :',
  '  DP_AFTER=${DP_LINE##*") "}',
  '  DP_ST=${DP_AFTER%% *}',
  '  [ "$DP_ST" = Z ] && return 1',
  'fi',
  'return 0',
]

/**
 * 存活判定的完整 `sh -c` 脚本体。结尾是 `dp_alive "$1"` 的退出码。
 *
 * 单独导出是因为存活断言不止一处：停止脚本里要能在循环里反复调（那是函数体），
 * `aliveArgv` 要的是「跑一次、退出码即结论」。
 */
export const ALIVE_SCRIPT = ['dp_alive() {', ...ALIVE_BODY.map((line) => `  ${line}`), '}', 'dp_alive "$1"'].join('\n')

/**
 * 按 POSIX 单引号规则加引号：串内每个 `'` 换成 `'\''`。
 *
 * 用它而不是双引号，是因为双引号里 `$`、`` ` ``、`\` 仍会被解释 —— 而配置里的路径、
 * 环境变量完全可能带这些字符。单引号是唯一「除了单引号本身什么都不解释」的写法。
 *
 * @param value 待引用的原文
 * @returns 可直接拼进 shell 脚本的带引号字面量
 */
export function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`
}

/** 取目录部分；不含分隔符时返回空（调用方据此跳过 mkdir） */
function dirOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at <= 0 ? '' : path.slice(0, at)
}

/**
 * 启动脚本的输入。**每一项都会烘进脚本文本**，不存在运行期再读的可能。
 *
 * `command` / `args` 必须已是绝对路径或可被 PATH 解析的固定值 —— 脚本会在
 * 一个干净的 `setsid` 会话里跑，不继承部署命令当时的 cwd 与 shell 状态。
 */
export interface StartScriptInput {
  readonly command: string
  readonly args: readonly string[]
  readonly workingDirectory: string
  readonly pidFile: string
  readonly stdoutLog: string
  readonly env: Readonly<Record<string, string>>
}

/**
 * 渲染启动脚本。**所有值都在渲染期烘进脚本**，运行期一个位置参数都不接。
 *
 * 为什么不在运行期用位置参数传命令：回滚要跑的是**上一版实际部署出去的那份脚本**，
 * 而运行期手上只有当前配置 —— 把 command 当参数传进去，回滚就变成了「用当前配置
 * 的命令在上一版目录里跑一次」，那不是回滚。烘进脚本之后，回滚只需要
 * `sh <上一版目录>/.dp/start.sh`，语义与「回到那个版本」一致。
 *
 * 脚本**立即返回**，服务进程在后台新建一个会话跑：
 * `runner.exec()` 会等子进程结束，所以这里绝不能 `exec` 成服务进程 —— 那会让一次
 * 部署卡到超时。取而代之的是起一个后台子 shell，它先把自己的 pid 写进 pidfile，
 * 再 `exec` 成服务进程（exec 不换 pid，所以 pidfile 里记的就是服务进程）。
 *
 * `setsid` 的作用是把服务进程放进**新会话**：ssh exec 通道关闭时，sshd 清理的是原来
 * 那个会话，新会话不受影响。没有 `setsid` 时退回到普通后台进程 —— 它能跑，但存活与否
 * 取决于目标机会话清理的力度，这一点不在这里假装它和 systemd 一样可靠。
 *
 * @param input 启动命令、参数与落点
 * @returns 启动脚本全文
 * @throws DpError `DP.PROC.COMMAND_INVALID` —— 命令、参数或环境变量含控制字符，或变量名不合法
 */
export function renderStartScript(input: StartScriptInput): string {
  const parts = [input.command, ...input.args].map((item): string => {
    if (CONTROL_CHARS.test(item)) {
      throw new DpError(ERR.PROC.COMMAND_INVALID, `启动命令含控制字符：${JSON.stringify(item).slice(0, 80)}`, {
        path: 'projects.*.target.process.command',
        hint: '脚本是逐行解释的，值里的换行会变成额外命令。去掉控制字符，或把它改成一个不带控制字符的包装脚本',
      })
    }
    return shellQuote(item)
  })

  const envLines = Object.entries(input.env)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]): string => {
      if (!ENV_KEY.test(key)) {
        throw new DpError(ERR.PROC.COMMAND_INVALID, `环境变量名不合法：${JSON.stringify(key).slice(0, 80)}`, {
          path: 'projects.*.target.process.env',
          hint: '只接受 `[A-Za-z_][A-Za-z0-9_]*` 这种名字：脚本里只能写成 `export KEY=值`，别的形状写不出来',
        })
      }
      if (CONTROL_CHARS.test(value)) {
        throw new DpError(ERR.PROC.COMMAND_INVALID, `环境变量 ${key} 的值含控制字符`, {
          path: `projects.*.target.process.env.${key}`,
          hint: '值会被拼进 `export` 那一行，换行能让它后面多出一条命令',
        })
      }
      return `export ${key}=${shellQuote(value)}`
    })

  const dirs = [dirOf(input.pidFile), dirOf(input.stdoutLog)].filter((d) => d !== '')
  const lines: readonly string[] = [
    '#!/bin/sh',
    MANAGED_MARKER,
    'set -u',
    // pidfile 与日志的父目录未必存在（发布根下的 .dp 是第一次部署才建的），
    // 少了这一步，重定向会失败，而失败现场是「进程没起来、日志里什么都没有」
    ...(dirs.length > 0 ? [`mkdir -p ${dirs.map(shellQuote).join(' ')}`] : []),
    `cd ${shellQuote(input.workingDirectory)} || exit 1`,
    ...envLines,
    `exec >>${shellQuote(input.stdoutLog)} 2>&1`,
    // 优先 setsid（脱离会话），没有就退回普通后台；两种都把 pid 写进 pidfile
    'if command -v setsid >/dev/null 2>&1; then',
    '  exec 0</dev/null',
    `  setsid sh -c ${shellQuote('echo $$ >"$1"; shift; exec "$@"')} sh ${shellQuote(input.pidFile)} ${parts.join(' ')} &`,
    'else',
    '  exec 0</dev/null',
    `  sh -c ${shellQuote('echo $$ >"$1"; shift; exec "$@"')} sh ${shellQuote(input.pidFile)} ${parts.join(' ')} &`,
    'fi',
    'exit 0',
    '',
  ]
  return lines.join('\n')
}

/**
 * 停止脚本的输入。信号与优雅期同样烘进脚本：回滚时执行的是**上一版的那份停止脚本**，
 * 而不是用当前配置的信号去停上一版的进程。
 */
export interface StopScriptInput {
  readonly pidFile: string
  /**
   * 停止信号名（如 `SIGTERM`）。
   *
   * @see PROCESS_STOP_SIGNALS 只收「给进程收尾机会」的那几个，`SIGKILL` 不在其中 ——
   * 它是强杀段的固定行为，不该能被写成第一选择
   */
  readonly stopSignal: string
  /** 轮询的上限。它是**最多等多久**，不是「一定会等到它退出」 */
  readonly stopTimeoutMs: number
}

/**
 * 优雅期换算成整秒。向上取整并保底 1 秒 ——
 * 传 0 进来会让轮询体一次都不执行，那时「等它退出」这句话就是假的。
 *
 * @param stopTimeoutMs 优雅期，毫秒
 * @returns 轮询次数上限
 */
export function graceSecondsOf(stopTimeoutMs: number): number {
  return Math.max(MIN_GRACE_SECONDS, Math.ceil(stopTimeoutMs / 1000))
}

/**
 * 渲染停止脚本：发信号 → 轮询等它退出 → 超时强杀 → 仍活着就报错。
 *
 * 与启动脚本一样是**渲染期烘值**：回滚时跑的是上一版目录里那份停止脚本，
 * 它带的也是上一版部署时算出来的信号与优雅期。
 *
 * 强杀之后**再查一次**是这段脚本存在的理由：只发 `KILL` 就当成功，是这类脚本最常见
 * 的假成功（进程处于不可中断状态、或 pid 已被复用时，KILL 未必真的收走了它）。
 *
 * @param input pidfile 位置、信号与优雅期
 * @returns 停止脚本全文
 * @throws DpError `DP.PROC.COMMAND_INVALID` —— 信号名含控制字符
 */
export function renderStopScript(input: StopScriptInput): string {
  if (CONTROL_CHARS.test(input.stopSignal)) {
    throw new DpError(ERR.PROC.COMMAND_INVALID, `停止信号含控制字符：${JSON.stringify(input.stopSignal).slice(0, 80)}`, {
      path: 'projects.*.target.process.stopSignal',
      hint: '只接受形如 SIGTERM 的信号名',
    })
  }
  const grace = graceSecondsOf(input.stopTimeoutMs)
  return [
    '#!/bin/sh',
    MANAGED_MARKER,
    'set -u',
    `DP_PIDFILE=${shellQuote(input.pidFile)}`,
    `DP_SIGNAL=${shellQuote(input.stopSignal)}`,
    `DP_GRACE="${grace}"`,
    // 存活判定走函数而不是裸 `kill -0`：僵尸（已退出、只是没人收尸）必须算死，
    // 否则「停掉了」会被报成「杀不掉」
    'dp_alive() {',
    ...ALIVE_BODY.map((line) => `  ${line}`),
    '}',
    'if [ ! -f "$DP_PIDFILE" ]; then exit 0; fi',
    'DP_PID=$(cat "$DP_PIDFILE" 2>/dev/null) || DP_PID=""',
    'case "$DP_PID" in ""|*[!0-9]*) rm -f "$DP_PIDFILE"; exit 0;; esac',
    'kill -s "$DP_SIGNAL" "$DP_PID" 2>/dev/null || true',
    'DP_I=0',
    'while dp_alive "$DP_PID"; do',
    '  DP_I=$((DP_I + 1))',
    '  if [ "$DP_I" -ge "$DP_GRACE" ]; then break; fi',
    '  sleep 1',
    'done',
    // 优雅期过了还活着 → 强杀，然后再确认一次
    'if dp_alive "$DP_PID"; then',
    '  kill -KILL "$DP_PID" 2>/dev/null || true',
    '  sleep 1',
    'fi',
    'if dp_alive "$DP_PID"; then',
    '  echo "dp: 进程 $DP_PID 在优雅期与强杀之后仍然存活" >&2',
    '  exit 1',
    'fi',
    'rm -f "$DP_PIDFILE"',
    'exit 0',
    '',
  ].join('\n')
}
