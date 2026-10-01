# AGENTS.md

deploy-kit：把目录/文件通过 rsync / scp / ssh 部署到本地或远端（nginx、docker、systemd 等）。
pnpm 单仓多包，包名前缀 `@dp/*`。**Node ≥ 24**。

## 铁律

0. **永不交互。** 任何命令都不允许等待人类输入——弹窗 = 这次自动化是假的，且在 CI 里表现为永久挂起。
   - git 远程操作一律 `GIT_TERMINAL_PROMPT=0`；**推送必须显式带凭据**，不要先把 token 从 remote 摘掉再 push
   - ssh 走密钥：`-o BatchMode=yes -o IdentitiesOnly=yes -o NumberOfPasswordPrompts=0`
   - ssh 走密码：`SSH_ASKPASS=<助手> SSH_ASKPASS_REQUIRE=force` + `< /dev/null`
   - 所有子进程必须有 `timeout` 兜底

1. **不臆测能力，先实测。** 目标机上"看起来有"的东西不等于能用（例：`command -v su` 有，但 busybox su 缺 suid 位，实际失败）。
2. **歧义靠拒绝，不靠默认值。** source 路径写法、多 target 命中 —— 无法判定时报错并给出可选写法，绝不猜。
3. **安全不让步**：路径归一化 + 允许根校验、显式 mode、传输后哈希校验、主机密钥默认 strict、凭据不进日志。
4. **临时文件一律进 `.tmp/`**，不得散落仓库。
5. **所有产物进 `build/`**（含覆盖率）；包的 `files` 只写 `dist`，不直接写 `build`。
6. **文档保持精炼**，改代码顺手改对应文档，不新增说明性 markdown。

## 命令

```
pnpm build      # 构建，产物 build/packages/<pkg>/dist
pnpm test       # 测试 + 覆盖率 → build/coverage
pnpm lint --fix # lint（--fix 是 flag，不另建脚本）
pnpm typecheck
pnpm doc        # 文档/图集
```

## 目录

```
packages/       @dp/* 各包（schema / ports / core / transport / transfer / target-* 等）
docs/           设计文档（★ 优先读：spikes.md failures.md decisions.md diagrams.md）
agents/skills/  可复用的操作流程
.tmp/           临时物（已 gitignore）
build/          构建与测试产物（已 gitignore）
```

## 架构要点（改动前先读）

- **分层**：`schema`（类型/define\*）→ `ports`（接口）→ `core`（编排）→ 实现包 → `cli`
- **偏好链**：transport / jump / transfer / supervisor 都是候选链，全失败时输出结构化错误（每项原因 + 建议）
- **护栏层**：目标机状态日志 + 带租约的部署锁 + 两阶段激活 `trial→promote`；unit 必须注入 `MemoryMax`/`StartLimitBurst`/`Restart=on-failure`
- **抗量子**：ssh2 **不支持**，只能靠 `native-ssh` 驱动；密码登录用 `SSH_ASKPASS`（不需要 sshpass）

## 提交

- 粒度：一处结论/一个包一次提交，不要攒大批
- 消息：`类型: 简述`（feat / fix / docs / test / refactor / chore）
- 推送后把 remote URL 改回不带 token 的形式

## 测试靶机

需要真 SSH 目标时用 podman 起容器，见 `agents/skills/dp-spike-env/SKILL.md`。
