# 决策清单

每条给**决策 / 理由 / 落点**。

## 0 · 永不交互（压过以下全部）

起因：push 用了不带 token 的 remote，触发凭据管理器弹 GUI 手点 —— 有弹窗即非自动化，CI 里即永久挂起。决策：不等人类输入。

|机制|落地|
|---|---|
|凭据带外|git / ssh（密钥与密码）凭据带外给足，不满足即报错；flag 见 `AGENTS.md` 铁律 0|
|prompt 嗅探|远端吐出未预期提示符（密码 / sudo / 主机密钥确认三类，表可扩展）→ 杀进程报 `DP.INTERACTIVE_PROMPT_DETECTED`|
|超时兜底|连接 / exec / 传输 / 验收 / hook 均带 `timeout`；挂起 = 失败|

推论：`sudo` 先 `sudo -n` 探免密，需密码用 `sudo -S -p ''` 投喂；主机密钥策略预置（`strict` / `accept-new`），不许 `yes/no` 确认。

## 3 · runtime profile × supervisor

决策：正交的 runtime profile（画像）× supervisor（进程管理层）。`runtime`：`node`/`java`/`python`/`static`/`docker`/`other`，每 profile 给 detect 证据、build 命令、产物形态、健康检查、资源预算与 unit 模板默认值；`service.managers` 可多配，按探测激活实际存在的那个（CentOS 6 只有 sysvinit、Alpine 是 OpenRC、容器里可能都没有）。

Java 检 `pom.xml`/`build.gradle`/`*.jar`，`MemoryMax=Xmx×1.35`；Python 检 `requirements.txt`/`pyproject.toml`/`Pipfile`/`poetry.lock`/`uv.lock`，venv + gunicorn/uvicorn 入口。

落点：**未实现** —— `service.managers` 与 `@dp/target-service` 未落地；现状只到探测层：`@dp/core`/`@dp/local`/`@dp/ssh`，守护在 `@dp/target-systemd`/`@dp/target-process`。

## 4 · 每段一个 `define*`

顶层段各有同名 `define*`（identity function，只给类型推导与可选即时校验），18 个名字见 `@dp/schema` 导出。落点：`dp schema --out` 出 JSON Schema。

## 5 · 传输偏好链与四个驱动

`resolveChain(kind, candidates)` 也用于 jump / supervisor / runtime / target / lsm。四驱动：`rsync`（两端都要，增量，首选）/ `tar-ssh`（远端 tar/gzip，宿主无 rsync 时）/ `sftp`（需子系统，兜底）/ `scp`（**只需 exec 权限**，sftp 被禁时的最后手段）。

失败抛 `DP.PREF.UNSUPPORTED`（`path=transport.preferred`）：message 逐项列名与失败原因，`hint` 给可执行出路，`--json` 可读；已落地于传输协商。理由：多跳与抗量子都无法用单一实现覆盖。

## 7 · 结构化日志与 OTel 对齐

`@dp/log` 输出 JSONL，核心不依赖 OTel 包但字段对齐其约定（`ts`/`level`/`msg`/`deployId`/`host`/`phase`/`span`/`attempt`），桥接交给 `@dp/log-otel`；脱敏：密码、私钥、token 按 key 名 + 值模式识别，命中即 `***`；`--log-format=json|pretty|logfmt`、`--log-level`、`--log-file`。理由：重依赖不进核心。

## 8 · 通知 / Hook 扩展

生命周期事件 + 驱动注册表，payload 是脱敏后的结构化事件。

|项|取值|
|---|---|
|事件|`pre-resolve` `pre-connect` `post-connect` `pre-transfer` `post-transfer` `pre-activate` `post-activate` `on-verify` `on-promote` `on-failure` `on-rollback`|
|驱动|`exec`（本地命令）、`webhook`、`email(smtp)`、`js`（用户函数）|
|必配|`onFailure: 'abort'|'warn'|'ignore'`（默认 `warn`）、`timeout`|

## 9 · 跨平台命令：wrapper + 覆盖

|层|做法|
|---|---|
|抽象动作|常见操作用动作名表示（`ensureDir` `setMode` `setOwner` `symlink` `remove` `serviceReload` `configTest`），平台映射表翻译|
|shell 适配|远端 shell 可能是 `sh/bash/zsh/powershell/cmd` —— 引号按目标 shell 生成，不许手工拼串（安全相关）|
|用户覆盖|`commands.overrides.perPlatform: { linux, darwin, win32 }` 或按 `osFamily`/`distro` 细化|

## 10 · SELinux

`@dp/lsm` 包，驱动 `selinux`/`apparmor`/`none`。上下文不对 → nginx 读不了（**chmod 0777 也没用**），须 `restorecon -R`；非标端口 `semanage port -a -t http_port_t -p tcp 8080`；反代 `setsebool -P httpd_can_network_connect 1`。预检查 `getenforce`、`ls -Z`、`semanage port -l`；`semanage` 缺失须给建议。

## 12 · 支持 ssh_config

`@dp/ssh-config` 解析 `~/.ssh/config`（含 `Include`）：`Host`/`HostName`/`Port`/`User` 直映射；`IdentityFile`→privateKey；`ProxyJump`→jump 链；`ProxyCommand` 形如 `ssh -W`/`nc` 转内部实现，否则报错；`StrictHostKeyChecking`/`UserKnownHostsFile`→主机密钥策略；`KexAlgorithms`/`Ciphers`→cryptoPolicy。只在 `native-ssh` 透传；`ssh2` 下不支持的指令必须报错。

## 14 · 故障边界

→ `docs/failures.md`。结论不是重写架构，而是加**护栏层** + 三机制：目标机状态日志、带租约的部署锁、两阶段激活 `trial→promote`。

## 15 · `./dist` 还是 `./dist/**`

歧义靠拒绝，不靠默认值 —— 报错给出两种写法的预览差异。理由：rsync 的 `src` vs `src/` 是老陷阱，猜不如让它无法被误写。

|写法|语义|
|---|---|
|`"./dist"`|目录本身 → `<dest>/dist/...`|
|`"./dist/**"`|目录内容 → `<dest>/...`（不含 dist 这层）|
|`"./dist/*"`|下一层内容（不递归）|
|`"./dist/"`|❌ 报 `DP.SOURCE.AMBIGUOUS`，提示改用前两种|
|`"./dist/**/*.js"`|递归匹配 .js|

## 16 · 安全加固

基线（同 `AGENTS.md` 铁律 3）：路径归一化 + allowlist、显式 `mode`（文件 `0640`、目录 `0750`，拒 `0777`/`0666`）、临时目录 `0700`、传输后 sha256、主机密钥默认 `strict`（`knownHosts: none` 须显式打开并被 `dp check --security` 列出）、凭据不进日志（`SSH_ASKPASS` 助手 `0700` 用完即删）。

|面|做法|
|---|---|
|TOCTOU|校验与写入间不重新解析路径：先 `open` 拿 fd 再校验 fd|
|目录链|从根逐级校验 owner + 可写性，基准「owner == 布局所有者」而非 root（见 `openspec/specs/privilege-layout/spec.md`）；必检带外脚本所在代码域（`DP.SEC.RESCUE_UNSAFE_PATH`）与状态目录（伪造租约锁 = 可用性攻击）。**是预检项**|
|代码/数据分离|被 root 定时执行的代码与可变数据不得同目录；状态值只作参数 + allowlist 校验，永不 `eval`|

## 17 · 测试全面性

纯函数夹具、真实 IO、错误路径断言之上**再加三层**；覆盖率 → `build/coverage/`。

|层|做法|
|---|---|
|故障注入|`<容器运行时>` 靶机注入（`AllowTcpForwarding no`、`busybox su`、磁盘写满、只读目录、crash loop、断网）；`<容器运行时>` 按环境选 docker / podman 其一|
|契约|固化 spike 结论：rsync `--rsh` argv 契约、`%h` 不替换、不经 shell、scp `-O` 兼容|
|矩阵|六维全组合：`{linux,darwin,win32,freebsd}` × `{systemd,sysvinit,openrc,launchd,winsvc,none}` × `{rsync,tar-ssh,sftp,scp}` × `{sudo,su,none}` × `{system,hybrid,user}` × `{显式,推导}`，每项均注入 Facts|

## 18 · CLI（配置指定 / 帮助 / 退出码）

|要求|内容|
|---|---|
|配置文件|`-c` > `DP_CONFIG` > 自动发现（`deploy.config.ts|js|json` 向上冒泡），冲突时明确报错|
|文档齐备|每个命令/子命令都有 `description`、`examples`、`exit codes`；`dp --help` / `dp deploy --help` / `dp deploy --help=config`；所有命令支持 `--json`|
|exit code|`0` 成功 / `1` 未知错误（或失败且已回滚）/ `2` 用法错或验证失败且已回滚（`--json` 的 `error.code` 区分）/ `3` 配置错 / `4` 缺依赖|
|`dp explain`|打印有效配置（含来源文件与行号）（未实现）|

## 19 · 产物目录与 scripts

原则：能加 flag 就不新建脚本，该是测试的就写成测试；不设 dev/typecheck/format/doc/release 分身。布局：每包产物进 `packages/<pkg>/build/`（`files` 指到它），根 `build/` 只放 `coverage/` 与 `bin/`，不进发布包。

## 20 · 所有包统一版本

`pnpm-workspace.yaml` + changesets **`fixed` 分组**一次性 bump 全部包；`dp version` 可查看。起始 `0.0.0-alpha`：包全 `private: true`，没上过 npm，从 `0.0.0` 起步等于声称已发正式版。

一致性由 `scripts/check-versions.mjs` 卡：所有包 `version` 须一致，不一致直接红。

## 22 · 仓库约定

根目录 `AGENTS.md` 只收一手约定（仓库约定、命令、目录职责、提交规范）；`.agents/skills/` 只放可复用的操作流程。临时物一律进 `.tmp/`；提交节奏为 spike 结论落地即提交一次；凭据不入库：PAT 只在推送时用，随后把 remote URL 改回不带 token 的形式。

## 24 · 运行时兼容：Node ≥24 与 deno / bun

|层面|结论|
|---|---|
|我们自己|只承诺 Node ≥24（`engines.node`、`.nvmrc`、`dp doctor` 校验；node: 内建模块 + TS）|
|用户项目是 deno/bun|✅ 支持：detector 识别 `deno.json`/`bun.lockb`/`bun.lock`，调用 `deno task build`/`bun run build`|
|部署产物|无论什么运行时都是静态文件 → 后续链路一致|

理由：部署工具关心「产物」而非构建工具；不承诺把 deploy-kit 自身跑在 deno/bun 上。Node 仍要 24 是为 API 一致性，不是抗量子门槛（ssh2 未实现 PQC）。

## 25 · release 目录推导与跨平台路径

推导但规则明示：候选序列是**导出常量**（文档列全），有序 `canWrite` 取首个通过者；plan 打印候选 + 跳过原因 + 最终选择；选定后写入状态索引沿用，**永不静默回退**；`release.root` 可覆盖且照样实证。

跨平台差异不止分隔符：大小写敏感性、Windows 保留名/非法字符/长度上限（260）、软链权限、SIP（macOS）、home/临时目录与服务定义位置。四条路径预检**在宿主环境就能查**（码见 `docs/failures.md`：`DP.PATH.CASE_COLLISION`/`RESERVED_NAME`/`TOO_LONG`/`ILLEGAL_CHAR`）；WSL `/mnt/<drive>` 同按 Windows 规则。

## 26 · 单文件可执行产物

结论：用运行时自带的单文件可执行能力把命令行打成一个文件，目标机不必预装运行时。明确不做：压缩壳、反调试、塞依赖树 —— 那是分发工程。

|问题|决定|理由|
|---|---|---|
|用第三方打包器吗|不用|自带能力跟着 Node 走，不会有版本断档|
|跨平台怎么出|各平台各出一次（CI 矩阵）|跨注入要先取别家运行时二进制并验完整性|
|外部工具进包吗|不进|ssh / rsync / tar / scp 由运行时找；进包要做版本合规|
|产物算构建成功吗|跑通自检才算|只生成文件就成功会把跑不起来的产物当交付物|
|产物放哪、入库吗|`build/bin/`，不入库|产物统一进 build|
|注入时报「签名已损坏」|正常，不是失败|塞 blob 必使原签名失效；要签名就在注入后重签|
|什么时候发 Release|只有推 `v*` 标签|构建与发布同一流水线，发出的即刚自检通过的产物|

## 27 · 依赖布局：junction 补链

结论：`pnpm-workspace.yaml` 不写 `nodeLinker`（保持 isolated），缺的顶层链接由 `postinstall` 用 junction 补 —— 明细见 `AGENTS.md`。要点：这类环境 symlink 被写成 0 字节文件而 junction 可用；要补 workspace 包**和**根的直接依赖（只补 workspace 包时 eslint 链接仍消失）；已有链接不动；不写 `allowBuilds`。

## 28 · 目标产物：值在渲染期烘进脚本

结论：unit 与启停脚本里不出现运行期位置参数 —— 命令、参数、环境变量、工作目录、落点全在渲染期写死，执行时只跑 `sh <文件>`。

|问题|决定|理由|
|---|---|---|
|命令与落点怎么传|渲染期烘进脚本|回滚要跑上一版**实际部署出去**的脚本；传位置参数 = 用新命令跑旧目录|
|留位置参数吗|不留|运行期值覆盖渲染期值时无判据说哪个有效|
|unitDir 从哪来|上层按 scope 实测可写性推导后注入|目标机路径不是配置项；推不出可写目录报 `DP.PERM.UNIT_DIR_NOT_WRITABLE`|
|接 pm2 / supervisord 吗|不接|它们要进目标机依赖清单，「没装 pm2」会被报成「打包漏了东西」|
|停止进程怎么算成功|信号 → 优雅期 → 强杀 → 再查一次|进程不可中断或 pid 被复用时 KILL 未必收走它|
|systemd 的 restart 默认|`on-failure` 而非 `always`|正常退出（含 0）不该被无限重启|
|覆盖范围|只管 service unit|timer / socket / path 各有生命周期语义|

## 附 · 与 Terraform / Ansible 的关系

||Terraform|Ansible|deploy-kit（本）|
|---|---|---|---|
|干什么|供给基础设施|配置/编排主机状态|发布产物到已存在的机器|
|模型|声明式 IaC，plan/apply|声明期望状态，幂等|事务式发布，版本化 + 原子切换|
|传输|不传文件|传文件（无增量同步）|rsync 增量 / 断点续传|
|发布事务|无|无原生 release 概念|release 目录 + 原子切换 + 回滚点|
|类型安全|HCL|YAML|TS 类型 + `define*` 提示|
|依赖|云端 API|Python + SSH|零目标端依赖（tar/sftp/scp 兜底）|

是上下游：Terraform 造机器 → Ansible 装环境 → deploy-kit 发应用；output 可直接喂 hosts。借鉴：两段式 plan/apply → `dp plan`/`dp deploy`；`--check`、`--limit`、`handler/notify`、`vault`、`tags`。不借鉴目标端装 Python。补 Ansible 没做好的：增量传输、事务性发布、护栏注入、两阶段激活、抗量子协商策略。
