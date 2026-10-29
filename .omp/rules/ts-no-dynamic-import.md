---
description: 本仓允许动态 import（覆盖内置 ts-no-dynamic-import）
condition:
  - "(?!x)x"
globs: []
scope: "tool:edit, tool:write"
interruptMode: never
---
内置规则 ts-no-dynamic-import 在本仓不生效：动态 import 是架构决策——ssh2 是可选依赖按需加载，用户配置文件（deploy.config.ts）只能动态加载。静态 import 照常优先，但不要因这条内置规则改写既有的按需加载点。
