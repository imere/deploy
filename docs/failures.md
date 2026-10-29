# 故障分类表

每码稳定，hook / 通知 / 文档 / 测试共用。`packages/ports` 有一条断言钉住「能抛的码都在册」，故这是代码与文档的同一份名单。反向不成立：「预留（未实现）」是设计期骨架，无包抛出，只许收敛。

读法：处置列默认 abort（零副作用终止），只写附加动作与理由；预检列 = 能否在失败前拦住；抛出方留空 = 同上。

|code|阶段|预检|处置|抛出方|
|---|---|---|---|---|
|`DP.CONN.*`|连接|✅||预留（未实现）|
|`DP.AUTH.*`|认证|✅|||
|`DP.TIMEOUT.*`|任意|❌|挂起=失败（`DP.TIMEOUT.EXEC` 已落地）||
|`DP.DISK.INSUFFICIENT` / `DP.DISK.INODE_EXHAUSTED` / `DP.DISK.NOT_WRITABLE`|预检|✅|||
|`DP.PERM.*` / `DP.LSM.SELINUX_*`|预检|✅|或 auto-remedy||
|`DP.PORT.OCCUPIED`|预检|✅|或 `portPolicy`||
|`DP.FILE.LOCKED`|传输/激活|⚠️|||
|`DP.LOCK.HELD`|并发|✅|打印持锁者||
|`DP.TRANSFER.INTERRUPTED`|传输|❌|幂等重试后仍失败才退||
|`DP.TRANSFER.CHECKSUM_MISMATCH`|传输|❌|staging 作废||
|`DP.VERIFY.HEALTH_TIMEOUT`|验收|❌|回滚（trial 自动过期）||
|`DP.RESOURCE.OOM_KILLED`|运行期|❌|不 abort：护栏兜底 + 通知||
|`DP.GUARD.TRIAL_EXPIRED`|运行期|❌|不 abort：自动停用 + 切回||
|`DP.DISK.FULL_RUNTIME`|运行期|❌|不 abort：通知 + 可选 prune||
|`DP.INTERACTIVE_PROMPT_DETECTED`|任意|✅|立即杀进程|`@dp/local` / `@dp/transport` / `@dp/ssh`|
|`DP.TIMEOUT.EXEC`|任意|❌|挂起=失败||
|`DP.PATH.ILLEGAL_CHAR`|源校验|✅|零副作用：还没传第一个字节|`@dp/core` / `@dp/ssh`|
|`DP.PATH.NOT_WRITABLE`|发布根|❌|实证写入得知，不靠 uid 推断；列全部候选授权其一|`@dp/core` / `@dp/local` / `@dp/ssh`|
|`DP.CONFIG.INVALID`|配置|✅|歧义靠拒绝：列候选与排除办法，不猜默认值|`@dp/schema` / `@dp/core` / `@dp/cli`|
|`DP.PERM.CONFD_NOT_WRITABLE`|装配|✅|零写入即退，不猜路径（nginx confd）|`@dp/cli`|
|`DP.PERM.UNIT_DIR_NOT_WRITABLE`|装配|✅|零写入即退（unitDir 按 scope 分候选）||
|`DP.STATE.INCONSISTENT`|运行期|✅|打印索引现状，不静默改 current（`dp rollback`）||
|`DP.CLI.INTERNAL`|任意|❌|通用 hint + 保留原始 message（非 `DpError` 兜底）||
|`DP.VERIFY.FAILED`|验收|❌|带读到的实际状态，是否回滚由上层定（`dp apply`）|`@dp/cli` / `@dp/transport` / 各 `@dp/target-*`|
|`DP.TPL.UNKNOWN_VAR`|渲染|✅|绝不留下 `${x}` 原文|`@dp/template`|
|`DP.TPL.MISSING_ENV` / `DP.TPL.MISSING_VALUE`|渲染|✅|空值同缺值；路径塌成 `/srv//` 中途才暴露||
|`DP.TPL.SYNTAX`|渲染|✅|未闭合 / 嵌套||
|`DP.TPL.UNSAFE_VALUE`|渲染|✅|按落点 text/path/shell/conf 分档||
|`DP.NGX.CONF_INVALID`|conf 渲染|✅|不产出 conf，更不写目标机|`@dp/target-nginx`|
|`DP.NGX.UNSAFE_VALUE`|conf 渲染|✅|值带 conf 边界字符 = 注入指令||
|`DP.NGX.NOT_MANAGED` / `DP.SYSD.UNIT_NOT_MANAGED`|覆盖|✅|同名文件不带 `# managed by dp`，需 `force`|各 `@dp/target-*`|
|`DP.NGX.RELOAD_CMD_INVALID`|生效|✅|命令不是 argv[]，照传会静默改语义||
|`DP.NGX.TEST_FAILED`|生效|✅|还原备份并再验一次，原话进 stderr||
|`DP.NGX.RELOAD_FAILED`|reload|❌|不回滚：conf 已过 `-t`，重跑 reload 即收敛||
|`DP.DOCKER.MODE_UNSUPPORTED`|装配|✅|不静默降到 remote-cli（否则以为构建过了）|`@dp/target-docker`|
|`DP.DOCKER.PROJECT_NAME_INVALID`|装配|✅|项目名是容器/网络名前缀，字符集由 compose 收紧||
|`DP.DOCKER.COMPOSE_FILES_EMPTY`|装配|✅|不带 `-f` 的 up 会去当前目录找文件||
|`DP.DOCKER.COMPOSE_FILE_DUPLICATED`|装配|✅|重复 `-f` 后覆盖前，顺序取决于数组||
|`DP.DOCKER.COMPOSE_FILE_INVALID`|装配|✅|绝对路径 / `..` 逃逸 / 反斜杠 / 空段||
|`DP.DOCKER.FILE_MISSING`|装配|❌|compose/envFile 经 `stat` 实证不在 release 目录，一次列全||
|`DP.DOCKER.PULL_FAILED`|激活|❌|不回滚：只动镜像缓存，跑着的仍是上一版||
|`DP.DOCKER.PS_PARSE_FAILED`|验收|❌|读不出结论 ≠ 健康，空输出也报错||
|`DP.DOCKER.PLAN_MISMATCH`|任意|—|当作代码错误抛（plan 与执行器不同步）||
|`DP.ACTIVATE.START_FAILED`|激活|❌|回滚到上一版（现唯一抛出点）||
|`DP.SYSD.UNIT_INVALID`|unit 渲染|✅|不产出 unit 行，更不写 unitDir|`@dp/target-systemd`|
|`DP.SYSD.TEST_FAILED`|校验|✅|候选只在影子目录，unitDir 未被碰||
|`DP.SYSD.DAEMON_RELOAD_FAILED` / `DP.SYSD.ENABLE_FAILED` / `DP.SYSD.RESTART_FAILED`|生效|❌|不回滚 unit：unit 是好的，缺的只是被读到 / 开机自启软链 / 服务自身能起||
|`DP.SYSD.NOT_ACTIVE` / `DP.PROC.NOT_RUNNING`|验收|❌|unit 不在 active / pid 不存在|`@dp/target-systemd` / `@dp/target-process`|
|`DP.NGX.NO_PREVIOUS` / `DP.DOCKER.NO_PREVIOUS` / `DP.SYSD.NO_PREVIOUS` / `DP.PROC.NO_PREVIOUS`|回滚|✅|无上一版可还原（首版，或已被 prune），不返回假成功|各 `@dp/target-*`|
|`DP.PROC.COMMAND_INVALID`|脚本渲染|✅|不产出脚本，更不启进程|`@dp/target-process`|
|`DP.PROC.START_FAILED`|激活|❌|旧进程已停新进程没起 → 服务空窗||
|`DP.PROC.STOP_FAILED`|激活|❌|优雅期后强杀仍失败；不起新版本，否则两实例抢同一端口||
|`DP.PATH.CASE_COLLISION`|源校验|✅|仅大小写不同的路径，在 Windows 上是同一个文件|`@dp/core`|
|`DP.PATH.RESERVED_NAME`|源校验|✅|Windows 保留名，如 `NUL` / `CON`||
|`DP.PATH.TOO_LONG`|源校验|✅|超平台路径上限，传到一半才炸||
|`DP.LAYOUT.MISMATCH`|布局|✅|显式 layout 与实测能力不符||
|`DP.LINK.UNAVAILABLE`|激活|❌|软链不可用，原子切换无从谈起|`@dp/target-static`|
|`DP.PREF.UNSUPPORTED`|传输协商|✅|不静默降级：不可用就直说，暗换等于改行为|`@dp/transport`|
|`DP.SOURCE.EMPTY`|源枚举|✅|连目标机之前就知道，此时零代价|`@dp/transport` / `@dp/cli`|
|`DP.SSH.CONNECT_FAILED`|连接|❌|零副作用|`@dp/ssh`|
|`DP.SSH.AUTH_FAILED`|认证|❌|含 `SSH_ASKPASS` 取密码失败||
|`DP.SSH.HOST_KEY_UNKNOWN`|主机密钥|❌|绝不静默接受未知主机密钥 —— 那是 MITM 的入口||
|`DP.SSH.HOST_KEY_MISMATCH`|主机密钥|❌|要么真换机器要么被劫持，都不能自动放过||
|`DP.SSH.TOOL_MISSING`|能力探测|❌|远端缺 rsync / tar 等，靠实测而非版本号猜||
|`DP.SSH.DRIVER_UNAVAILABLE`|驱动选择|❌|native-ssh 与 ssh2 都不可用；不退化成「假装连上」||
|`DP.SSH.TUNNEL_FAILED`|多跳|❌|`ProxyJump` / `ProxyCommand` 都建不起来||
|`DP.SSH.HOP_FAILED`|多跳|❌|第 N 跳没通，`path` 给第几跳；已建好的跳逆序关掉不留孤儿会话||
