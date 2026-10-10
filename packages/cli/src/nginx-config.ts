import { DpError, type Facts, type TargetContext } from '@dp/ports'
import type { NginxConfig, TargetConfig } from '@dp/schema'
import type { NginxTargetConfig } from '@dp/target-nginx'
import { releaseVars } from '@dp/template'

/**
 * 各平台的 confd 候选。**只列有依据的**：发行版默认或 Homebrew 前缀。
 */
const CONF_D_CANDIDATES: Partial<Record<Facts['platform'], readonly string[]>> = {
  // 发行版默认：nginx.org / Debian / RHEL 系包的 `conf.d/` 都在 /etc/nginx 下
  linux: ['/etc/nginx/conf.d'],
  // Homebrew 官方 nginx 的默认前缀 /usr/local/opt；Apple Silicon 桶是 /opt/homebrew
  darwin: ['/usr/local/etc/nginx/conf.d', '/opt/homebrew/etc/nginx/conf.d'],
  // win32 / freebsd / unknown：没有可靠默认，走显式配置
}

const CONF_D_PATH = 'projects.*.target.confd'

/**
 * confd 的来源，三级优先级：显式 > 实测可写的候选 > 报错。
 */
export function resolveConfd(input: { readonly facts: Facts; readonly target?: TargetConfig }): string {
  const explicit = input.target?.confd
  if (explicit !== undefined) return explicit

  const candidates = CONF_D_CANDIDATES[input.facts.platform] ?? []
  const canWrite = input.facts.capabilities.canWrite
  for (const path of candidates) {
    if (canWrite[path] === true) return path
  }

  const platformNote =
    candidates.length === 0
      ? `facts 里这台机器是 ${input.facts.platform}，本仓对它没有可靠的 confd 默认值`
      : `已实测过 ${candidates.join(' | ')}，都不可写`

  throw new DpError('DP.PERM.CONFD_NOT_WRITABLE', `推导不出可写的 nginx confd 目录：${platformNote}`, {
    path: CONF_D_PATH,
    hint:
      '两件事按顺序排查：① 这台机器的 nginx 装在别处（源码编译、第三方源、自建 rpm）——' +
      '在 projects.<项目>.target.confd 显式写它的 include 目录（注意是 **主配置 include 的那个目录**，不是 nginx.conf 所在目录）；' +
      '② /etc/nginx/conf.d 确实存在但不可写 —— 那是权限问题，给这台主机配 hosts.<主机>.become ' +
      '（免密 sudo / su / doas）让 dp 有权写。不要 chmod 777：conf 是 nginx 会加载的配置，' +
      '把它交给任意本地用户写入等于交出这台机器的流量入口',
  })
}

export interface NginxTranslateInput {
  readonly project: string
  /** profile 名（`--env`）。没给就是空串：`${env}` 这时按缺值报错，而不是编一个出来 */
  readonly env: string
  readonly envVars: Readonly<Record<string, string | undefined>>
  readonly targetCtx: TargetContext
  readonly now: Date
  readonly nginx: NginxConfig
  readonly confd: string
}

/**
 * schema 的 `target.nginx` → @dp/target-nginx 的 `NginxTargetConfig`。
 */
/**
 * `${release.current}` 展开后的真实软链位置。
 */
export function releaseCurrentPath(targetCtx: TargetContext): string {
  return releaseVars(targetCtx)['release.current']
}

export function nginxConfigFor(input: NginxTranslateInput): NginxTargetConfig {
  const { nginx, targetCtx } = input
  const vars = releaseVars(targetCtx)
  return {
    server: nginx.server,
    confd: input.confd,
    render: {
      project: input.project,
      env: input.env,
      envVars: input.envVars,
      release: { id: vars['release.id'], current: vars['release.current'] },
      now: input.now,
    },
    ...(nginx.filename !== undefined ? { filename: nginx.filename } : {}),
    ...(nginx.force !== undefined ? { force: nginx.force } : {}),
    ...(nginx.reload !== undefined ? { reload: nginx.reload } : {}),
  }
}
