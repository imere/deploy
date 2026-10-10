import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { DpError } from '@dp/ports'

/** cmd.exe 会解释的字符。含它们的密码**拒绝**，不给注入面留缝。 */
const CMD_UNSAFE = /[&|<>^%!"\r\n]/

/**
 * 落盘脚本的路径与 fd，用完由调用方删除
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
 */
export interface AskpassOptions {
  /** 临时目录。远端场景由调用方给 Facts.tmpdir；本地测试用 os.tmpdir() */
  readonly dir?: string
}

function shQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * 造一个助手脚本。
 *
 * @param secret 要打印的内容。密码或密钥 passphrase —— 都不是 shell 语法，
 * 所以按 POSIX 单引号整体包住即可。
 * @param options 落盘位置。不给就用 `os.tmpdir()`
 * @returns 助手句柄。**调用方必须调 `dispose()`** —— 密码就在 `path` 指向的文件里，
 * 不删掉的话它会一直留在磁盘上等一次重启
 * @throws DpError 空 secret（`DP.CONFIG.INVALID`，与"密码错了"分开，
 * 前者改配置、后者查凭据），或 Windows 上密码含 cmd 会解释的字符
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
 * @returns 12 个十六进制字符（6 字节随机数），**不含**任何机器相关或时间相关成分
 */
export const askpassToken = (): string => randomBytes(6).toString('hex')
