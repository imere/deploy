---
description: 文档章节号引用（§N / 见 xxx.md §N）
condition:
  - "§[0-9]"
  - "\\.md\\s*§"
globs: ["**/*.md", "**/*.ts", "**/*.mjs"]
scope: "tool:edit, tool:write"
interruptMode: always
---
章节号会漂移，读的人手边也没有那份文档。依据要么就地把事实写清，要么指向代码里的函数、常量或包名；跨文档指路不带章节号（文件级指向可以）。
