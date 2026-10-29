---
description: import 语句写了分号
condition: "from '[^']+';"
globs: ["**/*.ts", "**/*.mts"]
scope: "tool:edit, tool:write"
interruptMode: always
---
本仓 import 一律不写分号（ESLint 风格已固定）。去掉行尾的 ;；落盘后 post-edit hook 的 --fix 也会自动修。
