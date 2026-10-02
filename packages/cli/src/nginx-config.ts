/**
 * nginx 目标的路径推导 + 配置翻译。**纯函数**，零 IO。
 *
 * 单独成文件的理由和 target-config.ts 一样：翻译只有这一份实现。
 * 但这里多一件 static 那侧没有的活 —— **推导 confd**。
 *
 * 为什么不把它做成配置项（docs/config.md §4「目标机上的路径不是配置项」）：
 * 猜出来的路径有两种失败方式，都很难查 —— 猜对了一半时，conf 写进另一棵树，
 * `nginx -t` 通过而线上根本不加载（因为真实主配置的 include 不覆盖那个目录）；
 * 猜错时表现为「dp 报成功，reload 之后行为没变」。实测可写性是唯一可靠的依据，
 * 而 facts 已经在探测阶段把它测出来了。
 */
import { DpError, type Facts, type TargetContext } from '@dp/ports'
import type { NginxConfig, TargetConfig } from '@dp/schema'
import type { NginxTargetConfig } from '@dp/target-nginx'
import { releaseVars } from '@dp/template'

/**
 * 各平台的 confd 候选。**只列有依据的**：发行版默认或 Homebrew 前缀。
 *
 * 平台的默认值是装法决定的，不是平台决定的：同一台 Linux 上源码编译的 nginx
 * 完全可以把 confd 放在 `/usr/local/nginx/conf`。所以这张表只是**起点**，
 * 终点永远是 `canWrite` 的实测结果；实测不通过就报权限错（见 resolveConfd），
 * 由用户显式写 `target.confd`。往表里塞「也许在」的路径只会把部署写到
 * 一个 nginx 根本不 include 的目录里。
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
 *
 * **只认 `canWrite[p] === true`**，不认「路径存在」也不认「父目录可写」。
 * `canWrite` 里没有那个键 = 这台机器上没被测过（或测了不可写），两种情况都按
 * 「不可写」处理 —— 把它当成「可能可写」去试，是这一类 bug 的标准形状：
 * 第一次部署成功、第二次静默写到别处，或者直接 500 而没人知道为什么。
 *
 * 不在这里新起 probe：@dp/ssh 的 DEFAULT_WRITE_PATHS 已经含 `/etc/nginx/conf.d`，
 * 重测一遍只会多花一次往返，且本地路径的 probe 语义与远端不同。
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
 *
 * 除了补 confd，**渲染上下文也只在这里构造一次**：`${release.current}` 的值必须与
 * 真实发布路径同源，所以它取自 `releaseVars(targetCtx)`（@dp/template 的那一份），
 * 而不是这里再拼一次 `<root>/current`。两处拼法一旦漂移，产出的 conf 会指向
 * 一个从没被发布过的目录，而且 `nginx -t` 照样通过。
 */
/**
 * `${release.current}` 展开后的真实软链位置。
 *
 * 单独导出的理由：失败时要告诉用户「旧的 conf 的 root 指向哪里」，而那个值必须与
 * conf 里真正写进去的同源 —— 在报错文案里另外拼一次 `<root>/current` 就是第二个
 * 事实来源，两处一旦漂移，提示指向的路径会与盘上的不一致。
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
