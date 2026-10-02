/**
 * static 目标 —— 通用目录投放。
 *
 * 三条原则贯穿全程：
 *
 *  1. **永不覆盖正在使用的文件。** 版本号目录 + 切换指向，就意味着 releasing 时
 *     旧版本的进程仍持有它自己的那份文件。想靠"覆盖文件"做发布，就必然会遇到
 *     文件被占用（docs/failures.md §死锁文件）。
 *  2. **交换必须原子。** staging → rename → 换软链，任一步失败都不会留下半份版本。
 *  3. **每一步都能说清撤销动作是什么。** 每步自带 `undo`，plan 阶段就把回滚计划算出来，
 *     不是出事了才想办法。
 */
import { DpError, type Runner, type SourceEntry, type Step, type Target, type TargetContext } from '@dp/ports'

export interface StaticTargetConfig {
  /** 激活后必须存在的相对路径；缺省校验当前 release 非空 */
  readonly healthcheck?: {
    readonly fileExists?: readonly string[]
  }
}

const DIR_MODE = 0o755
const FILE_MODE = 0o644
const INDEX_MODE = 0o600

/** 统一用 `/` —— Node 的 fs 在 Windows 上认正斜杠，不必为分隔符写两套分支 */
function joinPath(...parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join('/')
}

interface Layout {
  readonly root: string
  readonly releasesDir: string
  readonly currentLink: string
  readonly indexFile: string
  readonly releaseDir: (id: string) => string
  readonly stagingDir: (id: string) => string
}

function layout(root: string): Layout {
  return {
    root,
    releasesDir: joinPath(root, 'releases'),
    currentLink: joinPath(root, 'current'),
    indexFile: joinPath(root, '.dp', 'index.json'),
    releaseDir: (id) => joinPath(root, 'releases', id),
    stagingDir: (id) => joinPath(root, 'releases', `${id}.incoming`),
  }
}

function hasDpErrorRunner(runner: Runner): void {
  if (runner.facts.host === '') {
    throw new DpError('CONFIG_INVALID', 'Runner 缺少 host', { path: 'hosts.*.host' })
  }
}

async function readJson(runner: Runner, file: string): Promise<ReleaseIndex> {
  try {
    const raw = await runner.readFile(file)
    const parsed = JSON.parse(raw) as ReleaseIndex
    return {
      current: parsed.current,
      releases: Array.isArray(parsed.releases) ? [...parsed.releases] : [],
      history: Array.isArray(parsed.history) ? parsed.history.map((h) => [...h]) : [],
    }
  } catch {
    return { releases: [], history: [] }
  }
}

interface ReleaseIndex {
  current?: string
  releases: string[]
  history: string[][]
}

async function writeJson(runner: Runner, file: string, index: ReleaseIndex): Promise<void> {
  await runner.writeFile(file, `${JSON.stringify(index, null, 2)}\n`, { mode: INDEX_MODE })
}

/**
 * 创建软链，Windows 无特权时自动退化。
 *
 * 退化**不是**静默的：会写进 warning 列表并在结果里返回 ——
 * 「看着部署成功了，其实策略被换掉了」是最难排查的一类失败。
 */
async function linkWithFallback(
  runner: Runner,
  linkPath: string,
  target: string,
  warnings: string[],
): Promise<void> {
  const tmp = `${linkPath}.dp-tmp`
  try {
    await runner.remove(tmp)
    await runner.symlink(target, tmp)
    try {
      await runner.rename(tmp, linkPath)
      return
    } catch {
      await runner.remove(linkPath)
    }
    await runner.symlink(target, linkPath)
  } catch (err) {
    if (!runner.facts.capabilities.canSymlink) {
      warnings.push(
        'DP.LINK.UNAVAILABLE: 本机无法创建软链（无开发者模式/管理员权限），current 改为复制目录 —— 这不是原子操作，且磁盘占用翻倍',
      )
      await runner.remove(linkPath)
      await runner.mkdir(linkPath, { recursive: true })
      await copyInto(runner, target, linkPath)
      return
    }
    throw err
  } finally {
    await runner.remove(tmp)
  }
}

/** 递归复制。**必须是复制而不是搬运** —— 搬走会把 release 目录掏空 */
async function copyInto(runner: Runner, from: string, to: string): Promise<void> {
  for (const name of await runner.listDir(from)) {
    const srcPath = joinPath(from, name)
    const dstPath = joinPath(to, name)
    const stat = await runner.stat(srcPath)
    if (stat === null) continue
    if (stat.isDirectory) {
      await runner.mkdir(dstPath, { recursive: true })
      await copyInto(runner, srcPath, dstPath)
    } else {
      await runner.writeFile(dstPath, await runner.readBinary(srcPath))
    }
  }
}

export interface StepTrace {
  readonly id: string
  readonly kind: Step['kind']
  readonly ok: boolean
}

export interface DeployResult {
  readonly releaseId: string
  readonly previousReleaseId?: string
  readonly filesWritten: number
  readonly warnings: readonly string[]
  readonly steps: readonly StepTrace[]
}

export interface DeployInput {
  readonly runner: Runner
  readonly ctx: TargetContext
  readonly entries: readonly SourceEntry[]
  readonly config?: StaticTargetConfig
  /** 逐步回调，供 CLI 打实时日志 */
  readonly onStep?: (step: Step) => void
}

/** 真实执行：stage → commit → activate → verify → prune */
export async function deploy(input: DeployInput): Promise<DeployResult> {
  const { runner, ctx } = input
  const L = layout(ctx.root)
  const warnings: string[] = []
  const tracer: StepTrace[] = []

  hasDpErrorRunner(runner)

  const index = await readJson(runner, L.indexFile)
  const previous = index.current ?? ctx.previousReleaseId

  await runner.mkdir(L.releasesDir, { recursive: true, mode: DIR_MODE })
  await runner.mkdir(joinPath(ctx.root, '.dp'), { recursive: true, mode: 0o700 })

  // ① stage：写进 .incoming，**从不直接写进正在服务的目录**
  const staging = L.stagingDir(ctx.releaseId)
  await runner.remove(staging)
  const steps: readonly Step[] = staticTarget.planInstall(ctx, input.config ?? {})
  input.onStep?.(steps[1]!)
  tracer.push({ id: steps[1]!.id, kind: 'install', ok: true })

  let filesWritten = 0
  for (const entry of input.entries) {
    const target = joinPath(staging, entry.relativePath)
    if (entry.kind === 'dir') {
      await runner.mkdir(target, { recursive: true, mode: entry.mode ?? DIR_MODE })
    } else {
      await runner.writeFile(target, await entry.read(), { mode: entry.mode ?? FILE_MODE })
      filesWritten += 1
    }
  }

  if (filesWritten === 0) {
    // 发布一个空版本 = 把 "current" 指向空目录 = 线上直接变 404。
    // 这几乎一定是 source 写错了（构建产物目录不对），所以**拒绝**而不是告警了事。
    await runner.remove(staging)
    throw new DpError('DP.SOURCE.EMPTY', `source 里没有任何文件：${ctx.root}`, {
      path: 'projects.*.source',
      hint: '多半是构建产物目录不对（注意 "./dist" 与 "./dist/**" 的区别）。本次未产生任何副作用',
    })
  }

  // ② commit：staging → releases/<id>。改名的瞬间这个版本才对外可见
  await runner.remove(L.releaseDir(ctx.releaseId))
  await runner.rename(staging, L.releaseDir(ctx.releaseId))

  // ③ activate：原子换向
  await linkWithFallback(runner, L.currentLink, L.releaseDir(ctx.releaseId), warnings)
  tracer.push({ id: 'activate', kind: 'activate', ok: true })

  // ④ verify：健康检查不过 → 立刻回退，不留半成品状态
  const check = await verifyRelease(runner, ctx, input.config ?? {})
  if (!check.ok) {
    warnings.push(`DP.VERIFY.FAILED: ${check.reason}，已自动回退`)
    if (previous !== undefined) {
      await linkWithFallback(runner, L.currentLink, L.releaseDir(previous), warnings)
    }
    throw new DpError('DP.VERIFY.FAILED', `健康检查未通过：${check.reason}`, {
      hint: `本次已回退到 ${previous ?? '（无上一版）'}，坏版本留在 ${L.releaseDir(ctx.releaseId)} 待查`,
    })
  }
  tracer.push({ id: 'verify', kind: 'verify', ok: true })

  // ⑤ prune + 落索引（索引最后写，避免"记录说生效了其实没生效"）
  const kept = await prune(runner, ctx.root, ctx.keep, ctx.releaseId, previous)
  index.current = ctx.releaseId
  index.releases = [...kept]
  index.history = [...index.history, [ctx.releaseId, previous ?? '']].slice(-50)
  await writeJson(runner, L.indexFile, index)
  tracer.push({ id: 'prune', kind: 'prune', ok: true })

  return {
    releaseId: ctx.releaseId,
    ...(previous !== undefined ? { previousReleaseId: previous } : {}),
    filesWritten,
    warnings,
    steps: tracer,
  }
}

export async function verifyRelease(
  runner: Runner,
  ctx: TargetContext,
  config: StaticTargetConfig,
): Promise<{ ok: boolean; reason?: string }> {
  const L = layout(ctx.root)
  const base = L.releaseDir(ctx.releaseId)
  const required = config.healthcheck?.fileExists ?? []

  for (const rel of required) {
    const stat = await runner.stat(joinPath(base, rel))
    if (stat === null) return { ok: false, reason: `缺少必需文件 ${rel}` }
  }

  if (required.length === 0) {
    const top = await runner.listDir(base)
    if (top.length === 0) return { ok: false, reason: 'release 目录为空' }
  }
  return { ok: true }
}

/** 回退到上一版。索引里没有上一版就明确报错，不做"看起来成功"的操作 */
export async function rollback(runner: Runner, ctx: TargetContext): Promise<string> {
  const L = layout(ctx.root)
  const index = await readJson(runner, L.indexFile)
  const target = index.current !== undefined && index.releases.length > 1
    ? index.releases[index.releases.length - 2]!
    : ctx.previousReleaseId

  if (target === undefined) {
    throw new DpError('DP.VERIFY.FAILED', '没有可回退的版本', {
      hint: '首次部署没有上一版；确认的话请手动删除 current 或重新部署',
    })
  }

  const warnings: string[] = []
  await linkWithFallback(runner, L.currentLink, L.releaseDir(target), warnings)
  index.current = target
  await writeJson(runner, L.indexFile, index)
  return target
}

/**
 * 保留最近 keep 个版本。**当前版本与上一版永不被清理** ——
 * 清理掉上一版等于把回退这条路炸了。
 */
export async function prune(
  runner: Runner,
  root: string,
  keep: number,
  currentId: string,
  previousId?: string,
): Promise<readonly string[]> {
  const L = layout(root)
  const all = (await runner.listDir(L.releasesDir))
    .filter((n) => !n.endsWith('.incoming') && !n.endsWith('.dp-tmp'))
    .sort()

  const protectedIds = new Set([currentId, ...(previousId !== undefined ? [previousId] : [])])
  const keepCount = Math.max(1, keep)
  const survivors = all.slice(-keepCount)
  const doomed = all.filter((id) => !survivors.includes(id) && !protectedIds.has(id))

  for (const id of doomed) {
    await runner.remove(L.releaseDir(id))
  }
  return all.filter((id) => !doomed.includes(id))
}

// ------------------------------------------------------------
// Target 契约实现（plan 侧，纯函数）
// ------------------------------------------------------------

export const staticTarget: Target<StaticTargetConfig> = {
  type: 'static',

  planInstall(ctx, config): readonly Step[] {
    return [
      {
        id: 'install',
        kind: 'install',
        title: `写入 ${ctx.root}/releases/${ctx.releaseId}.incoming`,
        host: ctx.host,
        undo: `删除 releases/${ctx.releaseId}.incoming`,
        ...(config.healthcheck?.fileExists !== undefined
          ? { detail: { requireFiles: config.healthcheck.fileExists } }
          : {}),
      },
      {
        id: 'commit',
        kind: 'install',
        title: `rename releases/${ctx.releaseId}.incoming → releases/${ctx.releaseId}`,
        host: ctx.host,
        undo: `删除 releases/${ctx.releaseId}`,
      },
    ]
  },

  planActivate(ctx): readonly Step[] {
    return [
      {
        id: 'activate',
        kind: 'activate',
        title: `current → releases/${ctx.releaseId}（原子 rename）`,
        host: ctx.host,
        undo:
          ctx.previousReleaseId !== undefined
            ? `current 指回 releases/${ctx.previousReleaseId}`
            : '删除 current（首次部署，无上一版）',
      },
    ]
  },

  planVerify(ctx, config): readonly Step[] {
    return [
      {
        id: 'verify',
        kind: 'verify',
        title:
          config.healthcheck?.fileExists !== undefined
            ? `校验必需文件：${config.healthcheck.fileExists.join(', ')}`
            : '校验 release 目录非空',
        host: ctx.host,
      },
    ]
  },

  planRollback(ctx): readonly Step[] {
    return [
      {
        id: 'rollback',
        kind: 'activate',
        title:
          ctx.previousReleaseId !== undefined
            ? `current 指回 releases/${ctx.previousReleaseId}`
            : '无上一版，无法回退',
        host: ctx.host,
      },
    ]
  },
}
