/**
 * 目标类型探测（TargetResolver 的「探测 + 仲裁」半边）—— **纯函数**，零 IO。
 *
 * 零 IO 是这里的硬约束：源清单由调用方注入（`DetectInput.entries`），package.json
 * 的 scripts 也由调用方读好塞进来。本文件不 import `node:fs`、不碰 `process.env`、
 * 不起子进程 —— 它一旦开始读盘，`makePlan()` 就不再是纯函数，plan 也就没法在
 * 没有任何机器的情况下断言。
 *
 * 仲裁刻意保守（docs/config.md §8）：**猜错的代价是「部署到了错误的目标类型」**，
 * 而那通常表现为一次线上事故，所以拿不准一律报错 + 列出候选 + 给出排除办法。
 */
import { DpError } from '@dp/ports'

/** 对应 `targetSchema.pick`。不设默认值：调用方必须显式传，默认值由 schema 那一层给 */
export type TargetPick = 'auto' | 'fail'

/**
 * 本仓**已实现**的目标类型。
 *
 * 刻意不等于 `TARGET_KINDS`：schema 里还有 `systemd` / `process`，但它们没有执行器
 * （AGENTS.md：systemd 目标只有 unit 渲染的规则，尚未接线）。两处都叫「目标类型」但
 * 含义不同，把 schema 的枚举直接当「已实现」用，错误信息就会把用户指向一个跑不了的选项。
 */
export const IMPLEMENTED_KINDS: readonly string[] = ['static', 'nginx', 'docker']

export interface DetectInput {
  /**
   * 源条目。**相对路径**（`./dist/**` 展开后的形态，如 `docker-compose.yml`、`assets/app.js`）
   */
  readonly entries: readonly string[]
  /**
   * `package.json` 里的 scripts 名字（如 `['build', 'deploy']`）。
   * 由调用方读好再注入 —— 探测函数自己不读盘，否则它就不是纯函数了。
   */
  readonly packageScripts?: readonly string[]
}

export interface DetectCandidate {
  /** 命中的目标类型。`caddy` / `k8s` 也要能报出来（它们是「看到了但还没实现」） */
  readonly kind: string
  /** 证据：具体哪几个文件让它这么认为。空证据的候选不许存在 */
  readonly evidence: readonly string[]
  /** 本仓是否已实现。false 的候选参与仲裁但**绝不静默降级**成 static */
  readonly implemented: boolean
  /** 置信度，用于 `pick: auto` 的排序。同档位就要报错，不许靠顺序暗选 */
  readonly confidence: number
}

export interface DetectResult {
  readonly kind: string
  readonly evidence: readonly string[]
  /** pick: auto 时被舍弃的其它候选（含未实现的）。CLI 靠它回答「为什么选了它」 */
  readonly rejected: readonly DetectCandidate[]
  /** 一行人话，如「检测到 docker-compose.yml → target.type=docker（可用 target.type 覆盖）」 */
  readonly reason: string
}

// ------------------------------------------------------------
// 置信度档位
// ------------------------------------------------------------

/**
 * 档位 = 证据有多难被巧合凑出来。
 *
 * 90 compose 文件：这个项目**就是**一个 compose 项目，文件名几乎不可能出现在无关项目里
 * 80 nginx.conf：同层级的强信号，但项目同时用 nginx 与别的东西并不罕见
 * 60 systemd / pm2：**刻意同档**。两者都是「项目自带一份进程监管配置」，强度相当；
 *    仓库里同时出现 `.service` 与 `ecosystem.config.js` 时没有任何依据偏向谁，
 *    这个「撞档」是同分报错分支的真实入口 —— 档位表若全互不相同，那条分支就是死代码
 * 50 Dockerfile 且无 compose：单镜像比 compose 弱一档（compose 顺带定义了编排关系，
 *    单镜像只说明「有个镜像」），且本仓只做 remote-cli，认它也没有可跑的东西
 * 45 Caddyfile / 40 delegate / 30 Chart.yaml：辅助信号
 * 20 index.html：几乎每个前端产物都有，是**兜底档而不是强信号**。它排最后不是因为不重要，
 *    而是因为它最容易被无关文件顺带满足 —— 排前面就会把 compose 项目判成 static
 */
const CONF = {
  dockerCompose: 90,
  nginx: 80,
  supervisor: 60,
  dockerSingleImage: 50,
  caddy: 45,
  delegate: 40,
  k8s: 30,
  static: 20,
} as const

// ------------------------------------------------------------
// 路径匹配
// ------------------------------------------------------------

const COMPOSE_EXACT = new Set(['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'])
/** `docker-compose.*.yml`：中间那截必须非空，`docker-compose..yml` 不是合法文件名 */
const COMPOSE_VARIANT = /^docker-compose\..+\.ya?ml$/
/** `Dockerfile` 与 `Dockerfile.prod` 一类带后缀的写法 */
const DOCKERFILE = /^Dockerfile(\..+)?$/

/** 归一化：Windows 与 POSIX 分隔符视为同一条路径（`assets\app.js` ≡ `assets/app.js`） */
function segments(entry: string): readonly string[] {
  return entry
    .split(/[\\/]+/)
    .filter((s) => s.length > 0 && s !== '.')
}

/** 归一化后的展示形态。证据与报错里都用它，保证两种平台下产出逐字相同 */
function normalize(entry: string): string {
  return segments(entry).join('/')
}

function basename(segs: readonly string[]): string {
  return segs[segs.length - 1] ?? ''
}

function isComposeName(name: string): boolean {
  return COMPOSE_EXACT.has(name) || COMPOSE_VARIANT.test(name)
}

/** 目录名为 `conf.d` 之下的 `.conf`：`conf.d` 必须是目录段，不能是文件自身 basename */
function isConfdFile(segs: readonly string[]): boolean {
  if (!basename(segs).endsWith('.conf')) return false
  return segs.slice(0, -1).includes('conf.d')
}

/** `.deploy/scripts/*`：`scripts` 之后至少还要有一段，否则 `.deploy/scripts` 本身不算 */
function isDelegateScriptPath(segs: readonly string[]): boolean {
  return segs.some((seg, i) => seg === '.deploy' && segs[i + 1] === 'scripts' && i + 2 < segs.length)
}

// ------------------------------------------------------------
// 探测器
// ------------------------------------------------------------

function sortUnique(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort()
}

/**
 * 列出候选。**一个 kind 最多一个候选** —— docker 的两条证据（compose / Dockerfile）
 * 合并成同一个候选，见 docker 那一支。
 */
export function detectCandidates(input: DetectInput): readonly DetectCandidate[] {
  const out: DetectCandidate[] = []

  const composeFiles: string[] = []
  const dockerfiles: string[] = []
  const nginxFiles: string[] = []
  const caddyFiles: string[] = []
  const serviceFiles: string[] = []
  const pm2Files: string[] = []
  const delegateFiles: string[] = []
  const staticFiles: string[] = []
  const k8sFiles: string[] = []

  for (const entry of input.entries) {
    const segs = segments(entry)
    if (segs.length === 0) continue
    const path = normalize(entry)
    const name = basename(segs)

    if (isComposeName(name)) composeFiles.push(path)
    if (DOCKERFILE.test(name)) dockerfiles.push(path)
    if (name === 'nginx.conf' || isConfdFile(segs) || name.endsWith('.nginx.conf')) nginxFiles.push(path)
    if (name === 'Caddyfile') caddyFiles.push(path)
    if (name.endsWith('.service')) serviceFiles.push(path)
    if (name === 'ecosystem.config.js') pm2Files.push(path)
    if (isDelegateScriptPath(segs)) delegateFiles.push(path)
    if (name === 'index.html') staticFiles.push(path)
    if (name === 'Chart.yaml') k8sFiles.push(path)
  }

  // compose 存在时 docker 即为已实现（remote-cli 有东西可跑）；否则只有 Dockerfile
  // 只是一个没实现的单镜像 —— 不能因为它叫 docker 就让用户以为 dp 会去构建镜像。
  if (composeFiles.length > 0) {
    out.push({
      kind: 'docker',
      evidence: sortUnique([...composeFiles, ...dockerfiles]),
      implemented: true,
      confidence: CONF.dockerCompose,
    })
  } else if (dockerfiles.length > 0) {
    out.push({
      kind: 'docker',
      evidence: sortUnique(dockerfiles),
      implemented: false,
      confidence: CONF.dockerSingleImage,
    })
  }

  const push = (kind: string, files: readonly string[], implemented: boolean, confidence: number): void => {
    if (files.length > 0) out.push({ kind, evidence: sortUnique(files), implemented, confidence })
  }
  push('nginx', nginxFiles, true, CONF.nginx)
  push('systemd', serviceFiles, false, CONF.supervisor)
  push('pm2', pm2Files, false, CONF.supervisor)
  push('caddy', caddyFiles, false, CONF.caddy)
  push('k8s', k8sFiles, false, CONF.k8s)
  push('static', staticFiles, true, CONF.static)

  // packageScripts 由调用方注入：探测器自己读不到 package.json（那是 IO）
  const hasDeployScript = (input.packageScripts ?? []).includes('deploy')
  if (delegateFiles.length > 0 || hasDeployScript) {
    const evidence = sortUnique([
      ...delegateFiles,
      ...(hasDeployScript ? ['package.json:scripts.deploy'] : []),
    ])
    out.push({ kind: 'delegate', evidence, implemented: false, confidence: CONF.delegate })
  }

  return out
}

// ------------------------------------------------------------
// 仲裁
// ------------------------------------------------------------

function summarize(c: DetectCandidate): string {
  const ev = c.evidence.slice(0, 3).join('、')
  const more = c.evidence.length > 3 ? ` 等 ${c.evidence.length} 项` : ''
  return `${c.kind}（${ev}${more}，confidence ${c.confidence}${c.implemented ? '' : '，未实现'}）`
}

function implementedList(): string {
  return IMPLEMENTED_KINDS.join(' | ')
}

/** 「排除办法」在三条歧义报错里都要出现：光列候选不给出路等于没拒绝 */
const EXCLUDE_HINT = '把误命中的文件 exclude 出 source，或改文件名'

function describeSeen(input: DetectInput): string {
  const files = input.entries.map(normalize).filter((p) => p.length > 0)
  if (files.length === 0) return '（源清单为空）'
  const head = files.slice(0, 10).join('、')
  return files.length > 10 ? `${head} …… 共 ${files.length} 个` : `${head}（共 ${files.length} 个）`
}

/**
 * 探测 + 仲裁。**不读盘**。
 *
 * 0 命中 → 报错并列出它看到了哪些文件，绝不假装 static
 * 1 命中 → 用它（未实现则报错，说明还差什么）
 * 多命中 → `fail` 报错；`auto` 取最高档，同档位报错
 *
 * 「未实现不参与取最高」有一条边界：单个未实现的强信号**不许**否决一个已实现的候选
 * （否则源里躺一个 `Caddyfile` 就得报「不支持」），但两个**强度相同**的信号撞档
 * 仍然是歧义 —— 那时报错，报的是「无法判定」，不是「不支持」。
 */
function noEvidenceError(input: DetectInput): DpError {
  return new DpError('DP.CONFIG.INVALID', '探测不到目标类型：源里没有任何可识别的证据', {
    path: 'target.type',
    hint:
      `看到的文件：${describeSeen(input)}。显式写 target.type（${implementedList()}）告诉 dp 用哪一种；` +
      '探测不出来时 dp 不猜 —— 猜错就是部署到了错误的目标类型',
  })
}

export function resolveTargetKind(input: DetectInput, pick: TargetPick): DetectResult {
  const candidates = detectCandidates(input)

  if (candidates.length === 0) {
    throw noEvidenceError(input)
  }

  if (candidates.length === 1) {
    const only = candidates[0]
    if (only === undefined) throw noEvidenceError(input)
    if (!only.implemented) {
      throw new DpError(
        'DP.CONFIG.INVALID',
        `探测到 ${only.evidence[0] ?? only.kind}，但本仓还没实现 ${only.kind} 目标`,
        {
          path: 'target.type',
          hint: `已实现的目标：${implementedList()}。写 target.type 指定其一，或换一个源（${EXCLUDE_HINT}）`,
        },
      )
    }
    return {
      kind: only.kind,
      evidence: only.evidence,
      rejected: [],
      reason: `检测到 ${only.evidence[0] ?? only.kind} → target.type=${only.kind}（可用 target.type 覆盖）`,
    }
  }

  if (pick === 'fail') {
    throw new DpError(
      'DP.CONFIG.INVALID',
      `${candidates.length} 个目标类型同时命中，target.pick=fail 时不猜：${candidates.map(summarize).join('；')}`,
      {
        path: 'target.type',
        hint: `显式写 target.type 指定其中一个（${implementedList()}），或改 target.pick: auto 让 dp 取 confidence 最高的；${EXCLUDE_HINT}`,
      },
    )
  }

  // pick: auto
  const ranked = [...candidates].sort((a, b) => b.confidence - a.confidence)
  const top = ranked[0]
  if (top === undefined) throw noEvidenceError(input)
  const tier = ranked.filter((c) => c.confidence === top.confidence)
  if (tier.length > 1) {
    throw new DpError(
      'DP.CONFIG.INVALID',
      `${tier.map((c) => c.kind).join(' 与 ')} 的证据强度相同（confidence ${top.confidence}），无法判定用哪个`,
      {
        path: 'target.type',
        hint: `${tier.map(summarize).join('；')}。显式写 target.type 指定其一（${implementedList()}）；${EXCLUDE_HINT}`,
      },
    )
  }

  const usable = ranked.filter((c) => c.implemented)
  const chosen = usable[0]
  if (chosen === undefined) {
    throw new DpError(
      'DP.CONFIG.INVALID',
      `探测到的 ${ranked.map((c) => c.kind).join('、')} 本仓都还没实现`,
      {
        path: 'target.type',
        hint: `已实现的目标：${implementedList()}。写 target.type 指定其一，或换一个源（${EXCLUDE_HINT}）`,
      },
    )
  }

  const seen = ranked.map((c) => c.kind).join('、')
  const lead = chosen.evidence[0] ?? chosen.kind
  return {
    kind: chosen.kind,
    evidence: chosen.evidence,
    rejected: ranked.filter((c) => c !== chosen),
    reason:
      ranked.length === 1
        ? `检测到 ${lead} → target.type=${chosen.kind}（可用 target.type 覆盖）`
        : `检测到 ${seen} → 取 confidence 最高的 ${chosen.kind}（${lead}，可用 target.type 覆盖）`,
  }
}
