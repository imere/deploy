
/**
 * 本地绝对路径。产物里出现它**通常**意味着构建把开发机环境编进去了 ——「通常」两个字是有代价的，代价见下面扫描段的说明：这一类只报不判。
 */
const ABS_PATH_PATTERNS = [
  { kind: 'win-drive', re: /(?<![A-Za-z0-9_])[A-Za-z]:[\\/]/g },
  { kind: 'unix-home', re: /\/(?:home|Users)\/[A-Za-z0-9._-]+\//g },
]

/** 高置信凭据前缀。只认前缀 + 足够长的尾巴，避免把散文里的这些词当命中。 */
const SECRET_PATTERNS = [
  { kind: 'github-pat', re: /github_pat_[A-Za-z0-9_]{16,}/g },
  { kind: 'github-classic', re: /ghp_[A-Za-z0-9]{20,}/g },
  { kind: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
]

/**
 * 逐行扫一遍产物文本，把命中按「行号 + 模式名 + 原文」记下来。
 */
function scanText(text, patterns, kind, file) {
  const hits = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    for (const { kind: pattern, re } of patterns) {
      re.lastIndex = 0
      for (const m of line.matchAll(re)) {
        hits.push({ kind, pattern, file, line: i + 1, detail: m[0] })
      }
    }
  }
  return hits
}

/**
 * 疑似凭据命中。这一类是硬判据：命中即失败。
 *
 * @param {string} text 产物文本
 * @param {string} file 仓库相对路径（写进命中记录，供人定位）
 * @returns {Array<{kind: string, pattern: string, file: string, line: number, detail: string}>}
 */
export function findSecretHits(text, file) {
  return scanText(text, SECRET_PATTERNS, 'secret', file)
}

/**
 * 疑似本地绝对路径命中。这一类**只报不判**。
 *
 * @param {string} text 产物文本
 * @param {string} file 仓库相对路径（写进命中记录，供人定位）
 * @returns {Array<{kind: string, pattern: string, file: string, line: number, detail: string}>}
 */
export function findAbsPathHits(text, file) {
  return scanText(text, ABS_PATH_PATTERNS, 'abs-path', file)
}

/**
 * 分类本身：给定一段产物文本，它落进哪个桶。
 *
 * @param {string} text 产物文本
 * @param {string} file 仓库相对路径
 * @returns {{secretHits: object[], absPathHits: object[]}} 两个桶互不重叠
 */
export function classifyArtifact(text, file) {
  return {
    secretHits: findSecretHits(text, file),
    absPathHits: findAbsPathHits(text, file),
  }
}

/**
 * 这个文件是不是测试产物。测试产物不是发布产物：它们的字符串字面量里天然躺着脱敏 token 与示例路径（凭据脱敏要的就是「长得像真 token 的假 token」），判它等于判夹具本身有罪。
 *
 * @param {string} file 产物文件名或路径
 * @returns {boolean}
 */
export function isTestArtifact(file) {
  return file.endsWith('.test.js')
}

/**
 * 扫一个产物，返回它的两个命中桶，外加「这个文件整体是否被跳过」。
 *
 * @param {{file: string, text: string}} artifact 产物文件与其文本
 * @returns {{skipped: boolean, secretHits: object[], absPathHits: object[]}}
 */
export function scanArtifact({ file, text }) {
  if (isTestArtifact(file)) return { skipped: true, secretHits: [], absPathHits: [] }
  return { skipped: false, ...classifyArtifact(text, file) }
}

/**
 * 命中是否参与失败判定（回灌到包的问题表）。
 *
 * @param {{kind: string}} hit 单条命中记录
 * @returns {'fail' | 'report'} 报告类只出现在输出里，不进失败判定
 */
export function isGateFailure(hit) {
  return hit.kind === 'secret' ? 'fail' : 'report'
}

/**
 * 从 manifest 解出入口，优先级 exports > main。
 *
 * @param {{exports?: unknown, main?: unknown}} manifest 已解析的 package.json
 * @returns {string | null} 入口相对路径，解不出来给 null
 */
export function resolveEntry(manifest) {
  const exp = manifest.exports
  if (typeof exp === 'string') return exp
  if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
    const dot = exp['.']
    if (typeof dot === 'string') return dot
    if (dot && typeof dot === 'object') {
      if (typeof dot.default === 'string') return dot.default
      if (typeof dot.import === 'string') return dot.import
    }
  }
  if (typeof manifest.main === 'string') return manifest.main
  return null
}

/**
 * 从仓库相对路径取包名。认两种分隔符：产物路径是 `path.relative` 的产物，在 Windows 上带反斜杠，只切 `/` 会把整条路径当成包名，回灌时找不到属主 ——找不到属主的那条命中就既不判失败也不出现在任何包名下，等于凭空消失。
 *
 * @param {string} rel 仓库相对路径
 * @returns {string | undefined} `packages/<name>/…` 的 `<name>`
 */
export function pkgOf(rel) {
  return rel.split(/[\\/]/)[1]
}

/**
 * 把任意抛出值压成一行可读文本。带 `code` 时把 code 拼在前面：只报 message 会把`ENOENT` 与 `EACCES` 这类「同一个 message、不同可执行修法」的情况说成同一个。
 *
 * @param {unknown} err 捕获到的值
 * @returns {string}
 */
export function describeError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : null
  const msg = err instanceof Error ? err.message : String(err)
  return code ? `${code}: ${msg}` : msg
}