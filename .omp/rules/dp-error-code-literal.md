---
description: 源码里写 DP.* 错误码字面量
condition:
  - "'DP\\.[A-Z]"
globs: ["packages/**/*.ts", "tools/**/*.ts", "tests/**/*.mjs"]
scope: "tool:edit, tool:write"
interruptMode: always
---
错误码只许引用 @dp/ports 导出的常量：import { ERR } from '@dp/ports' 后写 ERR.族.名；告警标记（只进 warnings 与文案、不进 DpError.code 的）用同包的 WARN。登记表里没有的码，先登记进 packages/ports/src/index.ts 再引用。例外只有登记表文件本身（packages/ports/src/index.ts）。
