
/**
 * 一个包声明了哪些依赖。
 *
 * @param {object} pkgJson 该包 package.json 解析后的取值
 * @returns {Set<string>} 声明过的包名集合
 */
export function declaredDeps(pkgJson) {
  return new Set([
    ...Object.keys(pkgJson?.dependencies ?? {}),
    ...Object.keys(pkgJson?.devDependencies ?? {}),
    ...Object.keys(pkgJson?.peerDependencies ?? {}),
  ])
}

/**
 * 一段源码里 import 了哪些 `@dp/*` 包名。
 *
 * @param {string} src 源码文本
 * @returns {string[]} 被引用的包名（含 `@dp/` 前缀），按出现顺序
 */
export function importedScopedPackages(src) {
  const out = []
  const push = (name) => {
    const full = `@dp/${name}`
    if (!out.includes(full)) out.push(full)
  }
  for (const m of src.matchAll(/from\s+'@dp\/([a-z0-9-]+)/g)) push(m[1])
  for (const m of src.matchAll(/import\s*\(\s*'@dp\/([a-z0-9-]+)/g)) push(m[1])
  return out
}

/**
 * 一个包里未声明的跨包引用。
 *
 * @param {string} pkgDirName 包目录名（如 `core`）
 * @param {string} selfName 该包的包名（如 `@dp/core`）
 * @param {Map<string, string>} fileToSrc 该包源码文件 → 内容
 * @param {Set<string>} declared 该包声明过的依赖
 * @returns {{ file: string, dep: string }[]} 未声明的引用
 */
export function undeclaredImports(pkgDirName, selfName, fileToSrc, declared) {
  const bad = []
  for (const [rel, src] of fileToSrc) {
    for (const dep of importedScopedPackages(src)) {
      if (dep === selfName) continue
      if (declared.has(dep)) continue
      bad.push({ file: `${pkgDirName}/${rel}`, dep })
    }
  }
  return bad
}

/**
 * 汇总人类可读的一行违规说明。
 *
 * @param {{ file: string, dep: string }} v 一条违规
 * @param {string} pkgName 违规所在包的包名
 * @returns {string} 一行说明
 */
export function formatViolation(v, pkgName) {
  return `${v.file} —— ${pkgName} 引了 ${v.dep}，但 package.json 里没声明`
}
