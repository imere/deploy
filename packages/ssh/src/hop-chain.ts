/**
 * 跳板链的**计划** —— 纯函数，零 IO。
 *
 * 为什么要有这一层而不是在建立连接时顺手把参数算出来：多跳的错法几乎全是
 * 「连到了另一台机器」或「凭据用在了错误的跳上」，而这两种在连接建立之后
 * 表现为一次普通的认证失败，定位成本极高。把 host/port/user/auth 逐跳摊平
 * 并当场校验，就能让这类错误在碰网络之前变成一次明确报错。
 *
 * `via` 里的 `nc` **永远不会由这个函数产出**（见 openHopChain 的注释）：手段
 * 能不能用只有真跑一次才知道，计划阶段选它等于凭空猜。
 */
import { DpError, assertPortInRange, parseSshTarget } from '@dp/ports'
import type { AuthConfig, HopSpec } from './driver.js'

export type HopAuth = AuthConfig

export type HopVia = 'direct' | 'forwardOut' | 'nc'

export interface HopChainStep {
  /** 第几跳（0 起）。第 0 跳是本机直连的那一跳，最后一跳是目标机 */
  readonly index: number
  readonly ssh: string
  readonly host: string
  /** 未写端口时为 undefined：沿用 parseSshTarget 的约定，不替用户猜 22 */
  readonly port: number | undefined
  readonly user: string | undefined
  readonly auth: HopAuth
  readonly via: HopVia
}

export interface PlanHopChainOptions {
  /** 报错路径的前缀，默认 hosts.*.ssh */
  readonly path?: string
  /**
   * 是否允许运行期用 nc 兜底。
   *
   * 放进 opts 只是为了让调用方**声明**这件事，不改变计划内容：`via` 恒为
   * direct/forwardOut。让「允许兜底」这个意图在计划里可见，比藏在连接代码里
   * 的一个 if 更能让人读出「这条链不保证一定走 direct-tcpip」。
   */
  readonly allowNc?: boolean
}

const DEFAULT_PATH = 'hosts.*.ssh.hops'

export function planHopChain(
  hops: readonly HopSpec[],
  opts: PlanHopChainOptions = {},
): readonly HopChainStep[] {
  const base = opts.path ?? DEFAULT_PATH
  if (hops.length === 0) {
    throw new DpError('DP.CONFIG.INVALID', '跳板链为空（0 跳）', {
      path: base,
      hint: '单跳请写 hosts.*.ssh，多跳至少给 1 跳。返回空数组会让调用方以为"不需要跳板"，于是直连 —— 那正是跳板机被放在这里的原因',
    })
  }

  return hops.map((hop, index) => {
    const path = `${base}[${index}]`
    const target = parseSshTarget(hop.ssh, `${path}.ssh`)

    let port = target.port
    if (hop.port !== undefined) {
      assertPortInRange(hop.port, `${path}.port`)
      if (port !== undefined && port !== hop.port) {
        throw new DpError(
          'DP.CONFIG.INVALID',
          `第 ${index} 跳给了两个互相矛盾的端口：ssh 串里是 ${port}，port 字段是 ${hop.port}`,
          {
            path: `${path}.port`,
            hint: '留一个就行。静默取其中一个会连到另一台机器上，而那次连接往往还是成功的',
          },
        )
      }
      port = hop.port
    }

    if (hop.auth === undefined) {
      throw new DpError('DP.CONFIG.INVALID', `第 ${index} 跳没有给认证方式`, {
        path: `${path}.auth`,
        hint:
          '每一跳的凭据都可能与别的跳不同（跳板机一套、目标机一套是常态），所以逐跳必须显式声明 auth。' +
          '不给就报错而不是继承上一跳 —— 继承意味着把目标机的凭据发给了跳板机',
      })
    }

    return {
      index,
      ssh: hop.ssh,
      host: target.host,
      port,
      user: target.user,
      auth: hop.auth,
      via: index === 0 ? ('direct' as const) : ('forwardOut' as const),
    }
  })
}
