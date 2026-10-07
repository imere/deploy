/**
 * smoke 门禁里可以独立验证的那一块：产物文本的分类判定、manifest 入口解析、产物归属。
 *
 * 单独成模块是为了让它能被 `node --test` 直接断言。门禁脚本的判据一旦没有回归测试，
 * 判据被改坏（放宽到抓不住、或误伤夹具）不会有任何东西变红 —— 而它恰恰是
 * 「谁来验验证者」的那条链。IO（读盘、import 产物、算仓库根）留在 smoke.mjs 入口，
 * 这里只收「输入一段文本，输出它落进哪个桶」。
 *
 * 三个桶的语义完全不同，混起来就是事故：凭据命中即失败；绝对路径只报告、永不影响判失败；
 * 不可读只报告。理由写在各自判定处，不在文件头。
 */

/**
 * 本机绝对路径。产物里出现它**通常**意味着构建把开发机环境编进去了 ——
 * 「通常」两个字是有代价的，代价见下面扫描段的说明：这一类只报不判。
 *
 * 前置断言 (?<![A-Za-z0-9_]) 是必须的：没有它 `https://` 里的 `s:/` 会被当成
 * 盘符路径，于是每个带 URL 的产物都误报 —— 误报的检查等于没有检查。
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
 *
 * 按行扫而不是整篇扫：命中要报行号给人去看，且整篇扫时一条跨行的假命中无法定位。
 * `re.lastIndex = 0` 每行都重置 —— 模式是带 `g` 的模块级常量，带状态的正则在
 * 循环里复用是最典型的「第二次跑结果不一样」，而门禁只会让人重跑一次门禁，
 * 没人会去比对两次的门禁输出。
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
 * 疑似本机绝对路径命中。这一类**只报不判**。
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
 * 两个数组分开返回而不是混成一份 hits，是因为「混」正是要防的坏法 ——
 * 下游一旦拿一份列表再自己判断严重性，判错的分支迟早有人写成「一律判失败」。
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
 * 这个文件是不是测试产物。测试产物不是发布产物：它们的字符串字面量里天然躺着
 * 脱敏 token 与示例路径（凭据脱敏要的就是「长得像真 token 的假 token」），
 * 判它等于判夹具本身有罪。
 *
 * 判据是文件粒度而不是字面量语境 —— 见 `scanArtifact`。
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
 * 为什么夹具的豁免放在文件粒度、而不是按 `example` / `dummy` / `fixture` 这类
 * 变量名或注释语境去放行单个字面量：语境判断要读懂周边代码，而产物扫描能拿到的
 * 只有一行字符串 —— 同名的假 token 与真的泄漏 token 在这一行里长得一模一样。
 * 一旦开语境白名单，真泄漏只要把变量叫成 `example` 就直接放行，这是拿判失败换
 * 少几次误报，方向反了。测试产物的字面量天然是假的（它们只为脱敏与断言服务），
 * 所以豁免整个文件是可靠的；反过来，产物里出现的这类 token 一律按真凭据处理。
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
 * 只有凭据一类是 `fail`。绝对路径命中即便数量再多也不参与 —— 让只报信号的一类
 * 参与失败判定，会出现「包红了但没有任何可执行的修法」，下一个人只会去改本来对的代码。
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
 * 为什么优先 exports：exports 才是解析期真正生效的那份，main 只在无 exports 时兜底。
 * 硬编码 `build/index.js` 等于把「入口叫什么」在两处各写一遍 —— 改名时 smoke
 * 还在测一个已经不存在的文件，或者反过来漏测新入口。
 *
 * 每个分支都落到 `null` 而不是猜一个 `build/index.js`：解不出来是 manifest 写错了，
 * 猜出来的入口只会让 smoke 去测一个跟发布无关的文件，报「通过」。
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
 * 从仓库相对路径取包名。认两种分隔符：产物路径是 `path.relative` 的产物，
 * 在 Windows 上带反斜杠，只切 `/` 会把整条路径当成包名，回灌时找不到属主 ——
 * 找不到属主的那条命中就既不判失败也不出现在任何包名下，等于凭空消失。
 *
 * @param {string} rel 仓库相对路径
 * @returns {string | undefined} `packages/<name>/…` 的 `<name>`
 */
export function pkgOf(rel) {
  return rel.split(/[\\/]/)[1]
}

/**
 * 把任意抛出值压成一行可读文本。带 `code` 时把 code 拼在前面：只报 message 会把
 * `ENOENT` 与 `EACCES` 这类「同一个 message、不同可执行修法」的情况说成同一个。
 *
 * @param {unknown} err 捕获到的值
 * @returns {string}
 */
export function describeError(err) {
  const code = err && typeof err === 'object' && 'code' in err ? err.code : null
  const msg = err instanceof Error ? err.message : String(err)
  return code ? `${code}: ${msg}` : msg
}