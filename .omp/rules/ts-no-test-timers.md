---
description: 本仓测试允许真定时器做清理等待（覆盖内置 ts-no-test-timers）
condition:
  - "(?!x)x"
globs: []
scope: "tool:edit, tool:write"
interruptMode: never
---
内置规则 ts-no-test-timers 在本仓不生效：node:test 没有内置 fake timers，端到端冒烟的临时目录清理在 finally 里用 setTimeout 重试是既有合法路径。除此之外测试里仍然优先不依赖真实时间。
