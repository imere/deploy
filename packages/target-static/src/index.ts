import {
  CURRENT_LINK_NAME,
  DpError,
  INCOMING_SUFFIX,
  RELEASES_DIR_NAME,
  type Runner,
  type SourceEntry,
  type Step,
  type SwitchStrategy,
  type Target,
  type TargetContext,
} from '@dp/ports'

/** rename 之前的落点后缀。与 INCOMING_SUFFIX 的区别：它只在一次 rename 内存在 */
const TMP_SUFFIX = '.dp-tmp'

/**
 * static 目标的可配置项。
 */
export interface StaticTargetConfig {
  /** 激活后必须存在的相对路径；缺省校验当前 release 非空 */
  readonly healthcheck?: {
    /**
     * 相对 release 目录的路径，逐个 stat 判定存在。
     */
    readonly fileExists?: readonly string[]
  }
  /**
   * `current` 的切换方式，缺省 `auto`。
   */
  readonly switch?: SwitchStrategy
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
  const releases = joinPath(root, RELEASES_DIR_NAME)
  return {
    root,
    releasesDir: releases,
    currentLink: joinPath(root, CURRENT_LINK_NAME),
    indexFile: joinPath(root, '.dp', 'index.json'),
    releaseDir: (id) => joinPath(releases, id),
    stagingDir: (id) => joinPath(releases, `${id}${INCOMING_SUFFIX}`),
  }
}

function hasDpErrorRunner(runner: Runner): void {
  if (runner.facts.host === '') {
    throw new DpError('DP.CONFIG.INVALID', 'Runner 缺少 host', { path: 'hosts.*.host' })
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

const COPY_WARNING =
  'current 是复制出来的目录而不是软链：切换不是原子操作，且磁盘占用翻倍'

/**
 * 按切换方式把 `current` 指向某个版本。
 *
 * @param strategy 见 {@link SwitchStrategy}。`auto` 与 `symlink` 都先试软链（切换是
 * 一次 rename，原子）；只有 `copy` 从一开始就不碰软链 —— 有些挂载点上的软链不被
 * 服务进程认，而那要等到线上 404 才看得见
 * @throws DpError `DP.LINK.UNAVAILABLE` —— `symlink` 下这台机器建不了软链。
 * 用户点名了软链，静默换成复制等于把「非原子 + 占盘翻倍」偷偷塞给他
 */
async function switchCurrent(
  runner: Runner,
  linkPath: string,
  target: string,
  strategy: SwitchStrategy,
  warnings: string[],
): Promise<void> {
  if (strategy === 'copy') {
    await runner.remove(linkPath)
    await runner.mkdir(linkPath, { recursive: true })
    await copyInto(runner, target, linkPath)
    warnings.push(COPY_WARNING)
    return
  }

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
      if (strategy === 'symlink') {
        throw new DpError('DP.LINK.UNAVAILABLE', '这台机器上建不了软链，而配置点名了 switch: symlink', {
          path: 'projects.*.release.switchStrategy',
          hint: 'Windows 需要开发者模式或管理员权限；容器里可能是挂载选项。改成 switchStrategy: copy 接受非原子切换，或 auto 让 dp 自己退',
        })
      }
      warnings.push(`DP.LINK.UNAVAILABLE: 本地无法创建软链（无开发者模式/管理员权限），${COPY_WARNING}`)
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

/**
 * 一步的**实测**轨迹。
 */
export interface StepTrace {
  /** 对应计划里的 step id，用于把轨迹与 plan 输出对齐 */
  readonly id: string
  /** 直接抄计划的 kind，不重新分类：重分类会让报告里的阶段名与用户手上的 plan 对不上 */
  readonly kind: Step['kind']
  /**
   * 这一步在目标机上真跑完且结论为真。
   */
  readonly ok: boolean
}

/**
 * 一次部署的结果。**只有成功才有这个东西**，失败一律走抛错。
 */
export interface DeployResult {
  /** 本次生效的版本号，与 TargetContext 相同，原样带回便于日志对账 */
  readonly releaseId: string
  /**
   * 部署前生效的版本；首次部署为 undefined。
   */
  readonly previousReleaseId?: string
  /**
   * 实际落盘的文件数。传输钩子报多少就是多少，本包**不再**去 stat 核对一遍：核对会把「传输层谎报成功」变成一次静默的部署失败，而谎报本该在传输层就报错。
   */
  readonly filesWritten: number
  /**
   * 非致命但绝不能吞掉的事，比如本地无法建软链、current 退化成复制目录。
   */
  readonly warnings: readonly string[]
  /** 逐步轨迹，只含跑成的部分；失败那一步见抛出的错误 */
  readonly steps: readonly StepTrace[]
}

/**
 * deploy() 的输入。**目标机的一切都经注入的 runner**，本包没有第二处 IO。
 */
export interface DeployInput {
  /** 目标机通道。全部 IO 走它，本包内部不直接调 fs */
  readonly runner: Runner
  /** 发布上下文：root / releaseId / keep 均已由上层按实测能力选好，这里不再推导 */
  readonly ctx: TargetContext
  /**
   * 逐条落盘用的源清单。**给了 `transfer` 就不看它** —— 两个都填不会报错，只会让传输钩子那份静默生效，排查时得先猜「到底是谁搬的文件」。
   */
  readonly entries: readonly SourceEntry[]
  /**
   * 健康检查。不给即按「release 目录非空」判定：缺省必须等价于一个能跑的判定，而不是「什么都不查」。
   */
  readonly config?: StaticTargetConfig
  /** 逐步回调，供 CLI 打实时日志 */
  readonly onStep?: (step: Step) => void
  /**
   * 由调用方提供的「把源搬到 staging 目录」的实现。
   */
  readonly transfer?: (
    stagingDir: string,
  ) => Promise<{ readonly filesWritten: number; readonly warnings?: readonly string[] }>
}

/**
 * 真实执行：stage → commit → activate → verify → prune。
 *
 * @param input 部署输入。`transfer` 缺省时按 `entries` 逐条 writeFile（小目录够用）；
 * 给了它就只由它搬文件，本函数仍然负责 commit / 换向 / verify / prune
 * @returns 本次生效的版本、落盘文件数与逐步轨迹
 * @throws DpError `DP.SOURCE.EMPTY` —— 一个文件都没落盘。发布空版本等于把 current
 * 指向空目录（线上直接 404），所以拒绝而不是告警了事；抛之前会删掉 staging，
 * 保证没有副作用残留
 * @throws DpError `DP.VERIFY.FAILED` —— 健康检查不过。抛之前已自动把 current 换回上一版，
 * 坏版本留在 releases 里待查（不删：删了就把现场也一起弄没了）
 */
export async function deploy(input: DeployInput): Promise<DeployResult> {
  const { runner, ctx } = input
  const strategy: SwitchStrategy = input.config?.switch ?? 'auto'
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
  if (input.transfer !== undefined) {
    // 钩子拿到的是**一个已存在的目录**。不先建好就指望 rsync / tar 自己造目录，
    await runner.mkdir(staging, { recursive: true, mode: DIR_MODE })

    // 传输钩子只负责把源搬进 staging；commit/切 current/verify/prune 一律仍由
    const moved = await input.transfer(staging)
    filesWritten = moved.filesWritten
    if (moved.warnings !== undefined) warnings.push(...moved.warnings)
  } else {
    for (const entry of input.entries) {
      const target = joinPath(staging, entry.relativePath)
      if (entry.kind === 'dir') {
        await runner.mkdir(target, { recursive: true, mode: entry.mode ?? DIR_MODE })
      } else {
        await runner.writeFile(target, await entry.read(), { mode: entry.mode ?? FILE_MODE })
        filesWritten += 1
      }
    }
  }

  if (filesWritten === 0) {
    // 发布一个空版本 = 把 "current" 指向空目录 = 线上直接变 404。
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
  await switchCurrent(runner, L.currentLink, L.releaseDir(ctx.releaseId), strategy, warnings)
  tracer.push({ id: 'activate', kind: 'activate', ok: true })

  // ④ verify：健康检查不过 → 立刻回退，不留半成品状态
  const check = await verifyRelease(runner, ctx, input.config ?? {})
  if (!check.ok) {
    warnings.push(`DP.VERIFY.FAILED: ${check.reason}，已自动回退`)
    if (previous !== undefined) {
      await switchCurrent(runner, L.currentLink, L.releaseDir(previous), strategy, warnings)
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

/**
 * 回退到上一版。索引里没有上一版就明确报错，不做"看起来成功"的操作目标优先取**盘上索引**（releases 的倒数第二位）而不是 `ctx.previousReleaseId`：上一次部署未必是这次调用方做的，用它的认知回退会退到一个可能从未在这台机器上生效过的版本。索引读不出来时才退回 ctx —— 那是「索引丢了但调用方知道」的降级。
 *
 * @param runner 目标机通道
 * @param ctx 发布上下文；只用 root 与 previousReleaseId（后者仅在索引不可用时兜底）
 * @param strategy 与部署时一样的切换方式。回退走的必须是同一条路，否则「部署用软链、
 * 回退变成复制」会让 current 的形态在两次操作后不一致
 * @returns 实际生效的版本号，调用方据此更新自己的状态
 * @throws DpError `DP.VERIFY.FAILED` —— 没有可回退的版本。复用已登记的码是因为处置方式
 * 确实是同一类（「先处理这个再重来」），而不是这里漏了新码
 */
export async function rollback(
  runner: Runner,
  ctx: TargetContext,
  strategy: SwitchStrategy = 'auto',
): Promise<string> {
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
  await switchCurrent(runner, L.currentLink, L.releaseDir(target), strategy, warnings)
  index.current = target
  await writeJson(runner, L.indexFile, index)
  return target
}

/**
 * 保留最近 keep 个版本。**当前版本与上一版永不被清理** ——清理掉上一版等于把回退这条路炸了。
 *
 * @param runner 目标机通道
 * @param root 发布根；releases / current 路径一律由它推导，不接受外部拼好的目录名
 * @param keep 期望保留的版本数。小于 1 会被抬成 1 —— 保留集为空的话，除受保护的那两个
 * 之外全部删掉，那不是「少留几版」而是清空历史
 * @param currentId 当前生效的版本号，受保护
 * @param previousId 上一版，同样受保护；缺省即只保护当前版本
 * @returns 盘上剩下的**全部**版本（含落在保留集之外、但因受保护而留下的那些），
 * 由调用方写进索引。只返回保留集的话，被保留下来的上一版不会进索引，
 * 下一轮 rollback 就找不到它了
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
    .filter((n) => !n.endsWith(INCOMING_SUFFIX) && !n.endsWith(TMP_SUFFIX))
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

// Target 契约实现（plan 侧，纯函数）

/**
 * Target 契约的 plan 侧。**纯函数，不碰 runner**。
 */
export const staticTarget: Target<StaticTargetConfig> = {
  type: 'static',

  planInstall(ctx, config): readonly Step[] {
    return [
      {
        id: 'install',
        kind: 'install',
        title: `写入 ${ctx.root}/${RELEASES_DIR_NAME}/${ctx.releaseId}${INCOMING_SUFFIX}`,
        host: ctx.host,
        undo: `删除 ${RELEASES_DIR_NAME}/${ctx.releaseId}${INCOMING_SUFFIX}`,
        ...(config.healthcheck?.fileExists !== undefined
          ? { detail: { requireFiles: config.healthcheck.fileExists } }
          : {}),
      },
      {
        id: 'commit',
        kind: 'install',
        title: `rename ${RELEASES_DIR_NAME}/${ctx.releaseId}${INCOMING_SUFFIX} → ${RELEASES_DIR_NAME}/${ctx.releaseId}`,
        host: ctx.host,
        undo: `删除 ${RELEASES_DIR_NAME}/${ctx.releaseId}`,
      },
    ]
  },

  planActivate(ctx): readonly Step[] {
    return [
      {
        id: 'activate',
        kind: 'activate',
        title: `${CURRENT_LINK_NAME} → ${RELEASES_DIR_NAME}/${ctx.releaseId}（原子 rename）`,
        host: ctx.host,
        undo:
          ctx.previousReleaseId !== undefined
            ? `${CURRENT_LINK_NAME} 指回 ${RELEASES_DIR_NAME}/${ctx.previousReleaseId}`
            : `删除 ${CURRENT_LINK_NAME}（首次部署，无上一版）`,
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
            ? `${CURRENT_LINK_NAME} 指回 ${RELEASES_DIR_NAME}/${ctx.previousReleaseId}`
            : '无上一版，无法回退',
        host: ctx.host,
      },
    ]
  },
}

// 只读观测 —— status / verify 的数据来源

/**
 * 只读观测出来的发布状态。**没有的字段就是没有**，不用空串 / -1 顶替。
 */
export interface ReleaseState {
  /** 索引里的当前版本；没部署过为 undefined */
  readonly current?: string
  /** current 在 releases 里的前一个；没有为 undefined */
  readonly previous?: string
  /** 索引里的版本列表（老的在前） */
  readonly releases: readonly string[]
  /** 切换历史，每项是 [新版本, 旧版本] */
  readonly history: readonly (readonly string[])[]
}

/**
 * 读发布状态。**只读**：不建目录、不写索引、不切 current。
 *
 * @param runner 目标机通道；整条链路只读一次索引文件
 * @param root 发布根；索引路径由它推导，不接受外部直接传入索引路径 ——
 * 传入的话「索引在哪」就有了第二个答案，与 deploy 写的那份可能不是同一个
 * @returns current / previous / releases / history 的快照；从未部署过时是全空状态而非报错
 */
export async function readReleaseState(runner: Runner, root: string): Promise<ReleaseState> {
  const index = await readJson(runner, layout(root).indexFile)
  const at = index.current === undefined ? -1 : index.releases.indexOf(index.current)
  const previous = at > 0 ? index.releases[at - 1] : undefined
  return {
    ...(index.current !== undefined ? { current: index.current } : {}),
    ...(previous !== undefined ? { previous } : {}),
    releases: [...index.releases],
    history: index.history.map((h) => [...h]),
  }
}
