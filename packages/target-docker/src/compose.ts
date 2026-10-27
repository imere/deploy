import { ERR, DpError, RELEASES_DIR_NAME, joinRemotePath, type TargetContext } from '@dp/ports'
import { renderString } from '@dp/template'
import type { DockerCompose, DockerMode, DockerTargetConfig } from './types.js'

/**
 * release 目录。与 @dp/target-static 的 `<root>/releases/<id>` 布局**同源**（都取 ports 那份名字）
 *
 * @param ctx 部署上下文，用它的 `root`（已由实测能力选定的发布根，不是用户写的原样路径）
 * @param releaseId 版本号。**回滚时传的是上一版** —— resolveCompose 靠这个参数让
 * `up` 读到上一版 release 目录里的 compose，两个方向共用同一个函数才不会算出两套路径
 * @returns 绝对路径，末尾不带 `/`。它会成为 compose 的项目目录与 cwd，所以一律用 `/` 分隔
 */
export function releaseDir(ctx: TargetContext, releaseId: string): string {
  return joinRemotePath(ctx.root.replace(/\/+$/, ''), RELEASES_DIR_NAME, releaseId)
}

/**
 * compose 项目名的字符集。
 */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/

/**
 * 已经能过字符集的值不再重复校验：同一份配置在四个 plan 里各走一次，报错要一致
 *
 * @param value 渲染之后的候选项目名（已经过 @dp/template 的 shell 档）
 * @param path 出错的配置项路径。三档拒绝给的是**不同原因**，所以 path 必须指向具体字段
 * @returns 原值。返回它而不是 void，是为了让调用方能内联写成
 * `projectName: assertProjectName(renderString(...), ...)` —— 少一处中间变量就少一处漏校验的机会
 * @throws DpError 空串、以 `-` 开头，或含 compose 不允许的字符（码：DP.DOCKER.PROJECT_NAME_INVALID）
 */
export function assertProjectName(value: string, path: string): string {
  if (value === '') {
    throw new DpError(ERR.DOCKER.PROJECT_NAME_INVALID, 'projectName 是空串', {
      path,
      hint: '它是 compose 的 `-p` 值，也是容器名与网络名的前缀，不能为空。写一个项目名，如 `api`',
    })
  }
  // 分两段报错：字符集不过的原因不同，改法也不同。合成一句等于让用户自己逆推规则
  if (value.startsWith('-')) {
    throw new DpError(ERR.DOCKER.PROJECT_NAME_INVALID, `projectName 以 - 开头：${value}`, {
      path,
      hint: 'compose 会把 `-p` 后面的值当参数解析，以 - 开头会被当成选项而不是项目名。改成 `app-<name>` 这样的形式',
    })
  }
  if (!PROJECT_NAME.test(value)) {
    const bad = [...value].find((ch) => !/[a-z0-9_-]/.test(ch))
    throw new DpError(ERR.DOCKER.PROJECT_NAME_INVALID, `projectName 含非法字符 ${bad === undefined ? '?' : bad}：${value}`, {
      path,
      hint:
        '只允许小写字母、数字、`_` 与 `-`，且必须以小写字母或数字开头 —— compose 用它拼容器名与网络名，' +
        '大写与空格会让容器名不合法，非法名在 compose 里的报错不会指出是哪一行配置写错了',
    })
  }
  return value
}

/**
 * 相对路径校验。compose 文件按约定是**相对 release 目录**的。
 */
function assertRelative(value: string, path: string, what: string): string {
  if (value === '') {
    throw new DpError(ERR.DOCKER.COMPOSE_FILE_INVALID, `${what} 是空串`, {
      path,
      hint: '空路径拼进 `-f` 后面会得到「找不到 compose 文件」，而真正的问题是这个配置项没填',
    })
  }
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new DpError(ERR.DOCKER.COMPOSE_FILE_INVALID, `${what} 是绝对路径：${value}`, {
      path,
      hint: 'compose 文件随 release 上传，路径必须相对 release 目录。写成 `docker-compose.yml` 这样的相对路径',
    })
  }
  if (value.includes('\\')) {
    throw new DpError(ERR.DOCKER.COMPOSE_FILE_INVALID, `${what} 含反斜杠：${value}`, {
      path,
      hint: '路径统一用 `/`。反斜杠在目标机上会被当成普通字符，于是「写对的文件名」在远端找不到',
    })
  }
  const segments = value.split('/')
  if (segments.includes('..')) {
    throw new DpError(ERR.DOCKER.COMPOSE_FILE_INVALID, `${what} 含 .. 逃出 release 目录：${value}`, {
      path,
      hint: 'compose 文件必须落在 release 目录之内。需要引用目录外的文件时把它纳入 source 一起上传',
    })
  }
  if (segments.some((s) => s === '')) {
    throw new DpError(ERR.DOCKER.COMPOSE_FILE_INVALID, `${what} 含空路径段：${value}`, {
      path,
      hint: '路径里出现连续的 `/` 或以 `/` 结尾。它多半是拼接出来的，中间少了一段',
    })
  }
  return value
}

/** 渲染并校验。变量展开一律走 @dp/template —— 自己写一套会让错误码分叉成两套 */
function pathValue(raw: string, config: DockerTargetConfig, path: string, what: string): string {
  const rendered = renderString(raw, config.render, { usage: 'shell', path })
  // shell 档只挡控制字符（换行会破坏「一个 argv 元素」的边界），绝对路径/.. 是这一层的判定
  return assertRelative(rendered.trim(), path, what)
}

/**
 * 非 remote-cli 显式拒绝。静默当成 remote-cli 是最糟的降级：用户以为构建过了
 *
 * @param mode 配置里的 mode。类型放宽到 string 是刻意的 —— YAML 里写什么都会到这里，
 * 运行期这条闸门是唯一能兜住的地方
 * @param path 出错的配置项路径
 * @throws DpError 不是 `remote-cli`（码：DP.DOCKER.MODE_UNSUPPORTED）
 */
export function assertMode(mode: DockerMode, path: string): void {
  if (mode === 'remote-cli') return
  throw new DpError(ERR.DOCKER.MODE_UNSUPPORTED, `mode=${String(mode)} 尚未实现`, {
    path,
    hint:
      '本轮只实现 `remote-cli`（compose 文件随 release 上传、远端 docker compose up）。' +
      '`build-push` / `build-load` / `image-only` 需要本地 docker 与镜像仓库，由后续回合补上；' +
      '在此之前报错而不是按 remote-cli 处理 —— 静默降级会让你以为镜像构建过了',
  })
}

/**
 * 一份配置解析出来的全部具体值，**所有 argv 的唯一输入**。
 */
export interface ResolvedCompose {
  /** 展开后的 release 目录（compose 的项目目录） */
  readonly projectDir: string
  /** 每个文件的绝对路径，顺序即生效顺序。install 的存在性确认直接用这个 */
  readonly files: readonly string[]
  /** 每个文件一个 `['-f', <绝对路径>]`，顺序即生效顺序 */
  readonly fileOptions: readonly string[]
  readonly projectName: string
  readonly envFile?: string
  readonly cwd: string
}

/**
 * 配置 → 可拼进 argv 的具体值。所有校验在这里一次做完，四个 plan 共用同一份解析结果 —— 同一份配置在 install 通过、在 activate 报错是最让人怀疑自己的那类不一致。
 *
 * @param ctx 部署上下文。**回滚时调用方要把 releaseId 换成上一版再传进来** ——
 * 否则项目名与 cwd 都算对了，唯独 compose 文件仍取自当前版本，而「按上一版 compose 重新 up」
 * 会变成「按当前版再 up 一次」，报告却照样显示回滚成功
 * @param config docker 目标配置
 * @param configPath 出错时的配置项基准路径。默认值用通配写法，是因为本函数也会被单独调用
 * （例如只想算出 compose 清单），那时手上没有具体项目名可用
 * @returns 项目目录、文件的绝对路径、`-f` 选项对、项目名与 cwd —— 拼 argv 所需的全部零件，别无其他
 * @throws DpError mode 不支持、files 为空或重复、路径非法、项目名不合法
 */
export function resolveCompose(ctx: TargetContext, config: DockerTargetConfig, configPath = 'projects.*.target.docker'): ResolvedCompose {
  assertMode(config.mode, `${configPath}.mode`)

  const c: DockerCompose = config.compose
  const filesPath = `${configPath}.compose.files`
  if (c.files.length === 0) {
    throw new DpError(ERR.DOCKER.COMPOSE_FILES_EMPTY, 'compose.files 是空数组', {
      path: filesPath,
      // 关键在 hint 里说清后果：不带 -f 的 docker compose up 会去当前工作目录找文件
      hint:
        '不带任何 `-f` 的 `docker compose up` 会在**当前工作目录**里找 compose 文件，' +
        '找不到时报一句与本次部署毫无关系的话。写明要用的文件，如 `[docker-compose.yml]`',
    })
  }

  const seen = new Set<string>()
  const resolvedFiles: string[] = []
  for (const [i, raw] of c.files.entries()) {
    const file = pathValue(raw, config, `${filesPath}[${i}]`, 'compose 文件')
    if (seen.has(file)) {
      // 去重是替用户做决定：重复的 `-f` 会让后面的覆盖前面的，且生效顺序敏感
      throw new DpError(ERR.DOCKER.COMPOSE_FILE_DUPLICATED, `compose 文件重复：${file}`, {
        path: `${filesPath}[${i}]`,
        hint: '同一个文件给两次 `-f` 时后面的覆盖前面的，生效顺序完全取决于数组顺序。删掉重复的那一条',
      })
    }
    seen.add(file)
    resolvedFiles.push(file)
  }

  const projectDir = releaseDir(ctx, ctx.releaseId)
  const files = resolvedFiles.map((f) => joinRemotePath(projectDir, f))

  const envFile =
    c.envFile === undefined
      ? undefined
      : joinRemotePath(projectDir, pathValue(c.envFile, config, `${configPath}.compose.envFile`, 'envFile'))

  return {
    projectDir,
    files,
    fileOptions: files.flatMap((f) => ['-f', f]),
    projectName: assertProjectName(renderString(c.projectName, config.render, { usage: 'shell', path: `${configPath}.compose.projectName` }), `${configPath}.compose.projectName`),
    ...(envFile !== undefined ? { envFile } : {}),
    // cwd 固定到 release 目录：compose 里的相对路径（build.context、volumes 的源）
    cwd: projectDir,
  }
}

/** 全局选项 + 子命令。`--env-file` 与 `-f` 同级，都是 compose 的全局选项 */
function base(resolved: ResolvedCompose): readonly string[] {
  return [
    'docker',
    'compose',
    ...resolved.fileOptions,
    ...(resolved.envFile !== undefined ? ['--env-file', resolved.envFile] : []),
    '-p',
    resolved.projectName,
  ]
}

/**
 * `docker compose ... pull` 的 argv。
 *
 * @param resolved resolveCompose 的产物：`-f`、项目名与 envFile 都取自它，本函数不再拼第二份
 * @returns 元素级 argv（真正执行时传的也是这个数组，计划里展示的只是它的一份拷贝）
 */
export function pullArgv(resolved: ResolvedCompose): readonly string[] {
  return [...base(resolved), 'pull']
}

/**
 * `docker compose ... up -d [--wait]` 的 argv。
 *
 * @param resolved 同上
 * @param wait 是否带 `--wait`。传 false 时由调用方负责把「验收只剩 ps 一道关」说清楚
 * @returns 元素级 argv
 */
export function upArgv(resolved: ResolvedCompose, wait: boolean): readonly string[] {
  return [...base(resolved), 'up', '-d', ...(wait ? ['--wait'] : [])]
}

/**
 * `docker compose ... ps --format json` 的 argv。
 *
 * @param resolved 同上。判定的服务项目名也由此处的 `-p` 界定
 * @returns 元素级 argv
 */
export function psArgv(resolved: ResolvedCompose): readonly string[] {
  return [...base(resolved), 'ps', '--format', 'json']
}

// docker compose ps --format json 的解析

/**
 * ps 输出里的一个服务。
 */
export interface ComposePsEntry {
  /** 服务名。空串按「无名」进报告而不是丢弃：丢掉等于少验一个服务 */
  readonly service: string
  /** compose 给的容器状态，如 `running` / `exited` / `restarting`。只说明进程活着与否 */
  readonly state: string
  /** compose 给的人读文案（如 `Up 2 minutes (healthy)`）。镜像起不来、端口被占这类原因只在这里写着 */
  readonly status: string
  /** compose 文件里没写 healthcheck 时这一项为空串 —— 那是正常形态，不是「不健康」 */
  readonly health: string
}

/**
 * ps 的判定结论。
 */
export interface ComposePsResult {
  /** 解析出的全部条目，**含未参与判定的那些** —— 报告要能回答「实际跑了哪些服务」 */
  readonly services: readonly ComposePsEntry[]
  /** 参与判定的服务是否全部达标 */
  readonly healthy: boolean
  /** 不通过时的原因，写进错误信息。healthy 为 true 时没有 */
  readonly reason?: string
}

function field(row: Record<string, unknown>, ...names: readonly string[]): string {
  for (const n of names) {
    const v = row[n]
    if (typeof v === 'string') return v
  }
  return ''
}

/** 一个条目算不算通过。health 单独判：`state=running` 但 `health=unhealthy` 的容器没通过检查 */
function isEntryOk(entry: ComposePsEntry, expectStates: readonly string[]): boolean {
  if (!expectStates.includes(entry.state)) return false
  if (entry.health === '') return true
  return expectStates.includes(entry.health)
}

/**
 * 解析 `docker compose ps --format json` 的 stdout。
 *
 * @param stdout ps 的 stdout 原文；JSON 数组与 NDJSON 两种形态都收
 * @param expectStates 通过的状态集合，默认 `running` / `healthy`。`health` 那一维也按它判：
 * 配了 healthcheck 的容器，`state=running` 并不代表探针过了
 * @param onlyServices 只判定这几个服务；空数组 = 判定全部
 * @returns 全部条目 + 是否通过；不通过时给出人读原因，`healthy` 为 true 时没有 reason
 * @throws DpError stdout 为空、不是合法 JSON、或某一项不是对象（码：DP.DOCKER.PS_PARSE_FAILED）
 */
export function parseComposePs(
  stdout: string,
  expectStates: readonly string[] = ['running', 'healthy'],
  onlyServices: readonly string[] = [],
): ComposePsResult {
  const raw = stdout.trim()
  if (raw === '') {
    // docker compose 没装 / 项目没起来时 stdout 就是空的。空 ≠ 绿灯
    throw new DpError(ERR.DOCKER.PS_PARSE_FAILED, '`docker compose ps --format json` 的 stdout 是空的', {
      path: 'projects.*.target.docker.compose',
      hint:
        '空输出通常意味着远端没有 `docker compose` 子命令，或该项目一个容器都没有。' +
        '先在同一台机器上手工跑一次同一条命令确认它有输出 —— 这次部署没有任何服务被验证过',
    })
  }

  let rows: readonly unknown[]
  if (raw.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (err) {
      throw new DpError(ERR.DOCKER.PS_PARSE_FAILED, 'ps 输出不是合法的 JSON 数组', {
        path: 'projects.*.target.docker.compose',
        hint: '多半是 `docker compose` 不存在时把用法打到了 stdout。确认远端 compose 可用后重试',
        cause: err,
      })
    }
    // JSON 里以 `[` 开头就一定是数组，这条分支不需要再判一次：
    rows = parsed as readonly unknown[]
  } else {
    // NDJSON：逐行独立解析。一行坏掉就整体报错，不跳过 —— 跳过等于少验一个服务
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
    rows = lines.map((line, i) => {
      try {
        return JSON.parse(line) as unknown
      } catch (err) {
        throw new DpError(ERR.DOCKER.PS_PARSE_FAILED, `ps 输出第 ${i + 1} 行不是合法 JSON`, {
          path: 'projects.*.target.docker.compose',
          hint: 'NDJSON 形态要求每行是一个独立对象。整体报错而不是跳过坏行：跳过就等于少验一个服务',
          cause: err,
        })
      }
    })
  }

  const services: ComposePsEntry[] = []
  for (const [i, row] of rows.entries()) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new DpError(ERR.DOCKER.PS_PARSE_FAILED, `ps 输出第 ${i + 1} 项不是对象`, {
        path: 'projects.*.target.docker.compose',
        hint: '这既不是数组形态也不是 NDJSON 形态。不按「空」处理，否则等于永远判通过',
      })
    }
    const obj = row as Record<string, unknown>
    const state = field(obj, 'State', 'state')
    const service = field(obj, 'Service', 'service')
    // Health 是额外的一维：state=running 只说明进程活着，不代表依赖与探针都过了
    const health = field(obj, 'Health', 'health')
    const status = field(obj, 'Status', 'status')
    services.push({ service, state, status, health })
  }

  // 合法但没有服务 = 什么都没验到。按「没有服务」判通过，正是把健康检查做成永远绿的灯
  if (services.length === 0) {
    return { services, healthy: false, reason: 'ps 输出里没有任何服务：本次部署没有容器被验证过' }
  }

  // 指定了服务却一个都对不上号 = 名字写错了（或这个服务压根没被这次部署带上）。
  const missing =
    onlyServices.length === 0
      ? []
      : onlyServices.filter((name) => !services.some((s) => s.service === name))
  if (missing.length > 0) {
    return {
      services,
      healthy: false,
      reason:
        `配置里指定的服务不在 ps 输出里：${missing.join('、')}（实际有：${services.map((s) => s.service).join('、')}）`,
    }
  }

  const judged = onlyServices.length === 0 ? services : services.filter((s) => onlyServices.includes(s.service))
  const bad = judged.filter((s) => !isEntryOk(s, expectStates))
  if (bad.length > 0) {
    return {
      services,
      healthy: false,
      reason: bad.map((s) => `${s.service}(${s.state}${s.health === '' ? '' : `/${s.health}`}: ${s.status})`).join('、'),
    }
  }
  return { services, healthy: true }
}
