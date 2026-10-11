import { DpError } from '@dp/ports'
import { TARGET_KINDS } from '@dp/schema'

/** 对应 `targetSchema.pick`。不设默认值：调用方必须显式传，默认值由 schema 那一层给 */
export type TargetPick = 'auto' | 'fail'

/**
 * 本仓**已实现**的目标类型 = 配置里允许写出的那一份。
 *
 * 两份名单分开写就会各改各的：配置放行一个没有执行器的类型，用户写下去得到的是
 * 「校验通过、部署行为完全不是他点名的那个」。
 */
export const IMPLEMENTED_KINDS: readonly string[] = TARGET_KINDS

/**
 * 探测的输入。**没有**「源目录」字段，只有展开后的条目名：探测关心的是「有没有 compose 文件」，不是「文件在哪」——给了路径就得关心它从哪来，纯函数的前提随即破掉。
 */
export interface DetectInput {
  /**
   * 源条目。**相对路径**（`./dist/**` 展开后的形态，如 `docker-compose.yml`、`assets/app.js`）
   */
  readonly entries: readonly string[]
  /**
   * `package.json` 里的 scripts 名字（如 `['build', 'deploy']`）。
   */
  readonly packageScripts?: readonly string[]
}

/**
 * 一个候选目标类型。
 */
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

/**
 * 仲裁的结论。
 */
export interface DetectResult {
  readonly kind: string
  readonly evidence: readonly string[]
  /** pick: auto 时被舍弃的其它候选（含未实现的）。CLI 靠它回答「为什么选了它」 */
  readonly rejected: readonly DetectCandidate[]
  /** 一行人话，如「检测到 docker-compose.yml → target.type=docker（可用 target.type 覆盖）」 */
  readonly reason: string
}

// 置信度档位

/**
 * 档位 = 证据有多难被巧合凑出来。
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

// 路径匹配

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

// 探测器

function sortUnique(paths: readonly string[]): readonly string[] {
  return [...new Set(paths)].sort()
}

/**
 * 列出候选。**一个 kind 最多一个候选** —— docker 的两条证据（compose / Dockerfile）合并成同一个候选，见 docker 那一支。
 *
 * @param input 注入的源条目与 package scripts 名字
 * @returns 候选列表，按置信度从高到低；同一 kind 只会出现一次
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

// 仲裁

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
 */
function noEvidenceError(input: DetectInput): DpError {
  return new DpError('DP.CONFIG.INVALID', '探测不到目标类型：源里没有任何可识别的证据', {
    path: 'target.type',
    hint:
      `看到的文件：${describeSeen(input)}。显式写 target.type（${implementedList()}）告诉 dp 用哪一种；` +
      '探测不出来时 dp 不猜 —— 猜错就是部署到了错误的目标类型',
  })
}

/**
 * 仲裁：候选 → 唯一的 target.kind。
 *
 * @param input 注入的探测输入
 * @param pick 'auto' 按置信度选（并列报错）/ 'fail' 只接受唯一命中
 * @returns 选中的 kind、证据、落选原因与人话解释
 * @throws DpError 无证据、命中未实现类型，或 auto 下最高分并列
 */
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
