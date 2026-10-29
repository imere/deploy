# 项目上下文

deploy-kit：把目录或文件部署到静态目录 / nginx / docker / systemd / 裸进程目标的命令行工具与库。目标可以在远端也可以在宿主环境，传输方式自动协商，失败自动回滚。

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
- 测试在纯函数夹具、真实 IO、错误路径断言之上再加三层：故障注入（`<容器运行时>` 靶机注入 `AllowTcpForwarding no`、busybox su、磁盘写满、只读目录、crash loop、断网等；`<容器运行时>` 按环境选 docker / podman 其一）、契约测试（固化 spike 结论：rsync `--rsh` argv 契约、`%h` 不替换、不经 shell、scp `-O` 兼容）、六维矩阵（`{linux,darwin,win32,freebsd}` × `{systemd,sysvinit,openrc,launchd,winsvc,none}` × `{rsync,tar-ssh,sftp,scp}` × `{sudo,su,none}` × `{system,hybrid,user}` × `{显式,推导}`，每项注入 Facts）；覆盖率落 `build/coverage/`
- 能加 flag 就不新建脚本，该是测试的就写成测试；不设 dev/typecheck/format/doc/release 分身。每包产物进 `packages/<pkg>/build/`（`files` 指到它），根 `build/` 只放 `coverage/` 与 `bin/`，不进发布包
- 根目录 `AGENTS.md` 只收一手约定（仓库约定、命令、目录职责、提交规范）；`.agents/skills/` 只放可复用的操作流程。临时物一律进 `.tmp/`；spike 结论落地即提交一次；凭据不入库——PAT 只在推送时用，随后把 remote URL 改回不带 token 的形式

## 定位

与 Terraform / Ansible 是上下游而非竞争：Terraform 造机器（声明式 IaC，plan/apply，不传文件）→ Ansible 装环境（声明期望状态，幂等，传文件但无增量同步）→ deploy-kit 发应用（事务式发布：release 目录 + 原子切换 + 回滚点，rsync 增量 / 断点续传，零目标端依赖——tar/sftp/scp 兜底，TS 类型 + `define*` 提示）。Terraform output 可直接喂 hosts。借鉴：两段式 plan/apply 对应 `dp plan` / `dp deploy`；`--check`、`--limit`、handler/notify、vault、tags。不借鉴目标端装 Python。补两者没做好的：增量传输、事务性发布、护栏注入、两阶段激活、抗量子协商策略。

## 行为契约在哪

`openspec/specs/<capability>/spec.md` —— 每条需求带可验证的场景。改行为前先看那里；`README.md` 只讲怎么用。
