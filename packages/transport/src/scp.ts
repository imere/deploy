import { ERR, DpError } from '@dp/ports'
import { quoteArg, wrapCommand } from '@dp/ssh'
import { runProcess, summarizeFailure } from './proc.js'
import { sshOptionsForCopyTool } from './copy-opts.js'
import { buildSshMkdirArgv, ensureRemoteDirs, groupByParentDir, nestedDirs } from './groups.js'
import { buildRshArgv } from './rsh.js'
import type { TransferRequest, TransferResult, SpawnImpl } from './types.js'
import type { RshOptions } from './rsh.js'

const LAST_RESORT = 'scp 是最后手段：不走增量，也无法删除目标上多余的文件'
const NO_VERIFY = 'dry-run 没有起 scp：远端是否可写、磁盘是否够、链路是否通，这次一概没被验证'

/**
 * scp 侧构造 argv 的输入。
 */
export interface ScpArgvOptions {
  /** 本地 scp 绝对路径（facts.tools.scp） */
  readonly scpPath: string
  /** 复用同一套 ssh 选项。scp 的 `-o` 与 ssh 同名同义 */
  readonly rsh: RshOptions
  readonly remoteTarget: string
}

/**
 * scp 的执行计划。分组与 rsync 同理：多源一目的只保每个文件的 basename，
 * 嵌套条目按父目录各组各发一条（见 groups.ts 的实测依据）。
 */
export interface ScpPlan {
  readonly argvs: readonly (readonly string[])[]
  /** 嵌套条目的目的目录（绝对路径）。scp 同样没有远端 mkdir，中间层先建 */
  readonly remoteDirs: readonly string[]
  /** 建目录用的 ssh argv。无嵌套目录时这个键不出现（有键而值是空数组 = 一条空命令） */
  readonly mkdirArgv?: readonly string[]
}

/**
 * 纯函数：scp 的完整执行计划。
 *
 * @param req 传输声明
 * @param options scp 路径、rsh 选项与目标标识
 * @returns 每组一条可直接 spawn 的 argv，外加 mkdir 前奏
 * @throws DpError DP.SOURCE.EMPTY（清单为空）、DP.PREF.UNSUPPORTED（请求了 --delete，
 * 或请求了远端提权 —— 后者在 rsync 上有 `--rsync-path` 可以落，scp 没有）
 */
export function buildScpPlan(req: TransferRequest, options: ScpArgvOptions): ScpPlan {
  if (req.entries.length === 0) {
    throw new DpError(ERR.SOURCE.EMPTY, '源清单为空，拒绝传输', {
      hint: '构建产物为空，或 include/exclude 把所有文件都排除了',
    })
  }
  if (req.deleteExtraneous === true) {
    throw new DpError(ERR.PREF.UNSUPPORTED, 'scp 不支持删除目标上多出来的文件', {
      path: 'transport.delete',
      hint: 'scp 协议没有这个能力。想清理远端目录请用 rsync-ssh 的 --delete，或在目标机上显式清理',
    })
  }

  // 提权：scp 没有 --rsync-path，远端命令没有可以包装的位置 —— 直接拒绝，
  // 而不是静默降成无提权跑（那等于把要求提权的配置当成了没写）
  if (req.become !== undefined && req.become.type !== 'none') {
    throw new DpError(ERR.PREF.UNSUPPORTED, 'scp 路径不支持远端提权', {
      path: 'hosts.*.become',
      hint: 'scp 协议没有可以包装远端命令的位置（rsync 有 --rsync-path）。需要提权请改用 rsync-ssh 或 tar-ssh',
    })
  }

  // 选项片段来自 ssh，但 scp 的 -p 是「保留时间戳」、端口是大写 -P —— 照搬会把
  // 端口号当成源文件名。改写见 copy-opts.ts。
  const copyOpts = sshOptionsForCopyTool(buildRshArgv(options.rsh).slice(1))
  const src = `${req.localRoot.replace(/\/+$/, '')}/`
  const destRoot = req.remoteRoot.endsWith('/') ? req.remoteRoot : `${req.remoteRoot}/`

  const argvs = groupByParentDir(req.entries).map((group) => {
    const argv: string[] = [options.scpPath, '-r', '-p', '-O', ...copyOpts]
    for (const e of group.files) argv.push(`${src}${e}`)
    const dest = group.dir === '' ? destRoot : `${destRoot}${group.dir}/`
    argv.push(`${options.remoteTarget}:${quoteArg(dest)}`)
    return argv
  })

  const remoteDirs = nestedDirs({ entries: req.entries, remoteRoot: req.remoteRoot })
  return {
    argvs,
    remoteDirs,
    ...(remoteDirs.length > 0
      ? {
          mkdirArgv: buildSshMkdirArgv({
            rsh: options.rsh,
            remoteTarget: options.remoteTarget,
            dirs: remoteDirs,
          }),
        }
      : {}),
  }
}

export interface RunScpOptions {
  readonly timeoutMs?: number
  readonly spawnImpl?: SpawnImpl
  /** 演练：不起进程、不建目录。scp 没有服务端干跑，真跑一次就不是演练了 */
  readonly dryRun?: boolean
  /** 清单条目数。scp 成功时不报告任何统计，所以文件数只能由调用方给的清单推 */
  readonly expectedEntries?: number
}

/**
 * 跑一个 scp 计划：255 单独认成 **ssh 层**失败而不混进「scp 失败」。
 *
 * @param plan `buildScpPlan` 的产出。mkdir 前奏排在所有组之前：scp 与 rsync 一样
 * 只建目的串的最后一段，嵌套目的的中间层得先在远端问世
 * @param options 超时 / spawn 注入 / 演练。`expectedEntries` 是文件数的**唯一来源**：
 * scp 成功时不输出任何统计，从 argv 反推条目数是猜，而猜出来的文件数会让人以为
 * scp 做了它没做的事
 * @returns scp 路径的传输结果。dryRun 下 `filesTransferred` 恒为 0
 * @throws DpError DP.SSH.CONNECT_FAILED（255）、DP.PATH.NOT_WRITABLE（目标不可写 /
 * 找不到 / mkdir 前奏失败）、DP.VERIFY.FAILED（其它非 0 退出码）；超时与 prompt 由 `runProcess` 抛
 */
export async function runScpPlan(
  plan: ScpPlan,
  options: RunScpOptions = {},
): Promise<TransferResult> {
  // scp 没有服务端干跑。真演练就是不起进程 —— 塞一个它不认识的选项只会让
  // 「干跑」变成一次必失败的真跑。mkdir 前奏同理：演练不在机器上留目录
  if (options.dryRun === true) {
    return {
      kind: 'scp',
      filesTransferred: 0,
      command: plan.argvs.flat(),
      exitCode: 0,
      warnings: [LAST_RESORT, NO_VERIFY],
      dryRun: true,
    }
  }

  if (plan.remoteDirs.length > 0 && plan.mkdirArgv !== undefined) {
    const mkdir = await ensureRemoteDirs(plan.mkdirArgv, options)
    if (mkdir.code !== 0) {
      throw new DpError(
        ERR.PATH.NOT_WRITABLE,
        `远端建父目录失败：${summarizeFailure(mkdir.stderr) || `exit ${mkdir.code}`}`,
        {
          hint: '确认目标目录存在且当前身份可写',
        },
      )
    }
  }

  const commands: string[] = []
  for (const argv of plan.argvs) {
    commands.push(...argv)
    const result = await runProcess(argv, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
      label: 'scp',
    })
    if (result.code !== 0) {
      const detail = summarizeFailure(result.stderr)
      if (result.code === 255) {
        throw new DpError(ERR.SSH.CONNECT_FAILED, `scp 的 ssh 层失败：${detail}`, {
          hint: '检查主机可达性与凭据',
        })
      }
      if (result.code === 1 || /not found|no such file/i.test(detail)) {
        throw new DpError(ERR.PATH.NOT_WRITABLE, `scp 传输失败：${detail || `exit ${result.code}`}`, {
          hint: '确认目标目录存在且可写',
        })
      }
      throw new DpError(ERR.VERIFY.FAILED, `scp 失败（exit ${result.code}）：${detail}`, {
        hint: 'scp 无增量与删除能力，考虑改用 rsync-ssh —— 它带服务端 --dry-run，能真的验一遍',
      })
    }
  }

  return {
    kind: 'scp',
    // scp 成功时不输出任何机器可读统计：从 argv 反推条目数是**猜**，
    filesTransferred: options.expectedEntries ?? 0,
    command: commands,
    exitCode: 0,
    warnings: [LAST_RESORT],
  }
}

export { wrapCommand }
