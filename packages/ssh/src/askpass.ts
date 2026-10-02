/**
 * SSH_ASKPASS 助手 —— 本机临时可执行文件，**只在密码认证时用**。
 *
 * 为什么需要它（spikes.md S3 实测）：本机没有 sshpass，也不允许用。而
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

export interface AskpassHelper {
  readonly path: string
  /** 注入给 ssh 子进程的环境变量。密码本体不在这里 */
  readonly env: Readonly<Record<string, string>>
  /** 幂等；调用后文件已删除 */
  dispose(): void
}

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

/** 助手文件名里的随机后缀来源，导出仅为测试断言存在性 */
export const askpassToken = (): string => randomBytes(6).toString('hex')
