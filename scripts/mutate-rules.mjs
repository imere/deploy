/**
 * mutate 里可以独立验证的那一块：豁免清单的形状校验，以及单个变异属于哪一类结果。
 *
 * 为什么要单独成模块：判据一旦没有回归测试，判据被改坏也不会有东西变红。
 * 而它正是「谁来验验证者」这条链上的最后一环，所以这里每条分支都得能被单独断言。
 *
 * 这套机制只为一种东西存在：**等价变异**。
 * 把 `for (let i = 0; i < a.length; i += 1)` 的 `<` 换成 `<=`，而循环体只做
 * `a[i] === ''` 这种越界也安全的比较 —— 多跑的一轮取到 `undefined`，比较为假，
 * 什么都没发生。任何测试都杀不死它，因为不存在可以观测到的差别。
 * 把它留在存活分子里，等于给每周的数字掺一份固定噪声。
 */

/**
 * 清单里的一条能否登记。
 *
 * 为什么 `reason` 不许为空：写不出理由，就说明还没搞清它为什么杀不死，
 * 那时候正确的做法是让它继续留在统计里，直到有人能写明白。
 */
const MIN_REASON_LENGTH = 1

/**
 * 校验清单形状。返回结论而不是抛错 —— 形状问题要连同上下文一起报给用户看。
 *
 * 四类会被拒：`file` / `line` / `label` 三个字段缺一（合起来才唯一确定一处候选变异）；
 * `reason` 为空；同一处重复登记；`file` 不在某个包的 build 下。
 *
 * @param {unknown} data 清单文件解析后的取值
 * @returns {{ ok: boolean, entries: object[], problems: string[] }} 结论
 */
export function validateExemptions(data) {
  if (!Array.isArray(data)) return { ok: false, entries: [], problems: ['清单顶层必须是数组'] }
  const problems = []
  const entries = []
  const seenKeys = new Map()
  data.forEach((raw, i) => {
    const at = `第 ${i + 1} 条`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      problems.push(`${at}：必须是对象`)
      return
    }
    if (typeof raw.file !== 'string' || !isBuildArtifactPath(raw.file)) {
      problems.push(`${at}：file 需要是产物路径（packages/<pkg>/build/... 下的相对路径）`)
      return
    }
    if (!Number.isInteger(raw.line) || raw.line < 1) {
      problems.push(`${at}：line 需要是大于等于 1 的整数`)
      return
    }
    if (typeof raw.label !== 'string' || raw.label.trim() === '') {
      problems.push(`${at}：label 需要与 mutate 报告里的写法逐字一致`)
      return
    }
    if (typeof raw.reason !== 'string' || raw.reason.trim().length < MIN_REASON_LENGTH) {
      problems.push(`${at}：缺少 reason —— 说不清理由就别豁免`)
      return
    }
    const key = `${raw.file}:${raw.line} ${raw.label}`
    if (seenKeys.has(key)) {
      problems.push(`${at}：与第 ${seenKeys.get(key) + 1} 条撞复`)
      return
    }
    seenKeys.set(key, i)
    entries.push({ key, file: raw.file, line: raw.line, label: raw.label, reason: raw.reason })
  })
  return { ok: problems.length === 0, entries, problems }
}

/**
 * 是否落在某个包的 build 下。
 *
 * 中间那段只认单个包名（不含 `/`）：放行 `packages/a/b/build/x.js` 这种嵌套写法，
 * 等于多认了一整层路径，而本仓的包全是平铺的。
 *
 * @param {string} p 相对路径
 * @returns {boolean} 判断结果
 */
export function isBuildArtifactPath(p) {
  const m = /^packages\/([^/]+)\/build\/(.+)$/.exec(p)
  return Boolean(m) && m[1] !== '.' && m[1] !== '..' && m[2] !== ''
}

/**
 * 一条清单（或一处变异）属于哪个包。
 *
 * 用来把「清单没用上」的统计限制在本轮参与的包里：清单是全仓共享的，跑单个包时
 * 别的包的条目自然匹配不到，全量报出来会让人误以为它们失效了。
 *
 * @param {string} p 产物相对路径（packages/<pkg>/build/...）
 * @returns {string | null} 包名；路径不是产物路径时返回 null
 */
export function pkgOfArtifactPath(p) {
  if (!isBuildArtifactPath(p)) return null
  return /^packages\/([^/]+)\//.exec(p)[1]
}

/**
 * 一处变异有无登记。
 *
 * 三个字段全相等才算命中。同一行常常既有 `<` 换成 `<=` 又有 `&&` 换成 `||` 两个候选，
 * 只比位置会把另一个本该继续参加统计的候选一起豁免掉。
 *
 * @param {object[]} entries 校验通过的清单条目
 * @param {{ file: string, line: number, label: string }} mutant 一处变异
 * @returns {object | null} 命中的条目，没有则返回 null
 */
export function matchExemption(entries, mutant) {
  return entries.find((e) => e.file === mutant.file && e.line === mutant.line && e.label === mutant.label) ?? null
}

/**
 * 跑完一个变异之后的结果归类。
 *
 * 四条支路：
 *   - 未登记且还绿 → `survived`：实现被改坏而测试没反应，这正是要找的；
 *   - 未登记但变红 → `killed`；
 *   - 已登记且还绿 → `exempted`：与登记时的判断一致，不计入存活分子；
 *   - 已登记却变红 → `killed` 且 `stale` 为真：当初「杀不死」的理由已经不成立。
 *
 * @param {{ ok: boolean | null }} run 该包跑测试的结果
 * @param {object | null} exemption 清单里有没有这条
 * @returns {{ bucket: string, stale: boolean }} 归类
 */
export function classifyOutcome(run, exemption) {
  const green = run.ok === true
  if (exemption === null) return { bucket: green ? 'survived' : 'killed', stale: false }
  return green ? { bucket: 'exempted', stale: false } : { bucket: 'killed', stale: true }
}

/**
 * 清单里一次都没匹配上的条目。
 *
 * 最常见成因是源码移位：产物行号变了，条目自然落空，那一处会重新冒出来。
 *
 * @param {object[]} entries 校验通过的清单条目
 * @param {Set<string>} usedKeys 本轮命中过的 key
 * @returns {object[]} 没用上的条目
 */
export function unusedExemptions(entries, usedKeys) {
  return entries.filter((e) => !usedKeys.has(e.key))
}
