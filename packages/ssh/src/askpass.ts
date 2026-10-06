/**
 * SSH_ASKPASS 助手 —— 本机临时可执行文件，**只在密码认证时用**。
 *
 * 为什么需要它（实测）：本机没有 sshpass，也不允许用。而
 * OpenSSH 只肯从 TTY 或 askpass 助手读密码 —— `SSH_ASKPASS=<helper>
 * SSH_ASKPASS_REQUIRE=force DISPLAY=:0 ssh ... < /dev/null` 是实测可行的那条路。
 *
 * 安全取舍，必须说清楚：**密码会短暂落在一个本地临时文件里**。这是 askpass
 * 协议本身的形状，不是我们的疏忽。缓解措施：
 *  - 目录 0700、文件 0700（POSIX）
 *  - 目录由调用方给（远端场景用 Facts.tmpdir），文件名随机
 *  - **用完立刻删**，且在 `dispose()` 里幂等
 *  - 密码**绝不**进 argv、绝不进环境变量（`ps` 与 `/proc/<pid>/environ` 都能看到）
 *  - Windows 上 `.cmd` 无法表达含 `&|<>^%!` 的密码 —— 那种情况我们**拒绝**，
 *    而不是拼一个能被 cmd 二次解释的脚本
 *
 * 更好的做法本来是密钥/agent 免密；这里只是让密码场景不挂在 CI 上。
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { DpError } from '@dp/ports'

/** cmd.exe 会解释的字符。含它们的密码**拒绝**，不给注入面留缝。 */
const CMD_UNSAFE = /[&|<>^%!"\r\n]/

/**
 * 一个已落盘的 askpass 助手。
 *
 * 为什么 `path` 与 `env` 分开给：`env` 里**只有** OpenSSH 要的那三个变量，
 * 密码本体不在这里 —— 进了子进程环境的值会出现在 `/proc/<pid>/environ`，
 * 任何有该进程读权限的都能看到，而 argv 至少还能定位到是哪一次部署。
 * 这个对象是一次性的：`dispose()` 之后 `path` 指向的东西必须已经不存在，
 * 留着它当长期句柄用，就等于把明文凭据的存活期从「一次 exec」拉长到「进程生命周期」。
 */
export interface AskpassHelper {
  /** 助手脚本的绝对路径。POSIX 是 .sh，Windows 是 .cmd —— 后者的表达能力更差，见文件头 */
  readonly path: string
  /** 注入给 ssh 子进程的环境变量。密码本体不在这里 */
  readonly env: Readonly<Record<string, string>>
  /** 幂等；调用后文件已删除 */
  dispose(): void
}

/**
 * 助手的落盘位置。
 *
 * 为什么可选：askpass 文件**永远落在本机**（ssh 子进程也在本机跑），
 * 所以它跟目标机的 tmpdir 没有关系，只是调用方常常已经知道一个合适的本机目录。
 * 不给就退到 `os.tmpdir()`，而不是像其他临时物那样要求必须显式给 ——
 * 这里放错的后果是本机上多一个 0700 目录，不会碰到任何生产路径。
 */
export interface AskpassOptions {
  /** 临时目录。远端场景由调用方给 Facts.tmpdir；本机测试用 os.tmpdir() */
  readonly dir?: string
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * 造一个助手脚本。
 *
 * @param secret 要打印的内容。密码或密钥 passphrase —— 都不是 shell 语法，
 *               所以按 POSIX 单引号整体包住即可。
 * @param options 落盘位置。不给就用 `os.tmpdir()`
 * @returns 助手句柄。**调用方必须调 `dispose()`** —— 密码就在 `path` 指向的文件里，
 *   不删掉的话它会一直留在磁盘上等一次重启
 * @throws DpError 空 secret（`DP.CONFIG.INVALID`，与"密码错了"分开，
 *   前者改配置、后者查凭据），或 Windows 上密码含 cmd 会解释的字符
 */
export function createAskpassHelper(secret: string, options: AskpassOptions = {}): AskpassHelper {
  if (secret === '') {
    throw new DpError('DP.CONFIG.INVALID', 'askpass 收到空 secret', {
      hint: '空密码必然认证失败。与其花一次往返，不如直接报配置问题',
    })
  }

  const isWindows = process.platform === 'win32'
  if (isWindows && CMD_UNSAFE.test(secret)) {
    throw new DpError('DP.SSH.AUTH_FAILED', '该密码含 cmd.exe 会解释的字符，无法生成安全的 askpass 助手', {
      hint: 'Windows 上 askpass 只能走 .cmd，含 &|<>^%!" 的密码无法安全表达。改用密钥认证（auth.type=key）或 agent；或用 doas/sudo NOPASSWD 走提权而非密码',
    })
  }

  const dir = mkdtempSync(join(options.dir ?? tmpdir(), 'dp-askpass-'))
  // mkdtemp 已是 0700，这里再 chmod 一次是因为某些平台的 umask 可能干扰
  try {
    chmodSync(dir, 0o700)
  } catch {
    /* Windows 上没有 POSIX 权限位，忽略 */
  }

  const file = isWindows ? join(dir, 'askpass.cmd') : join(dir, 'askpass.sh')
  const body = isWindows
    ? '@echo off\r\n' + `echo ${secret}\r\n`
    : `#!/bin/sh\n# 由 deploy-kit 生成：打印一次凭据给 OpenSSH 的 askpass 协议。用完即删。\nprintf '%s\\n' ${shQuote(secret)}\n`

  writeFileSync(file, body, isWindows ? undefined : { mode: 0o700 })
  if (!isWindows) {
    try {
      chmodSync(file, 0o700)
    } catch {
      /* 已在 writeFileSync 里给过 mode */
    }
  }

  let disposed = false
  return {
    path: file,
    env: {
      // DISPLAY 在 Linux 上必须非空，否则 OpenSSH 判定"没有 X 就用不了 askpass"
      SSH_ASKPASS: file,
      SSH_ASKPASS_REQUIRE: 'force',
      DISPLAY: ':0',
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      // force=true：dir 与文件都是我们自己刚建的
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/**
 * 随机后缀的来源，导出**仅为测试**能断言临时目录名不撞车。
 *
 * 为什么它不进生产路径：目录名已经是 `mkdtemp` 生成的 —— 随机且原子创建，
 * 那里已经用满了所需的不确定性。再拼一个后缀既不加熵，又多一个将来会有人
 * 依赖的导出面，而那个导出并不提供任何它名字暗示的能力。
 *
 * @returns 12 个十六进制字符（6 字节随机数），**不含**任何机器相关或时间相关成分
 */
export const askpassToken = (): string => randomBytes(6).toString('hex')
