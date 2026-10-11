# 故障分类表

每个故障有稳定 code，供 hook、通知、文档与测试用例共同引用。`packages/ports` 有一条断言把「每个能抛出的码都在册」钉住，所以这张表是代码与文档共用的同一份名单。

| code | 阶段 | 可预检 | 默认响应 | 谁负责 |
|---|---|---|---|---|
| `DP.CONN.*` | 连接 | ✅ | abort（零副作用） | `@dp/transport` |
| `DP.AUTH.*` | 认证/提权 | ✅ | abort | `@dp/transport` |
| `DP.INTERACTIVE_PROMPT_DETECTED` | 任意 | ✅ | **立即杀进程并 abort** | `@dp/transport` |
| `DP.TIMEOUT.*` | 任意 | ❌ | abort（挂起=失败） | 全局超时兜底 |
| `DP.DISK.INSUFFICIENT` | 预检 | ✅ | abort | `@dp/preflight` |
| `DP.DISK.INODE_EXHAUSTED` | 预检 | ✅ | abort | `@dp/preflight` |
| `DP.DISK.NOT_WRITABLE` | 预检 | ✅ | abort | `@dp/preflight`（**实证写入**） |
| `DP.PERM.*` / `DP.LSM.SELINUX_*` | 预检 | ✅ | abort 或 auto-remedy | `@dp/preflight` + `@dp/lsm` |
| `DP.PERM.CONFD_NOT_WRITABLE` | 装配 | ✅ | abort（**一个字节都没写就退**，不猜路径） | `@dp/cli`（`dp apply`，nginx 目标的 confd 推导） |
| `DP.PORT.OCCUPIED` | 预检 | ✅ | abort（或 `portPolicy`） | `@dp/preflight` |
| `DP.FILE.LOCKED` | 传输/激活 | ⚠️ |  | `@dp/target-*` |
| `DP.LOCK.HELD` | 并发 | ✅ | abort + 打印持锁者 | `@dp/core` |
| `DP.STATE.INCONSISTENT` | 运行期 | ✅ | abort + 打印索引现状（**不**静默改动 current） | `@dp/cli`（`dp rollback`） |
| `DP.TPL.UNKNOWN_VAR` | 配置渲染 | ✅ | abort（**绝不留下 `${x}` 原文**） | `@dp/template` |
| `DP.TPL.MISSING_ENV` | 配置渲染 | ✅ | abort（空值同缺值处理） | `@dp/template` |
| `DP.TPL.MISSING_VALUE` | 配置渲染 | ✅ | abort（同上：路径塌成 `/srv//` 要到中途才暴露） | `@dp/template` |
| `DP.CONFIG.INVALID` | 配置加载/装配 | ✅ | abort（**歧义靠拒绝**：列出候选与排除办法，不猜一个默认值继续跑） | `@dp/schema` / `@dp/core` / `@dp/cli` |
| `DP.TPL.SYNTAX` | 配置渲染 | ✅ | abort（未闭合 / 嵌套） | `@dp/template` |
| `DP.TPL.UNSAFE_VALUE` | 配置渲染 | ✅ | abort（按落点 text/path/shell/conf 分档） | `@dp/template` |
| `DP.NGX.CONF_INVALID` | conf 渲染 | ✅ | abort（**不产出 conf**，更不写目标机） | `@dp/target-nginx` |
| `DP.NGX.NOT_MANAGED` | conf 覆盖 | ✅ | abort（同名文件不带 `# managed by dp`，需 `force`） | `@dp/target-nginx` |
| `DP.NGX.UNSAFE_VALUE` | conf 渲染 | ✅ | abort（值带 conf 边界字符 = 注入指令） | `@dp/target-nginx` |
| `DP.NGX.RELOAD_CMD_INVALID` | conf 生效 | ✅ | abort（命令不是 argv[]，照传会静默改变语义） | `@dp/target-nginx` |
| `DP.NGX.NO_PREVIOUS` | 回滚 | ✅ | abort（首次部署无上一版可还原，不报假成功） | `@dp/target-nginx` |
| `DP.NGX.TEST_FAILED` | conf 生效 | ✅ | 还原备份并**再验一次**；原话进 stderr（处置：按它改配置重来） | `@dp/target-nginx` |
| `DP.NGX.RELOAD_FAILED` | reload | ❌ | **不回滚**：盘上 conf 已过 `-t`，重跑 reload 即收敛（与上一行处置相反，故单列） | `@dp/target-nginx` |
| `DP.DOCKER.MODE_UNSUPPORTED` | 装配 | ✅ | abort（**不按 remote-cli 静默降级** —— 那会让人以为镜像构建过了） | `@dp/target-docker` |
| `DP.DOCKER.PROJECT_NAME_INVALID` | 装配 | ✅ | abort（项目名会成为容器名/网络名前缀，字符集由 compose 收紧） | `@dp/target-docker` |
| `DP.DOCKER.COMPOSE_FILES_EMPTY` | 装配 | ✅ | abort（不带 `-f` 的 up 会去当前工作目录找文件） | `@dp/target-docker` |
| `DP.DOCKER.COMPOSE_FILE_DUPLICATED` | 装配 | ✅ | abort（重复 `-f` 后面的覆盖前面的，生效顺序取决于数组） | `@dp/target-docker` |
| `DP.DOCKER.COMPOSE_FILE_INVALID` | 装配 | ✅ | abort（绝对路径 / `..` 逃逸 / 反斜杠 / 空段） | `@dp/target-docker` |
| `DP.DOCKER.PS_PARSE_FAILED` | 验收 | ❌ | **abort 而非判通过**（读不出结论 ≠ 健康；空输出/坏行一律报错） | `@dp/target-docker` |
| `DP.DOCKER.NO_PREVIOUS` | 回滚 | ✅ | abort（首次部署无可回退版本，**不返回假成功**） | `@dp/target-docker` |
| `DP.DOCKER.FILE_MISSING` | 装配（install） | ❌ | abort（compose 文件/envFile 由 `stat` 实证不在 release 目录里，一次列全） | `@dp/target-docker` |
| `DP.DOCKER.PULL_FAILED` | 激活 | ❌ | abort（**不回滚**：只动镜像缓存，跑着的仍是上一版） | `@dp/target-docker` |
| `DP.DOCKER.PLAN_MISMATCH` | 任意 | — | 当作**代码错误**抛（plan 与执行器不同步）；不是部署失败，按失败去回滚只会回滚一个零副作用的部署 | `@dp/target-docker` |
| `DP.PATH.CASE_COLLISION` | 源校验 | ✅ | abort（仅大小写不同的两条路径，在 Windows 上是同一个文件） | `@dp/core` |
| `DP.PATH.RESERVED_NAME` | 源校验 | ✅ | abort（Windows 保留名，如 `NUL` / `CON`） | `@dp/core` |
| `DP.PATH.TOO_LONG` | 源校验 | ✅ | abort（超出平台路径上限，传到一半才炸更贵） | `@dp/core` |
| `DP.PATH.ILLEGAL_CHAR` | 源校验 | ✅ | abort（**零副作用**：此时还没传第一个字节） | `@dp/core` / `@dp/ssh` |
| `DP.PATH.NOT_WRITABLE` | 发布根 | ❌ | abort（**实证写入**得知，不靠 uid 推断）；列出全部候选让用户授权其一 | `@dp/core` |
| `DP.LAYOUT.MISMATCH` | 布局推导 | ✅ | abort（显式指定的 layout 与实测能力不符） | `@dp/core` |
| `DP.PREF.UNSUPPORTED` | 传输协商 | ✅ | abort（**不静默降级**：偏好链里第一项不可用就直说，换一个不告之等于暗改行为） | `@dp/transport` |
| `DP.LINK.UNAVAILABLE` | 激活 | ❌ | abort（软链不可用，原子切换无从谈起） | `@dp/core` |
| `DP.SOURCE.EMPTY` | 源枚举 | ✅ | abort（**在连目标机之前**就知道，此时零代价） | `@dp/transport` / `@dp/cli` |
| `DP.SSH.CONNECT_FAILED` | 连接 | ❌ | abort（零副作用） | `@dp/ssh` |
| `DP.SSH.AUTH_FAILED` | 认证 | ❌ | abort（含 `SSH_ASKPASS` 取密码失败） | `@dp/ssh` |
| `DP.SSH.HOST_KEY_UNKNOWN` | 主机密钥 | ❌ | abort（**绝不静默接受**未知主机密钥 —— 那是 MITM 的入口） | `@dp/ssh` |
| `DP.SSH.HOST_KEY_MISMATCH` | 主机密钥 | ❌ | abort（密钥变了要么真换了机器，要么被劫持，两种都不能自动放过） | `@dp/ssh` |
| `DP.SSH.TOOL_MISSING` | 能力探测 | ❌ | abort（远端缺 rsync / tar 等，靠实测而非版本号猜） | `@dp/ssh` |
| `DP.SSH.DRIVER_UNAVAILABLE` | 驱动选择 | ❌ | abort（native-ssh 与 ssh2 都不可用；不退化成「假装连上」） | `@dp/ssh` |
| `DP.SSH.TUNNEL_FAILED` | 多跳 | ❌ | abort（`ProxyJump` / `ProxyCommand` 都建不起来） | `@dp/ssh` |
| `DP.SSH.HOP_FAILED` | 多跳 | ❌ | abort（链上第 N 跳没通；`path` 给出第几跳，已建好的跳会逆序关掉，**不留孤儿会话**；`direct-tcpip` 与 `nc` 都试过时 message 逐项列出各自原因） | `@dp/ssh` |
| `DP.TRANSFER.INTERRUPTED` | 传输 | ❌ | 幂等重试 → abort | `@dp/transfer` |
| `DP.TRANSFER.CHECKSUM_MISMATCH` | 传输 | ❌ | abort（staging 作废） | `@dp/transfer` |
| `DP.ACTIVATE.START_FAILED` | 激活 | ❌ | 回滚到上一版 | `@dp/target-service` |
| `DP.VERIFY.HEALTH_TIMEOUT` | 验收 | ❌ | 回滚（trial 自动过期） | `@dp/verify` |
| `DP.VERIFY.FAILED` | 验收 | ❌ | abort + 带上读到的实际状态；**回不回滚由上层决定**（`dp apply` 看这个码） | `@dp/target-docker`（首个实际使用方） |
| `DP.RESOURCE.OOM_KILLED` | 运行期 | ❌ | 由护栏兜底 + 通知 | guard |
| `DP.GUARD.TRIAL_EXPIRED` | 运行期 | ❌ | 自动停用 + 切回 | guard timer |
| `DP.DISK.FULL_RUNTIME` | 运行期 | ❌ | 通知 + 可选自动 prune | guard |
