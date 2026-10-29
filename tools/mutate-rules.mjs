
/**
 * 清单里的一条能否登记。
 */
const MIN_REASON_LENGTH = 1

/**
 * 校验清单形状。返回结论而不是抛错 —— 形状问题要连同上下文一起报给用户看。
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
 * @param {object[]} entries 校验通过的清单条目
 * @param {Set<string>} usedKeys 本轮命中过的 key
 * @returns {object[]} 没用上的条目
 */
export function unusedExemptions(entries, usedKeys) {
  return entries.filter((e) => !usedKeys.has(e.key))
}
