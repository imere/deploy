import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: ['**/build/**', '**/dist/**', '**/node_modules/**', '.tmp/**', 'docs/**', 'build/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
    // scripts/ 下的门禁脚本是命令行工具，打印就是它们的输出，不受这条约束。
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
)
