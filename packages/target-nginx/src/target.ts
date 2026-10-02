/**
 * nginx 目标 —— 步骤规划（纯函数侧）。
 *
 * 生效顺序是 DESIGN §8.2 定的：**写候选 → 校验 → 原子替换 → 复验 → reload**。
 * 两步 `-t` 看着傻：前者只验「新文件本身能解析」，后者验「换上去之后整棵树能解析」。
 * 只留后者的话，一次坏 conf 会先被写进生产目录才被发现 —— 而 `nginx -t` 通过、
 * reload 也成功之后，故障会以「服务起来了但行为变了」的形式出现，那时现场已经没了。
 *
 * 本轮只做 plan：所有 `argv[]` 都排好了但**不执行**。执行器依赖渲染与步骤
 * 先定型，理由是失败时的补偿动作要跟着步骤一起定型，事后补的补偿必然是错的。
 */
import { DpError, type Step, type Target, type TargetContext } from '@dp/ports'
import { renderString } from '@dp/template'
import { renderConf } from './render.js'
import type { NginxTargetConfig } from './types.js'

const DEFAULT_RELOAD: readonly string[] = ['nginx', '-s', 'reload']
const BACKUP_SUFFIX = '.dp-backup'

/** 统一用 `/`：这些路径会被写进远端的 conf 与命令行，反斜杠在 Linux 上是转义而不是分隔符 */
function joinPath(...parts: readonly string[]): string {
  return parts.filter((p) => p !== '').join('/')
}

interface Layout {
  /** confd 里的目标文件名 */
  readonly file: string
  /** 影子校验工作目录（每次部署一个子目录，避免并发部署互相覆盖） */
  readonly shadowDir: string
  readonly candidate: string
  /** 影子主配置：include 真实 confd 树 + 候选文件 */
  readonly mainConfig: string
  readonly backup: string
  readonly reload: readonly string[] | false
}

function layout(ctx: TargetContext, config: NginxTargetConfig): Layout {
  const name = resolveFilename(ctx, config)
  const confd = config.confd.replace(/\/+$/, '')
  const shadowDir = joinPath((config.shadowDir ?? joinPath(confd, '.dp-shadow')).replace(/\/+$/, ''), ctx.releaseId)
  return {
    file: joinPath(confd, name),
    shadowDir,
    candidate: joinPath(shadowDir, name),
    mainConfig: joinPath(shadowDir, 'nginx.shadow.conf'),
    backup: `${joinPath(confd, name)}${BACKUP_SUFFIX}`,
    reload: config.reload === undefined ? DEFAULT_RELOAD : config.reload,
  }
}

/**
 * 文件名默认取项目名。它**不是**配置项而是推导结果：文件名会出现在 confd 里，
 * 猜错的结果是同名的两份 conf 同时被 include，或者旧的那份永远不再更新。
 */
function resolveFilename(ctx: TargetContext, config: NginxTargetConfig): string {
  if (config.filename !== undefined) {
    // 走模板层而不是直接 trim：默认文件名是 `<项目名>.conf`，用户照着写
    // `${project}.conf` 时必须得到同样的结果，否则「默认值」和「显式写出来的值」
    // 会指向两个不同的文件（旧的那个从此不再更新，且不会有人注意到）。
    // 先渲染再校验：变量名本身不带分隔符，渲染出来的才可能带。
    const rendered = renderString(config.filename, config.render, {
      usage: 'conf',
      path: 'projects.*.target.nginx.filename',
    }).trim()
    if (rendered === '') {
      throw new DpError('DP.NGX.CONF_INVALID', 'filename 是空串', {
        path: 'projects.*.target.nginx.filename',
        hint: '删掉这个字段会用 `<项目名>.conf`，或写成带变量的名字如 `${project}.conf`',
      })
    }
    // 它是 confd 里的**一个名字**，不是路径。带分隔符就能写到 confd 之外去，
    // 那已经越过「往 confd 里放一份配置」的授权范围了。
    if (rendered.includes('/') || rendered.includes('\\') || rendered === '.' || rendered === '..') {
      throw new DpError('DP.NGX.CONF_INVALID', `filename 不是单个文件名：${rendered}`, {
        path: 'projects.*.target.nginx.filename',
        hint: '它会被拼到 confd 后面，带路径分隔符就意味着能写到 confd 之外。要写到别处请另开一个 target',
      })
    }
    return rendered
  }
  const project = config.render.project
  if (project === '') {
    throw new DpError('DP.NGX.CONF_INVALID', '未配置 filename，且上下文里没有 project 可用来推导', {
      path: 'projects.*.target.nginx.filename',
      hint: '显式写 filename，或让调用方把 project 放进渲染上下文（默认文件名是 `<项目名>.conf`）',
    })
  }
  return `${project}.conf`
}

/**
 * shell 元字符。Runner 只有 `exec(argv[])`，中间没有 shell，这些字符在 argv 里
 * 是**字面量** —— 但正因为如此，把 `nginx -s reload; rm -rf /` 写成字符串传下去
 * 只会得到一条名字很怪、参数里带分号的 nginx 调用，与写它的人期待的完全不是一回事。
 * 照传等于静默改变语义，所以宁可报错让人写成 argv 数组。
 */
const SHELL_META = /[ \t;|&$><`'"\n\r(){}[\]\\*?!#~]/

function assertReloadArgv(argv: readonly string[]): readonly string[] {
  if (argv.length === 0) {
    throw new DpError('DP.NGX.RELOAD_CMD_INVALID', 'reload 是空数组', {
      path: 'projects.*.target.nginx.reload',
      hint: '写成 argv 数组，如 `["nginx","-s","reload"]` 或 `["systemctl","reload","nginx"]`；确实不需要 reload 就写 `false`',
    })
  }
  for (const arg of argv) {
    if (arg === '') {
      throw new DpError('DP.NGX.RELOAD_CMD_INVALID', 'reload 的参数里有空串', {
        path: 'projects.*.target.nginx.reload',
        hint: '删掉空串。空参数会让目标机的 execve 直接失败，且失败原因与真正的问题无关',
      })
    }
    if (SHELL_META.test(arg)) {
      throw new DpError('DP.NGX.RELOAD_CMD_INVALID', `reload 参数含 shell 元字符：${arg}`, {
        path: 'projects.*.target.nginx.reload',
        hint: '本仓从不经过 shell 拼命令（Runner 只有 exec(argv[])），这些字符会被原样当作参数传给程序而不是被解释 —— 照传的结果与写它的人期待的完全不同。写成 argv 数组，逐个元素只放程序名、选项和值',
      })
    }
  }
  return argv
}

const NGINX_T = 'nginx'
const NGINX_TEST: readonly string[] = [NGINX_T, '-t']

function renderFor(config: NginxTargetConfig): string {
  const project = config.render.project
  return renderConf(config.server, config.render, {
    path: `projects.${project === '' ? '*' : project}.target.nginx.server`,
  })
}

const READ_ONLY_UNDO = '无需补偿：只解析或只读，不改任何文件'

export const nginxTarget: Target<NginxTargetConfig> = {
  type: 'nginx',

  /** ① 渲染 + 写影子 + shadow 校验。**完全不碰生产目录**，验失败零影响 */
  planInstall(ctx, config): readonly Step[] {
    const L = layout(ctx, config)
    const content = renderFor(config)
    return [
      {
        id: 'nginx.render',
        kind: 'prepare',
        title: `渲染 conf（${content.split('\n').length - 1} 行）`,
        host: ctx.host,
        undo: '无需补偿：渲染发生在本地，不产生任何目标机副作用',
        detail: { file: L.file, bytes: content.length },
      },
      {
        id: 'nginx.write-candidate',
        kind: 'install',
        title: `写候选到影子目录 ${L.candidate}`,
        host: ctx.host,
        undo: `删除 ${L.shadowDir}`,
        detail: { candidate: L.candidate, shadowDir: L.shadowDir, bytes: content.length },
      },
      {
        id: 'nginx.validate-shadow',
        kind: 'install',
        title: `shadow 校验：${NGINX_TEST.join(' ')} -c ${L.mainConfig}`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: {
          argv: [...NGINX_TEST, '-c', L.mainConfig],
          // 旧文件必须排除：候选与旧文件同时被 include 会撞出 conflicting server name，
          // 于是「替换」永远过不了第一步校验。列目录是 IO，由执行器做。
          includeListFrom: config.confd,
          exclude: L.file,
        },
      },
    ]
  },

  /** ② 备份 → 原子替换 → 复验 → reload */
  planActivate(ctx, config): readonly Step[] {
    const L = layout(ctx, config)
    const steps: Step[] = [
      {
        id: 'nginx.backup',
        kind: 'activate',
        title: `备份当前 conf → ${L.backup}（存在才备；force 覆盖同样先备）`,
        host: ctx.host,
        undo: `删除备份 ${L.backup}`,
        detail: { from: L.file, to: L.backup, onlyIfExists: true },
      },
      {
        id: 'nginx.replace',
        kind: 'activate',
        title: `rename ${L.candidate} → ${L.file}（同文件系统内的原子替换）`,
        host: ctx.host,
        undo:
          ctx.previousReleaseId === undefined
            ? `删除 ${L.file}（首次部署，无备份可还原）`
            : `把 ${L.backup} rename 回 ${L.file}，然后按 nginx.reload-conf 重新 reload`,
        detail: { from: L.candidate, to: L.file, backup: L.backup },
      },
      {
        id: 'nginx.validate-live',
        kind: 'activate',
        title: `复验整棵 include 树：${NGINX_TEST.join(' ')}`,
        host: ctx.host,
        undo: '无需补偿：只解析；失败时按 nginx.replace 的 undo 还原后再次 reload',
        detail: { argv: [...NGINX_TEST], file: L.file },
      },
    ]

    if (L.reload === false) {
      steps.push({
        id: 'nginx.reload',
        kind: 'activate',
        title: 'reload 已禁用（reload: false）：由外部机制重载 nginx',
        host: ctx.host,
        undo: '无需补偿：本次没有发出任何重载动作',
      })
      return steps
    }

    steps.push({
      id: 'nginx.reload',
      kind: 'activate',
      title: `reload：${L.reload.join(' ')}`,
      host: ctx.host,
      undo: '按 nginx.replace 的 undo 还原 conf 之后，再执行一次同样的 reload',
      detail: { argv: assertReloadArgv(L.reload) },
    })
    return steps
  },

  /**
   * 复验 confd 里的内容就是本次渲染的那份。
   *
   * 只做只读比对：写完 reload 完就宣布成功的话，
   * 「文件被别的进程/别的部署工具改掉了」这件事会一直藏到下一次 404 才暴露。
   */
  planVerify(ctx, config): readonly Step[] {
    const L = layout(ctx, config)
    const content = renderFor(config)
    return [
      {
        id: 'nginx.verify-conf',
        kind: 'verify',
        title: `读回 ${L.file} 并与本次渲染结果逐字比对`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { file: L.file, bytes: content.length },
      },
    ]
  },

  /**
   * 还原上一份 conf + 复验 + reload。
   *
   * **不回退 release**：本包负责 conf 这一半，release 目录的回退由 target-static 负责。
   * 两件不同的事放在一个「回滚」里，出问题时说不清到底是 conf 错了还是版本错了。
   */
  planRollback(ctx, config): readonly Step[] {
    if (ctx.previousReleaseId === undefined) {
      throw new DpError('DP.NGX.NO_PREVIOUS', '没有上一版 conf 可还原', {
        path: 'projects.*.target.nginx',
        hint: '首次部署没有可回退的版本。确认要撤销的话，手动删除该 conf 后 reload —— 本包不返回「回滚成功」这种假结果',
      })
    }

    const L = layout(ctx, config)
    const steps: Step[] = [
      {
        id: 'nginx.restore-backup',
        kind: 'activate',
        title: `rename ${L.backup} → ${L.file}（还原上一份 conf）`,
        host: ctx.host,
        undo: '撤销回退 = 再走一次 planInstall/planActivate 把本次渲染结果写回去，然后 reload',
        detail: { from: L.backup, to: L.file, previousReleaseId: ctx.previousReleaseId },
      },
      {
        id: 'nginx.validate-rollback',
        kind: 'verify',
        title: `复验整棵 include 树：${NGINX_TEST.join(' ')}`,
        host: ctx.host,
        undo: READ_ONLY_UNDO,
        detail: { argv: [...NGINX_TEST] },
      },
    ]

    if (L.reload === false) return steps

    steps.push({
      id: 'nginx.reload-rollback',
      kind: 'activate',
      title: `reload：${L.reload.join(' ')}`,
      host: ctx.host,
      undo: '再次 reload 回到还原前的 conf（需要先把本次 conf 重新写回）',
      detail: { argv: assertReloadArgv(L.reload) },
    })
    return steps
  },
}
