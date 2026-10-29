import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import importPlugin from 'eslint-plugin-import'
import jsdocPlugin from 'eslint-plugin-jsdoc'
import { defineConfig } from 'eslint/config'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import dp from './tools/eslint-plugin-dp/index.mjs'
import { publicApiByFile } from './tools/eslint-plugin-dp/public-api.mjs'

// ---------------------------------------------------------------- 分层（判据与旧门禁逐条对齐）

// 层序按**实际依赖方向**定：ports 不依赖任何包，它才是最底的一层。
// 没点名的包一律归入实现层 —— 自行切分更细的子层会让判据变成配置作者当时的理解。
const NAMED_LAYER = { ports: 1, schema: 2, core: 3, cli: 5 }
const IMPL_LAYER = 4
const layerOf = (dir) => NAMED_LAYER[dir] ?? IMPL_LAYER

// 包名以 package.json 的声明为准，目录名只作兜底；没有 package.json 的目录不参与判定。
const pkgDirs = existsSync('packages')
  ? readdirSync('packages', { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join('packages', e.name, 'package.json')))
      .map((e) => e.name)
  : []
for (const dir of pkgDirs) {
  try {
    JSON.parse(readFileSync(join('packages', dir, 'package.json'), 'utf8'))
  } catch {
    throw new Error(`packages/${dir}/package.json 解析失败 —— 分层判定读不了它，先修好再跑`)
  }
}

// 一个包只能 import 比它更低的层；同层放行（实现包之间互引是结构性需求）。
// 每个包对每个更高层的包生成一条 zone，反向跨层在 ESLint 里直接红。
const reverseZones = []
for (const from of pkgDirs) {
  for (const to of pkgDirs) {
    if (layerOf(to) <= layerOf(from)) continue
    reverseZones.push({
      target: `packages/${from}/src/**`,
      from: `packages/${to}/src/**`,
      message: `反向跨层依赖：${from}（L${layerOf(from)}）不许引用 ${to}（L${layerOf(to)}）—— 分层只能往左 import`,
    })
  }
}

// ---------------------------------------------------------------- JSDoc（只要求公共 API 面）

// 公共 API 面 = 从各包 index.ts 沿 export ... from 链可达的「文件 + 名字」。
// 程序化推导，与被替代的门禁同一口径：barrel 之外的导出是包内实现细节，不要求文档。
const publicApi = publicApiByFile('packages')
const PUBLIC_API_FILES = [...publicApi.keys()].sort()

export default defineConfig([
  {
    ignores: ['**/dist/**', '**/node_modules/**', '.tmp/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { import: importPlugin, jsdoc: jsdocPlugin, dp },
  },
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        // `const { yes: _yes, ...rest }` 是「解构时剔掉一个键」的惯用法，
        // 那个 _yes 本就是为了不被使用而声明的；下划线前缀同理（先声明后接上的参数）。
        { ignoreRestSiblings: true, varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // 日志一律走 @dp/log，脱敏在 sink 出口统一做 —— 单点 console 会绕过脱敏。
    // tools/ 下的命令行工具打印就是它们的输出，不受这条约束。
    files: ['packages/**/*.ts'],
    rules: { 'no-console': 'error' },
  },
  {
    // 测试要故意造「形状不合法」的值去证明被测代码不炸：脱敏器必须扛住任意嵌套的
    // 对象、getter 抛错的属性、Function 字段 —— `any` 与 `Function` 在这里正是要
    // 表达的东西，写成具体类型反而把被测的那件事改没了。产品代码里照旧禁止。
    files: ['**/*.test.ts', '**/*.test.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-function-type': 'off',
      'no-control-regex': 'off',
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  },

  // ---------------------------------------------------------------- 错误码硬编码
  {
    // `DP.*` 码只许引用 @dp/ports 的 ERR / WARN。选择器只认「整串就是一个码」的
    // 字面量：报错文案里引用一个码（`DP.X 没戏了：…`）不是硬编，测试标题同理。
    // 注释里的出现不算 —— ESLint 解析天然不含注释；登记表文件豁免（那里的字面量
    // 是定义，不是引用）。
    files: ['packages/**/*.ts', 'tests/**/*.mjs', 'tools/**/*.mjs'],
    ignores: ['packages/ports/src/index.ts', 'packages/ports/src/index.test.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/^DP\\.[A-Z][A-Z0-9_.]*$/]",
          message:
            '码只许引用 @dp/ports 的 ERR / WARN，未登记的码先登记进登记表 —— 字面量散在各包里，改一个码要同步几十处',
        },
        {
          selector: "TemplateElement[value.raw=/^DP\\.[A-Z][A-Z0-9_.]*$/]",
          message:
            '码只许引用 @dp/ports 的 ERR / WARN，未登记的码先登记进登记表 —— 字面量散在各包里，改一个码要同步几十处',
        },
      ],
    },
  },

  // ---------------------------------------------------------------- 依赖声明与模块结构
  {
    files: ['packages/*/src/**/*.ts'],
    languageOptions: { parserOptions: { sourceType: 'module' } },
    settings: { 'import/resolver': { typescript: { alwaysTryTypes: true } } },
    rules: {
      // import 了未在 package.json 声明的包就红：本地靠 junction 能解析，
      // pnpm isolated 布局下是 TS2307。
      'import/no-extraneous-dependencies': [
        'error',
        { devDependencies: ['**/*.test.ts'], peerDependencies: true },
      ],
      // 同一模块写两遍 import 是分叉的温床：改路径漏一处。
      'import/no-duplicates': 'error',
    },
  },
  {
    // 真机集成测试跑构建产物 CLI，根 package.json 有意不把 workspace 包收进依赖面
    //（它们不发布、也不该伪装成根的依赖），豁免声明检查。
    files: ['tests/**/*.mjs'],
    rules: { 'import/no-extraneous-dependencies': 'off' },
  },
  {
    // 分层：反向跨层直接红。测试文件豁免 —— 测试不进产物，构成不了运行时依赖。
    files: ['packages/*/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'import/no-restricted-paths': ['error', { zones: reverseZones }],
      'import/no-cycle': ['error', { ignoreExternal: true }],
    },
  },

  // ---------------------------------------------------------------- JSDoc（只要求公共 API 面）
  {
    // 全部判据收拢进 dp/require-public-jsdoc 一条规则：文件 + 符号名粒度由规则内
    // 的公共 API 面推导承担，不需要 :has 选择器连坐。jsdoc 插件的 require-* 系列
    // 只支持「文件 + AST 选择器」粒度，且 check-param-names 不认「@param options.x」
    // 子字段写法 —— 与被替代的门禁口径不合，弃用。
    files: PUBLIC_API_FILES,
    rules: {
      'dp/require-public-jsdoc': [
        'error',
        {
          // 旧门禁的 barrel 追踪有缺陷，一批公共符号从来没被检查过；这里登记的
          // 是那些实际缺文档的符号。补齐文档后从清单摘除 —— 只许缩小。
          // ssh2-module 的两个符号是 ssh2 可选依赖的类型面，本仓无法为第三方
          // 结构补文档，只能转述它是什么、为什么收进来。
          exempt: {
            'packages/runner-ssh/src/ssh2-module.ts': [
              'Ssh2ChannelLike.stderr',
              'Ssh2ModuleLike.Client',
            ],
          },
        },
      ],
      // 疑似复述只是提示，不判失败 —— 与被替代的门禁一致。
      'dp/no-restating-jsdoc': 'warn',
    },
  },

  // ---------------------------------------------------------------- 测试质量
  {
    // 假测试扫描：零断言用例、单参 assert.throws、恒等断言。
    // 空 catch 由核心 no-empty 覆盖（recommended 默认开启、allowEmptyCatch 默认 false，
    // 上面的配置没有关它）。
    files: ['packages/**/*.test.ts'],
    rules: {
      'dp/no-assertion-free-test': 'error',
      'dp/no-assert-throws-without-expected': 'error',
      'dp/no-tautological-assert': 'error',
    },
  },
])
