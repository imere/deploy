/**
 * 跨包依赖声明的判据。
 *
 * 为什么要有这一门：`packages/<pkg>/src` 里写了 `import ... from '@dp/x'`，
 * 而 `packages/<pkg>/package.json` 没声明 `@dp/x`，在本机不会有任何症状 ——
 * postinstall 的 `link-workspace.mjs` 会用 junction 把 workspace 包全链进根
 * `node_modules/@dp/`，于是解析得到；到了 pnpm 的 isolated 布局（Linux runner
 * 就是它）只链接声明过的依赖，tsc 直接 TS2307，CI 才第一次红。
 *
 * 这类「本机绿、CI 红」的代价特别高：它不在本地任何一道门禁的视野里，
 * 只能等推送之后由 runner 发现。所以判据只做一件事 —— 逐个包比对
 * 「源码里 import 了哪些 @dp/*」与「package.json 声明了哪些」。
 */

/**
 * 一个包声明了哪些依赖。
 *
 * 三类都算声明过：`dependencies`（运行时）、`devDependencies`（测试与构建）、
 * `peerDependencies`（由使用方提供）。少算任何一类都会把合法用法报成违规。
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
 * 只认静态 `from '@dp/x'` 与 `import('@dp/x')`：这两类决定了 tsc 能不能解析。
 * 注释里的示例、字符串里的包名不参与 —— 它们不影响解析，报出来是噪声。
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
 * 跳过依赖自己：包内互相 import 走相对路径，而 `@dp/self` 这种自引用只在
 * 极少数包的测试里出现，它需要的是 exports 字段而不是依赖声明。
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
