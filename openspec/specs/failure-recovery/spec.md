# Failure Recovery Specification

## Purpose

定义部署过程中失败时的补偿、状态判定与需要人工介入时的报告方式。

## Requirements

### Requirement: 已经自动补偿过的失败不再补一次

系统 MUST 识别那些在执行过程中已经完成回退的失败，MUST NOT 对其再执行一次回退。

#### Scenario: 健康检查未通过且已自动指回上一版

- **WHEN** 部署因健康检查未通过而失败，且该失败前已把当前指针指回上一版
- **THEN** 不再执行回退，并在结果里说明本次已自动回退

#### Scenario: 其它失败

- **WHEN** 失败类型不属于已自动补偿的那一种
- **THEN** 执行一次回退，并把回退是否成功记入结果

### Requirement: 回退失败必须升级为需要人工介入

回退本身失败时，系统 SHALL 把结果标记为需要人工介入，MUST NOT 报成部署已干净回滚。

#### Scenario: 回退未完成

- **WHEN** 部署失败且随后的回退也失败
- **THEN** 结果带一条需要人工介入的告警，说明环境处于部分回退状态，并给出发布根位置

#### Scenario: 退出码取更严重的那次

- **WHEN** 部署与回退各自对应不同严重程度的退出码
- **THEN** 最终退出码取两者中更严重的那个

### Requirement: 回滚后的健康状态要如实报告

系统 SHALL 在回滚完成后的验证结果里区分「已回退且可用」与「已回退但不可用」。

#### Scenario: 回退目标不健康

- **WHEN** 回退完成但退回的版本验证未通过
- **THEN** 结果标记为需要人工介入，且不再自动切换

### Requirement: 演练模式不产生副作用

演练模式 SHALL 只产出将要执行的动作，MUST NOT 写入目标机或改变指针。

#### Scenario: 演练遇到文件尚未上传

- **WHEN** 演练过程中出现文件缺失这一类预期内的检查失败
- **THEN** 它被记录为说明信息并继续演练，不被当作部署失败

#### Scenario: 演练遇到其它失败

- **WHEN** 演练过程中出现不属于上述类别的失败
- **THEN** 该失败按正常错误上报，不被吞掉

### Requirement: 传输目标与安装暂存目录不一致即报错

系统 MUST 在传输落点与安装阶段使用的暂存目录不一致时报错，MUST NOT 继续安装。

#### Scenario: 两处算出的暂存路径不同

- **WHEN** 传输层与安装阶段推导出不同的暂存路径
- **THEN** 报错指出不一致的具体路径，不开始安装

### Requirement: 执行器给出的恢复步骤要完整带出

执行器附在失败上的恢复步骤 SHALL 原样呈现给用户，MUST NOT 在传递过程中丢失。

#### Scenario: 失败带有恢复步骤

- **WHEN** 失败对象上附有逐条的恢复建议
- **THEN** 结果里按顺序列出这些建议

### Requirement: 配置错不被报成部署失败

系统 SHALL 按失败发生的阶段给出对应的错误类别，MUST NOT 把配置类问题归并成部署执行失败。

#### Scenario: 传输方式未实现

- **WHEN** 配置的提权方式尚未接入传输层
- **THEN** 报配置类错误并指明该配置项，不进入执行阶段

### Requirement: 故障边界靠护栏层兜底

系统 SHALL 以护栏层承载故障边界，而不是重写执行架构。护栏层由三个机制组成：目标机状态日志、带租约的部署锁、两阶段激活（trial → promote）。

#### Scenario: 目标机处于未知状态

- **WHEN** 一次部署开始时目标机上留有上次部署的痕迹
- **THEN** 目标机状态日志能说明上次停在哪一步，本次据此决定续作或清场

#### Scenario: 两个部署同时到达同一台目标机

- **WHEN** 第二个部署试图进入已被持有的部署锁
- **THEN** 它被挡下并拿到持锁者信息，不与第一个部署交叉写盘

### Requirement: 故障分类表

每码稳定，hook / 通知 / 文档 / 测试共用。`packages/ports` 有一条断言钉住「能抛的码都在册」，故这是代码与规范的同一份名单。反向不成立：「预留（未实现）」是设计期骨架，无包抛出，只许收敛。

读法：处置列默认 abort（零副作用终止），只写附加动作与理由；预检列 = 能否在失败前拦住（是 / 否 / 部分）；抛出方留空 = 同上一行。

|code|阶段|预检|处置|抛出方|
|---|---|---|---|---|
|`DP.CONN.*`|连接|是||预留（未实现）|
|`DP.AUTH.*`|认证|是|||
|`DP.TIMEOUT.*`|任意|否|挂起=失败（`DP.TIMEOUT.EXEC` 已落地）||
|`DP.DISK.INSUFFICIENT` / `DP.DISK.INODE_EXHAUSTED` / `DP.DISK.NOT_WRITABLE`|预检|是|||
|`DP.PERM.*` / `DP.LSM.SELINUX_*`|预检|是|或 auto-remedy||
|`DP.PORT.OCCUPIED`|预检|是|或 `portPolicy`||
|`DP.FILE.LOCKED`|传输/激活|部分|||
|`DP.LOCK.HELD`|并发|是|打印持锁者||
|`DP.TRANSFER.INTERRUPTED`|传输|否|幂等重试后仍失败才退||
|`DP.TRANSFER.CHECKSUM_MISMATCH`|传输|否|staging 作废||
|`DP.VERIFY.HEALTH_TIMEOUT`|验收|否|回滚（trial 自动过期）||
|`DP.RESOURCE.OOM_KILLED`|运行期|否|不 abort：护栏兜底 + 通知||
|`DP.GUARD.TRIAL_EXPIRED`|运行期|否|不 abort：自动停用 + 切回||
|`DP.DISK.FULL_RUNTIME`|运行期|否|不 abort：通知 + 可选 prune||
|`DP.INTERACTIVE_PROMPT_DETECTED`|任意|是|立即杀进程|`@dp/local` / `@dp/transport` / `@dp/ssh`|
|`DP.TIMEOUT.EXEC`|任意|否|挂起=失败||
|`DP.PATH.ILLEGAL_CHAR`|源校验|是|零副作用：还没传第一个字节|`@dp/core` / `@dp/ssh`|
|`DP.PATH.NOT_WRITABLE`|发布根|否|实证写入得知，不靠 uid 推断；列全部候选授权其一|`@dp/core` / `@dp/local` / `@dp/ssh`|
|`DP.CONFIG.INVALID`|配置|是|歧义靠拒绝：列候选与排除办法，不猜默认值|`@dp/schema` / `@dp/core` / `@dp/cli`|
|`DP.PERM.CONFD_NOT_WRITABLE`|装配|是|零写入即退，不猜路径（nginx confd）|`@dp/cli`|
|`DP.PERM.UNIT_DIR_NOT_WRITABLE`|装配|是|零写入即退（unitDir 按 scope 分候选）||
|`DP.STATE.INCONSISTENT`|运行期|是|打印索引现状，不静默改 current（`dp rollback`）||
|`DP.CLI.INTERNAL`|任意|否|通用 hint + 保留原始 message（非 `DpError` 兜底）||
|`DP.VERIFY.FAILED`|验收|否|带读到的实际状态，是否回滚由上层定（`dp apply`）|`@dp/cli` / `@dp/transport` / 各 `@dp/target-*`|
|`DP.TPL.UNKNOWN_VAR`|渲染|是|绝不留下 `${x}` 原文|`@dp/template`|
|`DP.TPL.MISSING_ENV` / `DP.TPL.MISSING_VALUE`|渲染|是|空值同缺值；路径塌成 `/srv//` 中途才暴露||
|`DP.TPL.SYNTAX`|渲染|是|未闭合 / 嵌套||
|`DP.TPL.UNSAFE_VALUE`|渲染|是|按落点 text/path/shell/conf 分档||
|`DP.NGX.CONF_INVALID`|conf 渲染|是|不产出 conf，更不写目标机|`@dp/target-nginx`|
|`DP.NGX.UNSAFE_VALUE`|conf 渲染|是|值带 conf 边界字符 = 注入指令||
|`DP.NGX.NOT_MANAGED` / `DP.SYSD.UNIT_NOT_MANAGED`|覆盖|是|同名文件不带 `# managed by dp`，需 `force`|各 `@dp/target-*`|
|`DP.NGX.RELOAD_CMD_INVALID`|生效|是|命令不是 argv[]，照传会静默改语义||
|`DP.NGX.TEST_FAILED`|生效|是|还原备份并再验一次，原话进 stderr||
|`DP.NGX.RELOAD_FAILED`|reload|否|不回滚：conf 已过 `-t`，重跑 reload 即收敛||
|`DP.DOCKER.MODE_UNSUPPORTED`|装配|是|不静默降到 remote-cli（否则以为构建过了）|`@dp/target-docker`|
|`DP.DOCKER.PROJECT_NAME_INVALID`|装配|是|项目名是容器/网络名前缀，字符集由 compose 收紧||
|`DP.DOCKER.COMPOSE_FILES_EMPTY`|装配|是|不带 `-f` 的 up 会去当前目录找文件||
|`DP.DOCKER.COMPOSE_FILE_DUPLICATED`|装配|是|重复 `-f` 后覆盖前，顺序取决于数组||
|`DP.DOCKER.COMPOSE_FILE_INVALID`|装配|是|绝对路径 / `..` 逃逸 / 反斜杠 / 空段||
|`DP.DOCKER.FILE_MISSING`|装配|否|compose/envFile 经 `stat` 实证不在 release 目录，一次列全||
|`DP.DOCKER.PULL_FAILED`|激活|否|不回滚：只动镜像缓存，跑着的仍是上一版||
|`DP.DOCKER.PS_PARSE_FAILED`|验收|否|读不出结论 ≠ 健康，空输出也报错||
|`DP.DOCKER.PLAN_MISMATCH`|任意|—|当作代码错误抛（plan 与执行器不同步）||
|`DP.ACTIVATE.START_FAILED`|激活|否|回滚到上一版（现唯一抛出点）||
|`DP.SYSD.UNIT_INVALID`|unit 渲染|是|不产出 unit 行，更不写 unitDir|`@dp/target-systemd`|
|`DP.SYSD.TEST_FAILED`|校验|是|候选只在影子目录，unitDir 未被碰||
|`DP.SYSD.DAEMON_RELOAD_FAILED` / `DP.SYSD.ENABLE_FAILED` / `DP.SYSD.RESTART_FAILED`|生效|否|不回滚 unit：unit 是好的，缺的只是被读到 / 开机自启软链 / 服务自身能起||
|`DP.SYSD.NOT_ACTIVE` / `DP.PROC.NOT_RUNNING`|验收|否|unit 不在 active / pid 不存在|`@dp/target-systemd` / `@dp/target-process`|
|`DP.NGX.NO_PREVIOUS` / `DP.DOCKER.NO_PREVIOUS` / `DP.SYSD.NO_PREVIOUS` / `DP.PROC.NO_PREVIOUS`|回滚|是|无上一版可还原（首版，或已被 prune），不返回假成功|各 `@dp/target-*`|
|`DP.PROC.COMMAND_INVALID`|脚本渲染|是|不产出脚本，更不启进程|`@dp/target-process`|
|`DP.PROC.START_FAILED`|激活|否|旧进程已停新进程没起 → 服务空窗||
|`DP.PROC.STOP_FAILED`|激活|否|优雅期后强杀仍失败；不起新版本，否则两实例抢同一端口||
|`DP.PATH.CASE_COLLISION`|源校验|是|仅大小写不同的路径，在 Windows 上是同一个文件|`@dp/core`|
|`DP.PATH.RESERVED_NAME`|源校验|是|Windows 保留名，如 `NUL` / `CON`||
|`DP.PATH.TOO_LONG`|源校验|是|超平台路径上限，传到一半才炸||
|`DP.LAYOUT.MISMATCH`|布局|是|显式 layout 与实测能力不符||
|`DP.LINK.UNAVAILABLE`|激活|否|软链不可用，原子切换无从谈起|`@dp/target-static`|
|`DP.PREF.UNSUPPORTED`|传输协商|是|不静默降级：不可用就直说，暗换等于改行为|`@dp/transport`|
|`DP.SOURCE.EMPTY`|源枚举|是|连目标机之前就知道，此时零代价|`@dp/transport` / `@dp/cli`|
|`DP.SSH.CONNECT_FAILED`|连接|否|零副作用|`@dp/ssh`|
|`DP.SSH.AUTH_FAILED`|认证|否|含 `SSH_ASKPASS` 取密码失败||
|`DP.SSH.HOST_KEY_UNKNOWN`|主机密钥|否|绝不静默接受未知主机密钥 —— 那是 MITM 的入口||
|`DP.SSH.HOST_KEY_MISMATCH`|主机密钥|否|要么真换机器要么被劫持，都不能自动放过||
|`DP.SSH.TOOL_MISSING`|能力探测|否|远端缺 rsync / tar 等，靠实测而非版本号猜||
|`DP.SSH.DRIVER_UNAVAILABLE`|驱动选择|否|native-ssh 与 ssh2 都不可用；不退化成「假装连上」||
|`DP.SSH.TUNNEL_FAILED`|多跳|否|`ProxyJump` / `ProxyCommand` 都建不起来||
|`DP.SSH.HOP_FAILED`|多跳|否|第 N 跳没通，`path` 给第几跳；已建好的跳逆序关掉不留孤儿会话||

#### Scenario: 新增错误码

- **WHEN** 实现里新增一个能抛出的错误码
- **THEN** 它必须同步登记进本表，能抛的码与本表是一份名单

#### Scenario: 预留码只许收敛

- **WHEN** 表里某个预留（未实现）的码被实现了
- **THEN** 它从预留转为在册的实抛码，而不是另立新码
