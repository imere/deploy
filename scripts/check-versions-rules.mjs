/**
 * 版本号一致性判据 —— 单仓里所有包必须同一个版本号。
 *
 * 为什么要单独一道门禁：版本号散在 13 份 package.json 里，靠人同步一定会漏。
 * 漏了之后的表现是 `dp --version` 报一个、某个包里报另一个，而排查的人手边
 * 往往只有其中一个 —— 这道门禁把「不一致」变成构建期的红色，而不是
 * 线上某句看不懂的输出。
 */

/**
 * 各包版本号与基准不一致的那些。
 *
 * @param {{ name: string, version: string }[]} entries 各包的包名与版本号
 * @param {string} baseline 基准版本号（根的 package.json）
 * @returns {{ name: string, version: string, baseline: string }[]} 不一致的项，按包名字典序
 */
export function versionMismatches(entries, baseline) {
  return entries
    .filter((e) => e.version !== baseline)
    .map((e) => ({ name: e.name, version: e.version, baseline }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 一行人类可读的违规说明。
 *
 * @param {{ name: string, version: string, baseline: string }} v 一条不一致
 * @returns {string} 一行说明
 */
export function formatVersionViolation(v) {
  return `${v.name}：${v.version} ≠ 根版本 ${v.baseline}`
}
