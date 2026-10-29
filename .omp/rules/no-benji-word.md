---
description: 禁止「本机」二字
condition: "本机"
globs: ["**/*.md", "**/*.ts", "**/*.mjs", "**/*.json"]
scope: "tool:edit, tool:write"
interruptMode: always
---
「本机」换成「宿主环境」「目标机」「当前环境」，按语义选一个。这条约定覆盖注释、文档、README、skill 的全部产出物——描述运行环境时指明角色（谁在跑命令、谁被部署），不指代某台具体的电脑。
