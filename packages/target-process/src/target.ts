import { DpError, RELEASES_DIR_NAME, type Step, type Target, type TargetContext } from '@dp/ports'
import { renderString, type RenderContext } from '@dp/template'
import { START_SCRIPT_NAME, STOP_SCRIPT_NAME, graceSecondsOf } from './script.js'
import type { ProcessTargetConfig } from './types.js'

/** pidfile 的默认相对路径（相对发布根目录） */
export const DEFAULT_PID_FILE = '.dp/process.pid'
/** stdout / stderr 的默认落盘位置（相对发布根目录） */
export const DEFAULT_STDOUT_LOG = '.dp/process.log'
/** 默认停止信号。它给进程收尾的机会，`SIGKILL` 不给 */
export const DEFAULT_STOP_SIGNAL = 'SIGTERM'
/** 默认优雅期，毫秒。它是**上限**而不是「等它结束」 */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000

/** 统一用 `/`：这些路径会被拼进远端的命令行，反斜杠在 Linux 上是转义而不是分隔符 */
function joinPath(...parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join('/')
}

/**
 * 版本目录。**回滚要按 id 回到某个历史版本**，所以它接受任意 id，而不是只认 ctx 上的那一个。
 *
 * @param ctx 部署上下文（发布根）
 * @param releaseId 版本 id
 * @returns 该版本的目录绝对路径
 */
export function releaseDirOf(ctx: TargetContext, releaseId: string): string {
  return joinPath(ctx.root.replace(/\/+$/, ''), RELEASES_DIR_NAME, releaseId)
}

/**
 * 本次进程管理的落点。
 *
 * 脚本**跟着版本目录走**（`<release 目录>/.dp/`），被 prune 时随那个版本一起消失；
 * pidfile 与日志**落在发布根下的固定位置**，跨版本只有一份 —— 激活时要停的是
 * 「当前跑着的那个」，而那一刻还不知道 current 指向哪。
 */
export interface ProcessPaths {
  /** 本次版本目录 */
  readonly releaseDir: string
  readonly scriptDir: string
  readonly startScript: string
  readonly stopScript: string
  readonly pidFile: string
  readonly stdoutLog: string
  /**
   * argv[0]，渲染后的值。
   *
   * `${...}` 在这里就被展开：dp 里所有字符串型配置值都走渲染，只有这一处不渲染的话，
   * 用户写 `${release.current}/bin/api` 会**静默地**变成一段字面文本 —— 它不报错、
   * 能被写进脚本、只在真正启动时 `exec: not found`，而那一刻错误指向的是目标机而不是配置。
   */
  readonly command: string
  /** 渲染后的参数 */
  readonly args: readonly string[]
  readonly workingDirectory: string
  readonly stopSignal: string
  /** 优雅期，毫秒。脚本里的轮询上限由它换算 */
  readonly stopTimeoutMs: number
}

/**
 * 算出本次落点。纯函数 —— 两台机器上同样的输入产出逐字相同的结果。
 *
 * @param ctx 发布上下文
 * @param config process 段
 * @param releaseId 本次要**启动**的那个版本，默认当前版本
 * @returns 脚本与 pidfile 的绝对路径
 * @throws DpError `DP.PROC.COMMAND_INVALID` —— pidfile / 日志路径逃出发布根
 */
export function processPaths(
  ctx: TargetContext,
  config: ProcessTargetConfig,
  /**
   * 本次要**启动**的那个版本。回滚时它是上一版 ——
   * 那一刻 `current` 还指向要撤掉的那版，照 `current` 起等于没回滚。
   */
  releaseId: string = ctx.releaseId,
): ProcessPaths {
  const releaseDir = releaseDirOf(ctx, releaseId)
  return {
    releaseDir,
    scriptDir: joinPath(releaseDir, '.dp'),
    startScript: joinPath(releaseDir, '.dp', START_SCRIPT_NAME),
    stopScript: joinPath(releaseDir, '.dp', STOP_SCRIPT_NAME),
    pidFile: joinPath(ctx.root.replace(/\/+$/, ''), normalizeRelative(config.pidFile ?? DEFAULT_PID_FILE, 'pidFile')),
    stdoutLog: joinPath(ctx.root.replace(/\/+$/, ''), normalizeRelative(config.stdoutLog ?? DEFAULT_STDOUT_LOG, 'stdoutLog')),
    // usage 用 'shell'：这两个值最终的落点是 exec(argv[]) 的元素。
    // 'path' 会把 `|` `<` `>` 一律拒掉，而它们是命令参数里的合法字符；
    // 真正的注入在这里由 `script.ts` 的单引号 + 控制字符闸门锁住
    command: render(config.command, config.render, 'command'),
    args: (config.args ?? []).map((arg, i) => render(arg, config.render, `args[${i}]`)),
    workingDirectory: renderString(config.workingDirectory ?? '${release.current}', config.render, {
      usage: 'path',
      path: 'projects.*.target.process.workingDirectory',
    }),
    stopSignal: config.stopSignal ?? DEFAULT_STOP_SIGNAL,
    stopTimeoutMs: config.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
  }
}

/**
 * 渲染一个会落到脚本里成为 argv 元素的值。
 *
 * @param value 配置里的原文
 * @param ctx 渲染上下文
 * @param field 配置项名（`args` 里带下标），用于把错误定位到那一项
 * @returns 渲染后的值
 * @throws DpError 模板缺少变量，或渲染结果含被拒字符
 */
function render(value: string, ctx: RenderContext, field: string): string {
  return renderString(value, ctx, { usage: 'shell', path: `projects.*.target.process.${field}` })
}

/**
 * 相对路径的准入与归一化。
 *
 * 拒绝绝对路径与 `..`：这两样能把文件写到发布根目录之外。pidfile 与日志都在部署的
 * 写路径上，一旦可逃逸就是一条任意文件写入。反斜杠也拒：它在 POSIX 路径里是合法
 * 字符，会让「同一个文件」有两种写法。
 *
 * @param value 待判定的相对路径
 * @param field 配置项名，用于报错定位
 * @returns 用 `/` 分隔的相对路径
 * @throws DpError `DP.PROC.COMMAND_INVALID` —— 是绝对路径、含 `..` 或含反斜杠
 */
function normalizeRelative(value: string, field: string): string {
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    throw new DpError('DP.PROC.COMMAND_INVALID', `${field} 是绝对路径：${value}`, {
      path: `projects.*.target.process.${field}`,
      hint: '写相对路径（如 `.dp/process.pid`）。发布根由能力推导，进程不该关心它是哪一段绝对路径',
    })
  }
  if (value.includes('\\')) {
    throw new DpError('DP.PROC.COMMAND_INVALID', `${field} 含反斜杠：${value}`, {
      path: `projects.*.target.process.${field}`,
      hint: '反斜杠在 POSIX 路径里是合法字符，留着它「同一个文件」就有两种写法，判定与清理都会漏。改用 / 分隔',
    })
  }
  if (value.split('/').some((segment) => segment === '..')) {
    throw new DpError('DP.PROC.COMMAND_INVALID', `${field} 含 .. 段：${value}`, {
      path: `projects.*.target.process.${field}`,
      hint: '`..` 能写到发布根目录之外。把 pid / 日志放在发布根之内的固定位置',
    })
  }
  return value.replace(/^\/+/, '')
}

/**
 * 启动脚本的 argv。**只有一个脚本路径** —— 命令、参数、环境变量、工作目录、pidfile
 * 全在渲染期烘进脚本里了，运行期不再传任何位置参数。
 *
 * 这不是偷懒：回滚要跑的是**上一版实际部署出去的那份脚本**，而运行期手上只有当前
 * 配置。把 command 当参数传进去，回滚就变成「用当前配置的命令在上一版目录里跑」，
 * 那不是回滚。
 *
 * @param paths 本次落点
 * @returns 可直接交给 `Runner.exec` 的 argv
 */
export function startArgv(paths: ProcessPaths): readonly string[] {
  return ['sh', paths.startScript]
}

/**
 * 停止脚本的 argv。与启动脚本同理：**只有脚本路径**，pidfile 与信号都烘在脚本里。
 *
 * @param paths 本次落点
 * @returns 可直接交给 `Runner.exec` 的 argv
 */
export function stopArgv(paths: ProcessPaths): readonly string[] {
  return ['sh', paths.stopScript]
}

/**
 * 上一版启动脚本的 argv。
 *
 * @param ctx 发布上下文
 * @param releaseId 上一版 id
 * @returns 可直接交给 `Runner.exec` 的 argv
 */
export function previousStartArgv(ctx: TargetContext, releaseId: string): readonly string[] {
  return ['sh', joinPath(releaseDirOf(ctx, releaseId), '.dp', START_SCRIPT_NAME)]
}

/**
 * 存活断言的 argv。
 *
 * 走 `sh -c` 而不是直接 exec `kill`：`kill` 通常是 shell 内建，磁盘上未必有
 * 独立可执行文件，把它当 argv[0] 会在一部分目标机上 ENOENT。
 *
 * @param pid 待检查的 pid
 * @returns 可直接交给 `Runner.exec` 的 argv
 */
export function aliveArgv(pid: string): readonly string[] {
  return ['sh', '-c', 'kill -0 "$1"', 'sh', pid]
}

const READ_ONLY_UNDO = '无需补偿：只查询状态，不改动任何文件'

/**
 * process 目标的 plan 侧。**纯函数**：不碰 runner、不发命令、不写文件。
 */
export const processTarget: Target<ProcessTargetConfig> = {
  type: 'process',

  /** ① 渲染启动/停止脚本。只写版本目录，不启动任何进程 */
  planInstall(ctx, config): readonly Step[] {
    const paths = processPaths(ctx, config)
    return [
      {
        id: 'process.render',
        kind: 'prepare',
        title: `渲染进程脚本（${config.command}）`,
        host: ctx.host,
        undo: '无需补偿：渲染发生在本地，不产生任何目标机副作用',
      },
      {
        id: 'process.write-scripts',
        kind: 'install',
        title: `写启动/停止脚本到 ${paths.scriptDir}`,
        host: ctx.host,
        undo: `删除 ${paths.scriptDir}`,
        detail: { startScript: paths.startScript, stopScript: paths.stopScript },
      },
    ]
  },

  /** ② 先停当前进程，再按新版本目录里的脚本起新的 */
  planActivate(ctx, config): readonly Step[] {
    const paths = processPaths(ctx, config)
    return [
      {
        id: 'process.stop-current',
        kind: 'activate',
        title: `停止当前进程（pidfile ${paths.pidFile}）`,
        host: ctx.host,
        undo: '无需补偿：停进程不可撤销，回滚靠按上一版脚本重新起',
        detail: { argv: stopArgv(paths), pidFile: paths.pidFile, signal: paths.stopSignal, graceSeconds: graceSecondsOf(paths.stopTimeoutMs) },
      },
      {
        id: 'process.start-new',
        kind: 'activate',
        title: `启动 ${config.command}`,
        host: ctx.host,
        undo: `sh ${paths.stopScript}`,
        detail: { argv: startArgv(paths), pidFile: paths.pidFile, cwd: paths.workingDirectory },
      },
    ]
  },

  /**
   * ③ 断言进程还活着。
   *
   * argv **不在计划里发布**：它取决于 pidfile 里当下那个 pid，计划期无从得知。
   * 计划里放的是 pidfile 位置，执行器读到 pid 后再组装命令行。
   */
  planVerify(ctx, config): readonly Step[] {
    const paths = processPaths(ctx, config)
    return [
      {
        id: 'process.alive',
        kind: 'verify',
        title: `断言进程存活（pidfile ${paths.pidFile}）`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { pidFile: paths.pidFile },
      },
    ]
  },

  /**
   * ④ 停掉当前进程，再按上一版目录里的脚本起回来。
   *
   * @throws DpError `DP.PROC.NO_PREVIOUS` —— `ctx.previousReleaseId` 为空。
   * 计划期就拒，是因为上一版目录拼不出来时后面每一步都没有意义
   */
  planRollback(ctx, config): readonly Step[] {
    const paths = processPaths(ctx, config)
    const previousId = ctx.previousReleaseId
    if (previousId === undefined || previousId === '') {
      throw new DpError('DP.PROC.NO_PREVIOUS', '没有上一版可回滚', {
        path: 'projects.*.target.process',
        hint: '首次部署没有历史版本，回滚无从谈起。要撤掉这次部署就手动停掉进程再删版本目录',
      })
    }
    const previousArgv = previousStartArgv(ctx, previousId)
    return [
      {
        id: 'process.stop-current',
        kind: 'activate',
        title: `停止当前进程（pidfile ${paths.pidFile}）`,
        host: ctx.host,
        undo: '无需补偿：停进程不可撤销，回滚靠按上一版脚本重新起',
        detail: { argv: stopArgv(paths), pidFile: paths.pidFile, signal: paths.stopSignal, graceSeconds: graceSecondsOf(paths.stopTimeoutMs) },
      },
      {
        id: 'process.start-previous',
        kind: 'activate',
        title: '按上一版脚本启动',
        host: ctx.host,
        undo: `sh ${paths.stopScript}`,
        detail: { argv: previousArgv, previousReleaseId: previousId, previousDir: releaseDirOf(ctx, previousId) },
      },
      {
        id: 'process.alive',
        kind: 'verify',
        title: `断言进程存活（pidfile ${paths.pidFile}）`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { pidFile: paths.pidFile },
      },
    ]
  },
}
