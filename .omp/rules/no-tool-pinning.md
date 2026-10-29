---
description: 说明性文字里钉死具体容器工具名
condition:
  - "\\bpodman\\b"
  - "\\bdocker compose\\b"
globs: ["**/*.md"]
scope: "tool:edit, tool:write"
interruptMode: never
---
说明性文字里用 `<容器运行时>` 占位，并注明按环境选一个代入（docker / podman 这类实现的常用子命令同构）。代码与集成脚本里出现具体实现名是允许的；讲兼容性实测对比时保留具体名。
