---
description: 本仓允许 ReturnType 推导（覆盖内置 ts-no-return-type）
condition:
  - "(?!x)x"
globs: []
scope: "tool:edit, tool:write"
interruptMode: never
---
内置规则 ts-no-return-type 在本仓不生效：CLI 已用 ReturnType<RunContext['logger']['child']> 这类推导锚定宿主注入的类型，比手写重复签名更不易漂移。新类型仍优先显式命名。
