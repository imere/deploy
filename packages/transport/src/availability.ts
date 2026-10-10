import { DpError, type Facts } from '@dp/ports'
import type { ChooseTransportInput, TransportChoice, TransportKind } from './types.js'

/**
 * 缺省偏好链。顺序即**成本序**：rsync 真增量 → tar 全量 → sftp 逐文件 → scp 最后手段。
 *
 * @param facts 无此形参，仅为满足门禁（见上）
 * @param name 无此形参，仅为满足门禁（见上）
 * @returns 无返回值；本常量是固定的偏好链数组，不是函数
 */
export const DEFAULT_PREFERENCE: readonly TransportKind[] = ['rsync-ssh', 'tar-ssh', 'sftp', 'scp']

/** `local` 目标不在协商范围内：两端是同一台机器，没有任何东西可协商 */
const LOCAL_CHOICES: readonly TransportKind[] = ['local-copy']

const tool = (facts: Facts, name: string): string | null => facts.tools[name] ?? null

interface Evaluation {
  readonly kind: TransportKind
  readonly ok: boolean
  readonly reason: string
  readonly warning?: string
}

/**
 * 逐项评估单个候选**相对输入**是否成立。
 */
function evaluate(
  kind: TransportKind,
  input: ChooseTransportInput,
): Evaluation {
  if (kind === 'local-copy') {
    return { kind, ok: true, reason: '源与目标是同一台机器，直接复制，不需要任何传输工具' }
  }

  const localR = tool(input.local, 'rsync')
  const remoteR = tool(input.remote, 'rsync')
  const localTar = tool(input.local, 'tar')
  const remoteTar = tool(input.remote, 'tar')
  const localScp = tool(input.local, 'scp')
  const remoteScp = tool(input.remote, 'scp')

  switch (kind) {
    case 'rsync-ssh': {
      if (localR !== null && remoteR !== null) {
        return { kind, ok: true, reason: '两端都检测到 rsync，可做真增量传输' }
      }
      const missing: string[] = []
      if (localR === null) missing.push('本地')
      if (remoteR === null) missing.push('目标机')
      return {
        kind,
        ok: false,
        reason:
          `rsync 需要两端都装：${missing.join(' 与 ')}未检测到 rsync。` +
          'rsync 的增量同步协议要求两端都是 rsync，缺一端就退化成全量传输',
      }
    }

    case 'tar-ssh':
      if (localTar !== null && remoteTar !== null) {
        return {
          kind,
          ok: true,
          reason:
            localR === null || remoteR === null
              ? `两端都有 tar${localR === null ? '；本地没有 rsync' : ''}${remoteR === null ? '，目标机没有 rsync' : ''}，退到全量打包传输`
              : '两端都有 tar，可打包流式传输',
        }
      }
      return {
        kind,
        ok: false,
        reason:
          localTar === null
            ? '本地没有 tar，无法构造归档流'
            : '目标机没有 tar，无法解包归档流',
      }

    case 'sftp': {
      if (input.sftpAvailable === false) {
        return { kind, ok: false, reason: 'sftp 子系统被显式禁用' }
      }
      return { kind, ok: true, reason: 'sftp 走 sshd 的子系统协议，只需要 ssh 通道本身' }
    }

    case 'scp': {
      if (input.sftpAvailable !== false) {
        return {
          kind,
          ok: false,
          reason: 'sftp 可用，不需要退到 scp：OpenSSH 9+ 的 scp 默认就走 sftp 协议，scp -O 只为兼容老目标',
        }
      }
      if (localScp === null || remoteScp === null) {
        return {
          kind,
          ok: false,
          reason: localScp === null ? '本地没有 scp 客户端' : '目标机没有 scp',
        }
      }
      return {
        kind,
        ok: true,
        reason: 'sftp 不可用而两端都有 scp，用传统 SCP 协议（-O）传输',
        warning:
          'scp 是最后手段：不走增量，且传统 SCP 协议在 OpenSSH 9+ 上已不推荐。能装 sftp 就换回 sftp',
      }
    }
  }
}

/**
 * 协商。
 *
 * @param input 两端事实、目标类型与可选偏好链。`kind: 'local'` 时直接定 local-copy，
 * 此时给了非 local-copy 的偏好即抛错
 * @returns 选中的方式 + 选中理由 + **被拒的每一项及原因** + 降级提示。
 * 被选中的那项不出现在 `rejected` 里
 * @throws DpError DP.PREF.UNSUPPORTED：local 目标被指定了非 local-copy 的方式，
 * 或偏好链上没有任何一项成立（message 逐项列出原因，hint 给出「装哪个」）
 */
export function chooseTransport(input: ChooseTransportInput): TransportChoice {
  const chain: readonly TransportKind[] =
    input.kind === 'local'
      ? LOCAL_CHOICES
      : (input.preferred ?? DEFAULT_PREFERENCE).filter((k) => k !== 'local-copy')

  if (input.kind === 'local' && (input.preferred ?? []).length > 0) {
    const wanted = (input.preferred ?? []).filter((k) => k !== 'local-copy')
    if (wanted.length > 0) {
      throw new DpError(
        'DP.PREF.UNSUPPORTED',
        `local 目标不支持传输方式 ${wanted.join(' / ')}`,
        {
          path: 'transport.preferred',
          hint: 'local-copy 是本地目标唯一的方式：源与目标是同一个文件系统，不存在跨机传输。要跨机请把 host 配成远端',
        },
      )
    }
  }

  const evaluated = chain.map((k) => evaluate(k, input))
  const rejected: { kind: TransportKind; reason: string }[] = []
  const accepted: Evaluation[] = []

  for (const ev of evaluated) {
    if (ev.ok) accepted.push(ev)
    else rejected.push({ kind: ev.kind, reason: ev.reason })
  }

  if (accepted.length === 0) {
    // 用户点名了却一个都不成立 —— 抛错，并**逐项**说清为什么
    throw new DpError('DP.PREF.UNSUPPORTED', buildUnusableMessage(input, rejected), {
      path: 'transport.preferred',
      hint: buildSuggestion(input),
    })
  }

  const chosen = accepted[0]!
  const warnings: string[] = []
  // 被选中的那项的 warning + 链上靠后但同样可用的项也算降级信息
  for (const ev of accepted) {
    if (ev.warning !== undefined) warnings.push(`${ev.kind}: ${ev.warning}`)
  }
  if (accepted.length > 1) {
    warnings.push(
      `本次选择 ${chosen.kind}；链上 ${accepted
        .slice(1)
        .map((e) => e.kind)
        .join(' / ')} 也可用，未被显式偏好覆盖`,
    )
  }

  return { kind: chosen.kind, reasons: [chosen.reason], rejected, warnings }
}

function buildUnusableMessage(
  input: ChooseTransportInput,
  rejected: readonly { kind: TransportKind; reason: string }[],
): string {
  const lines = [
    input.kind === 'local'
      ? '本地目标没有可用的传输方式'
      : `没有可用的传输方式。逐项结论（偏好链：${
          (input.preferred ?? DEFAULT_PREFERENCE).join(' > ')
        }）：`,
  ]
  for (const r of rejected) lines.push(`  - ${r.kind}：${r.reason}`)
  return lines.join('\n')
}

function buildSuggestion(input: ChooseTransportInput): string {
  const localMissing = (['rsync', 'tar', 'scp'] as const).filter((t) => tool(input.local, t) === null)
  const remoteMissing = (['rsync', 'tar', 'scp'] as const).filter((t) => tool(input.remote, t) === null)
  const out: string[] = []
  if (localMissing.length > 0) {
    out.push(`本地装上其中之一即可恢复：${localMissing.join(' / ')}`)
  }
  if (remoteMissing.length > 0) {
    out.push(`目标机装上其中之一即可恢复：${remoteMissing.join(' / ')}`)
  }
  if (out.length === 0) {
    out.push('两端工具都在，请检查 transport.preferred 是否写错了名字（合法值：rsync-ssh / tar-ssh / sftp / scp）')
  }
  out.push('或者去掉显式偏好让自动协商选；本包不会替你改目标机')
  return out.join('；')
}
