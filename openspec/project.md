# 项目上下文

deploy-kit：把目录或文件部署到静态目录 / nginx / docker / systemd / 裸进程目标的命令行工具与库。目标可以在远端也可以在本机，传输方式自动协商，失败自动回滚。

## 技术栈

- TypeScript strict，Node ≥ 24，构建用 `tsc -b`（composite）
- pnpm workspace，15 个 `@dp/*` 包，统一版本（`private: true`，changesets 推导版本与 CHANGELOG）
- 测试用 Node 内置 `node --test`，跑的是**构建产物**不是源码；lcov 落 `build/coverage/`
- 零运行时依赖（`ssh2` 是可选依赖，运行时按需加载）

## 分层依赖方向

`ports` → `schema` → `core` → `local` / `ssh` → `transport` → `target-*` → `cli`

- `core` 不知道 ssh 存在，它只认 `Runner` 端口
- `plan()` 是纯函数：`(config, facts) → steps`，不做任何 IO
- 跨包 import 必须在同包 package.json 里声明过（由 `check-deps` 门禁守着）

## 约定

- 命令一律 argv，`quoteArg` / `quoteArgv` 是 shell 转义的唯一出口
- 默认值保守：`--delete`、覆盖非托管文件、prune 旧版本、`knownHosts: none`、不抗量子的连接，都要显式打开
- 永不交互：不弹凭据窗、不等 stdin、所有子进程带超时
- 能力靠实证探测，不靠 uid 或版本号推断

## 行为契约在哪

`openspec/specs/<capability>/spec.md` —— 每条需求带可验证的场景。改行为前先看那里；`README.md` 只讲怎么用。
