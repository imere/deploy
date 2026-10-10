import { createRequire } from 'node:module'
import { DpError } from '@dp/ports'
import type { AuthConfig } from './driver.js'

// 最小接口声明（不是 ssh2 的完整类型，是我们用到的部分）

/**
 * 一条 exec/sftp/forwardOut 通道。**只声明我们用到的那几个成员**：ssh2 的真实类型是巨大的 EventEmitter 面，照抄一份只会让升级 ssh2 变成改类型文件；而这里需要的恰恰是「缺什么就报什么」，所以窄接口比完整类型更诚实。
 */
export interface Ssh2ChannelLike {
  on(event: string, handler: (...args: readonly unknown[]) => void): unknown
  stderr?: { on(event: string, handler: (...args: readonly unknown[]) => void): unknown }
  close?(): void
}

/** sftp 子系统会话。同样是窄声明：只需要"事件到数据"这一件事 */
export interface Ssh2SftpLike {
  on(event: string, handler: (...args: readonly unknown[]) => void): unknown
}

/**
 * 客户端。三个方法都是**回调式**而不是 Promise —— 直接沿用 ssh2 的形状，包一层 Promise 会让"回调抛异常"变成一个静默的未捕获异常，而那正是我们在 try/catch 里想看见的东西。
 */
export interface Ssh2ClientLike {
  on(event: string, handler: (...args: readonly unknown[]) => void): unknown
  connect(config: Readonly<Record<string, unknown>>): void
  exec(
    command: string,
    options: Readonly<Record<string, unknown>>,
    callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void,
  ): void
  sftp(callback: (err: Error | undefined, sftp: Ssh2SftpLike) => void): void
  forwardOut(
    srcHost: string,
    srcPort: number,
    dstHost: string,
    dstPort: number,
    callback: (err: Error | undefined, channel: Ssh2ChannelLike) => void,
  ): void
  end(): void
}

/**
 * 加载到的 ssh2 模块 —— **只保留我们核对过的部分**。
 */
export interface Ssh2ModuleLike {
  Client: new () => Ssh2ClientLike
}

/**
 * 加载结果。用**判别联合**而不是抛异常：模块没装是一个正常的、要进偏好链失败列表的状态，异常会让上层必须用 try/catch 去问一个布尔值。
 */
export type Ssh2Load =
  | { readonly ok: true; readonly mod: Ssh2ModuleLike }
  | { readonly ok: false; readonly reason: string; readonly hint: string }

let cached: Ssh2Load | undefined

/**
 * ssh2 未安装时返回空，由调用方降级到系统 ssh
 *
 * @param force 跳过缓存重新 require。**只有测试用** ——
 * 生产的加载是一次性的，反复 require 拿到的永远是同一份模块，
 * 而"每次都重新读文件"在 Windows 上还慢得离谱
 * @returns 加载结果，**永不为 null、永不抛错**。失败分支的 `reason` 说明发生了什么，
 * `hint` 给出能真正解决它的下一步（装包 / 换驱动）
 */
export function loadSsh2(force = false): Ssh2Load {
  if (cached !== undefined && !force) return cached
  try {
    const require = createRequire(import.meta.url)
    const mod: unknown = require('ssh2')
    cached = narrowModule(mod)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    const reason =
      code === 'MODULE_NOT_FOUND' ? 'ssh2 未安装' : `加载 ssh2 失败：${(err as Error).message}`
    cached = {
      ok: false,
      reason,
      hint: '它是可选运行时依赖：`pnpm add -D ssh2`。但注意 ssh2 **不支持任何抗量子 KEX**（实测），若 crypto.kexPolicy=pq-required 只能走 native-ssh',
    }
  }
  return cached
}

/** 把 `unknown` 收窄成我们需要的最小形状；形状不对也算"不可用"而不是崩 */
function narrowModule(mod: unknown): Ssh2Load {
  if (typeof mod !== 'object' || mod === null) {
    return { ok: false, reason: 'ssh2 模块形状异常（不是对象）', hint: '检查 ssh2 是否被别的同名包顶替了' }
  }
  const client = (mod as { Client?: unknown }).Client
  if (typeof client !== 'function') {
    return {
      ok: false,
      reason: 'ssh2 模块缺少 Client 构造器（不是预期的 ssh2 包）',
      hint: '检查 ssh2 是否被别的同名包顶替了',
    }
  }
  const proto = client.prototype as Partial<Ssh2ClientLike> | undefined
  for (const method of ['connect', 'exec', 'end'] as const) {
    if (typeof proto?.[method] !== 'function') {
      return { ok: false, reason: `ssh2.Client 缺少 ${method}()`, hint: '版本与预期不符，换一个 ssh2 版本' }
    }
  }
  return { ok: true, mod: { Client: client as new () => Ssh2ClientLike } }
}

/**
 * ssh2 的错误文案 → 结构化。**绝不带上 password 字段的值**判据与 native 那条路径（`parse.ts` 的 classifySshError）分开写是刻意的：两个库的文案体系完全不同，硬凑成一个正则表只会让两边都判不准。
 *
 * @param message ssh2 抛出的原始错误消息。会被截到 200–300 字符再进 message：
 * 它可能夹带连接参数，拼全了既难读又有泄漏风险
 * @param auth 配置里的认证方式。**只读它的 `type`，不碰明文** ——
 * 它用来选建议（比如私钥权限太开 vs agent 里没有身份），两种都值得说
 * @returns 一个 `DpError`。认不出文案时落`DP.SSH.CONNECT_FAILED`（笼统）——
 * 误判成认证失败会把用户引到完全错误的方向
 */
export function classifyConnectError(message: string, auth: AuthConfig): DpError {
  const kind = auth.type
  if (/All configured authentication methods failed/i.test(message)) {
    return new DpError('DP.SSH.AUTH_FAILED', `认证失败（配置了 ${kind}）`, {
      hint: authHint(kind),
    })
  }
  if (/Handshake failed|no matching (key exchange|cipher|mac|host key)/i.test(message)) {
    return new DpError('DP.SSH.CONNECT_FAILED', `握手失败：${message.slice(0, 200)}`, {
      hint: '确认目标 sshd 支持的算法；若目标是老设备，crypto 侧可能要放宽（ssh2 不支持任何 PQ KEX）',
    })
  }
  return new DpError('DP.SSH.CONNECT_FAILED', message.slice(0, 300), {
    hint: '检查主机/端口可达性、sshd 是否在跑、网络策略',
  })
}

function authHint(kind: AuthConfig['type']): string {
  switch (kind) {
    case 'key':
      return '私钥权限太开会被 ssh 拒绝：chmod 600 ~/.ssh/id_ed25519；或确认公钥已进目标机的 authorized_keys'
    case 'agent':
      return 'agent 里没有可用身份：先 ssh-add <key>，用 ssh-add -l 确认'
    case 'password':
      return '确认密码正确；确认目标 sshd 允许密码认证（PasswordAuthentication）。注意：连续失败可能触发账户锁定，不要反复重试'
    case 'keyboard-interactive':
      return '很多设备表面是密码、实际只接受键盘交互。确认目标端的 PAM 栈与密码一致'
  }
}
