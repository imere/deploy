/**
 * 所有权保护 —— 只覆盖带标记的文件。
 *
 * 存在的理由是：同名 conf 可能是**用户自己写的**，
 * 部署工具凭自己的需要把它覆盖掉，等于替用户删掉他没打算删的配置。
 * 所以判定必须落在纯函数上 —— 「这个文件是不是我们的」应该在 plan 期能算出来，
 * 而不是等远端 `cat` 完再决定要不要报错。
 */
import { DpError } from '@dp/ports'

/** 标记本体。渲染时写进 conf 头部，判定时在文件里找它 */
export const MANAGED_MARKER = '# managed by dp'

/** 去掉 `#` 的正文，与 MANIFEST 标记逐字对应；避免两处各写一份字面量后漂移 */
const MARKER_TEXT = MANAGED_MARKER.slice(1).trim()

/**
 * 只看前几行。
 *
 * 不是「只看首行」：用户往往会在 dp 生成的标记上面再加自己的注释。
 * 也不是全文搜：conf 正文是 nginx 的有效配置，让正文里出现标记字样
 * （比如某条 `add_header` 的内容）就把这份文件认领成 dp 的，等于开了误判通路。
 */
const SCAN_LINES = 5

/** 标记必须落在**注释行**里，否则它就是 nginx 的有效语法内容，不能作为归属凭证 */
function isMarkerComment(line: string): boolean {
  return line.trimStart().startsWith('#') && line.includes(MARKER_TEXT)
}

/**
 * 内容里是否带标记。空文件返回 false —— 它不可能是 dp 写的。
 *
 * @param content 目标机上那份 conf 的完整内容。读不到就让它抛错，**不要**拿空串顶替
 *   ——「读不了」被当成「不存在」，后面就直接是一次覆盖
 * @returns true 只说明「头部注释自称由 dp 管理」，不说明内容真是 dp 写的；
 *   所以即便为 true，覆盖前仍要备份
 */
export function isManaged(content: string): boolean {
  return content.split(/\r?\n/).slice(0, SCAN_LINES).some(isMarkerComment)
}

/**
 * 覆盖判定的结论。三种取值都是**正常结果**、不是异常。
 *
 * 做成返回值而不是直接抛错，是因为 `dp plan` 与 `--dry-run` 都要把它当数据读：
 * 一个只为真实部署存在的 throw，会让这两个出口看不到「这个文件不是你的」这条信息，
 * 用户只能在真正开始覆盖的那一刻才第一次听说它。
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
 *
 * 默认取「拒绝」而不是「覆盖」：同名未标记的 conf 绝大多数是用户自己写的，
 * 而误判成 dp 的代价是静默删掉别人没有打算删的配置 —— 这类损失没有任何报错能补救。
 */
export interface OverwriteOptions {
  readonly force?: boolean
  /** 报错时定位到配置项 */
  readonly path?: string
}

/**
 * 判定能不能覆盖。纯函数，不抛错 —— 调用方要能把三种结果都当数据用。
 *
 * `force` 只影响「能不能覆盖」，不影响「覆不备份」：强制覆盖同样是在覆盖
 * 一个可能含无价配置的文件，备份是唯一的后悔药。
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
  throw new DpError('DP.NGX.NOT_MANAGED', decision.reason, {
    ...(options?.path !== undefined ? { path: options.path } : {}),
    hint: PRESERVE_HINT,
  })
}
