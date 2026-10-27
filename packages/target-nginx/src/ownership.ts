import { ERR, DpError, isManaged } from '@dp/ports'

export { isManaged, MANAGED_MARKER } from '@dp/ports'

/**
 * 覆盖判定的结论。三种取值都是**正常结果**、不是异常。
 */
export interface OverwriteDecision {
  readonly action: 'create' | 'replace' | 'abort'
  /** 为什么。三种取值都有 */
  readonly reason: string
  /** 替换前是否需要备份。force 也不例外 */
  readonly backup: boolean
}

/**
 * 判定的可调项。**默认不 force**。
 */
export interface OverwriteOptions {
  readonly force?: boolean
  /** 报错时定位到配置项 */
  readonly path?: string
}

/**
 * 判定能不能覆盖。纯函数，不抛错 —— 调用方要能把三种结果都当数据用。
 *
 * @param existing 目标机上现有 conf 的内容。**只有 `null` 算不存在**，空串算「存在且为空」
 * @param options force 与出错时的配置项路径；省略即按最保守的一档判定
 * @returns 动作、是否需要备份，以及一句能直接给用户看的理由
 */
export function decideOverwrite(existing: string | null, options?: OverwriteOptions): OverwriteDecision {
  if (existing === null) return { action: 'create', backup: false, reason: '目标文件不存在' }

  if (isManaged(existing)) return { action: 'replace', backup: true, reason: '带 managed 标记，属于 dp 管理的文件' }

  if (options?.force === true) return { action: 'replace', backup: true, reason: '不带标记，但显式 force；仍然先备份' }

  return {
    action: 'abort',
    backup: false,
    reason: existing.trim() === '' ? '目标文件存在且为空，不带 managed 标记' : '目标文件存在且不带 managed 标记，可能不是 dp 写的',
  }
}

const PRESERVE_HINT =
  '保住自己文件的办法有三：① 把自己的配置挪到别的文件名，本包只写 `filename` 指定的这一份；' +
  '② 在文件前几行加 `# managed by dp` 注释，表示你接受 dp 管理它；' +
  '③ 确知要覆盖就配 `force: true` —— 仍会先备份成 `<filename>.dp-backup`，不是直接抹掉'

/**
 * 判定并抛错。plan 期用：不能覆盖时必须在**还没碰目标机**的时候说清。
 *
 * @param existing 目标机上现有 conf 的内容；`null` 表示文件不存在
 * @param options force 与配置项路径，透传给判定并写进 `DpError`
 * @returns 判定为 create / replace 时的结论
 * @throws DpError `DP.NGX.NOT_MANAGED` —— 目标文件存在、不带 managed 标记、也没 force
 */
export function assertOverwritable(existing: string | null, options?: OverwriteOptions): OverwriteDecision {
  const decision = decideOverwrite(existing, options)
  if (decision.action !== 'abort') return decision
  throw new DpError(ERR.NGX.NOT_MANAGED, decision.reason, {
    ...(options?.path !== undefined ? { path: options.path } : {}),
    hint: PRESERVE_HINT,
  })
}
