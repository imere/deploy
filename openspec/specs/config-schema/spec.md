# Config Schema Specification

## Purpose

配置怎么被校验、不合法时报什么，以及怎么导出给编辑器用的 JSON Schema。

## Requirements

### Requirement: 校验失败要带出配置路径

系统 MUST 在每条校验错误里给出出错字段的完整配置路径。

#### Scenario: 深层字段类型不对

- **WHEN** 某个嵌套字段写成了别的类型
- **THEN** 错误里带有形如 `projects.web.source.root` 的完整路径

#### Scenario: 数组元素出错

- **WHEN** 出错的是数组里的某一项
- **THEN** 路径里带该项下标，能定位到具体那一项

### Requirement: 错误要说明实际是什么类型

系统 SHALL 在错误里说明期望类型与实际拿到的类型，而不是只说「不合法」。

#### Scenario: 字符串写进数字字段

- **WHEN** 数字字段收到带引号的数字
- **THEN** 错误说明期望数字、实际是字符串

#### Scenario: 对象写进数组字段

- **WHEN** 数组字段收到一个对象
- **THEN** 错误说明期望数组、实际是对象，不因对象有下标而当成数组

### Requirement: 可选值在错误里给出

枚举字段校验失败时，系统 SHALL 在错误里列出全部可选值。

#### Scenario: 枚举值不在白名单

- **WHEN** 枚举字段收到白名单之外的值
- **THEN** 错误里带有全部可选值

#### Scenario: 枚举判定严格相等

- **WHEN** 枚举字段收到的值与某个可选值只差尾部空格或大小写
- **THEN** 判定为不合法，不做 trim 或大小写折叠

### Requirement: 不做隐式类型转换

系统 MUST NOT 把字符串转成数字、把真假值字符串转成布尔。

#### Scenario: 带引号的数字

- **WHEN** 数字字段收到 `'8080'`
- **THEN** 判定为不合法，不转成数字 8080

#### Scenario: 布尔字符串

- **WHEN** 布尔字段收到 `'false'`
- **THEN** 判定为不合法，不按真假值转换成 false

### Requirement: 数字必须是有限数

数字字段 MUST 拒绝非有限数。

#### Scenario: 收到 NaN

- **WHEN** 数字字段收到 NaN
- **THEN** 判定为不合法

#### Scenario: 收到 Infinity

- **WHEN** 数字字段收到 Infinity
- **THEN** 判定为不合法

### Requirement: 对象与映射拒绝 null

对象类字段 MUST 拒绝 null，不把它当成空对象。

#### Scenario: 对象字段收到 null

- **WHEN** 对象字段收到 null
- **THEN** 判定为不合法

#### Scenario: 映射字段收到 null

- **WHEN** 键值对映射字段收到 null
- **THEN** 判定为不合法

#### Scenario: 数组不能被当成对象

- **WHEN** 对象字段收到一个数组
- **THEN** 判定为不合法

### Requirement: 偏好链接受单值或列表两种写法

传输方式这类偏好字段 SHALL 同时接受单个值与有序列表两种写法，并统一成列表。

#### Scenario: 写成单个值

- **WHEN** 偏好字段写成单个字符串
- **THEN** 解析为只含一项的列表

#### Scenario: 写成有序列表

- **WHEN** 偏好字段写成列表
- **THEN** 解析结果保持该顺序

#### Scenario: 链内出现不支持的项

- **WHEN** 列表里有不在支持范围内的项
- **THEN** 报错，且路径指出是第几项

#### Scenario: 缺省链不参与校验

- **WHEN** 该字段取缺省值
- **THEN** 不因缺省值未显式写出而报错

### Requirement: 配置里只接受真会生效的字段

系统 SHALL 拒绝没有任何实现消费的配置项，MUST NOT 接受后静默忽略它。

#### Scenario: 点名了没有可执行实现的类型

- **WHEN** 显式指定了某种目标类型，而该类型没有对应的执行实现
- **THEN** 校验期报错并列出可指定的类型，不按其它类型部署

#### Scenario: 类型与它自己的配置段不一致

- **WHEN** 点名的类型没有对应的配置段，或配置段与点名的类型对不上
- **THEN** 校验期报错，指出两者必须一致，不静默按另一种类型执行

### Requirement: 能导出 JSON Schema

系统 SHALL 导出完整配置的 JSON Schema，供编辑器做补全与校验。

#### Scenario: 导出

- **WHEN** 运行 schema 导出命令
- **THEN** 输出一份可被编辑器直接引用的 JSON Schema

#### Scenario: 枚举与错误提示同源

- **WHEN** 某字段是枚举
- **THEN** 导出的 Schema 里该字段的可选值与校验错误里给出的可选值一致

### Requirement: 同一配置多处来源的优先级固定

配置可来自多个来源时，系统 SHALL 按固定优先级合并，且优先级可被查证。

#### Scenario: 同名配置出现在多处

- **WHEN** 同一项在多个来源里都有值
- **THEN** 按既定优先级取其一，结果可预测

### Requirement: 最少三个字段即可部署

系统 SHALL 让 `source.root`、`hosts`、`release.root` 三个字段之外的全部配置可选，每层能力独立开关。源根写法 `./dist` 连目录本身、`./dist/**` 只放内容，语义由源选择层定义（→ openspec/specs/source-selection/spec.md）。

#### Scenario: 最简配置

- **WHEN** 配置只给出 `projects.<id>.source.root`、`projects.<id>.hosts` 与 `projects.<id>.release.root`
- **THEN** 校验通过，可执行 `dp deploy <项目名>`

#### Scenario: 默认值保守

- **WHEN** 评估某个未显式打开的破坏性能力（删除多余文件、覆盖非托管文件、清理旧版本）
- **THEN** 默认不执行，必须显式开关才会发生

### Requirement: 字段只有一个定义点

字段 SHALL 只在 `@dp/schema` 的自研 DSL（`packages/schema/src/config.ts`）里定义，TS 类型、运行时校验与 JSON Schema 由它派生；系统 MUST NOT 在别处再写一份字段定义。

#### Scenario: 同名字段出现第二份定义

- **WHEN** 某个包想自己声明一份同形字段定义
- **THEN** 它从 `@dp/schema` 派生或引用，不复制定义

### Requirement: 顶层段各有同名 define* 辅助

系统 SHALL 为每个顶层配置段导出同名 `define*` 辅助函数（identity function，只提供类型推导与可选的即时校验），名称由 `@dp/schema` 导出。

#### Scenario: 用 define* 写配置

- **WHEN** 用户以 `defineConfig` / 各段 `define*` 包裹配置对象
- **THEN** 编辑器拿到完整类型推导，校验与直接对象写法一致

#### Scenario: 导出 JSON Schema

- **WHEN** 运行 `dp schema --out <路径>`
- **THEN** 输出完整配置的 JSON Schema 文件

### Requirement: 配置文件自动发现与显式指定

系统 SHALL 自动发现 `deploy.config.ts` / `deploy.config.js` / `deploy.config.json`（沿目录向上冒泡），并允许 `--config` 显式指定；显式指定与自动发现冲突时报错而不是暗选。文件与对象两种来源 SHALL 走同一份 schema。

#### Scenario: 未指定 --config

- **WHEN** 当前目录及上层存在配置文件
- **THEN** 自动发现并加载它

#### Scenario: JSON 配置的编辑器支持

- **WHEN** 用户运行 `dp schema` 拿到 JSON Schema
- **THEN** 可把它绑定到编辑器的 `deploy.config.json` 校验设置

#### Scenario: 不收元键

- **WHEN** 配置里出现 `$schema` 之类的元键
- **THEN** schema 拒绝未知字段，不静默忽略

### Requirement: profile 只覆写 hosts

系统 SHALL 让 `profiles.<env>` 只含 `hosts` 一个键；release / transport / activation / target 各段 MUST NOT 随环境变化。未给 `--env` 时 MUST 存在明确的默认 profile，否则报错。

#### Scenario: 指定环境部署

- **WHEN** 运行 `dp deploy web --env prod`
- **THEN** `profiles.prod.hosts` 以就近覆盖语义并入，其余段不变

#### Scenario: 没有默认 profile 且未指定 --env

- **WHEN** 配置里有多个 profile 但没有声明默认，命令也未给 `--env`
- **THEN** 报错要求明确环境，不猜一个

#### Scenario: 一次推整个环境

- **WHEN** 运行 `dp apply --all --env prod`
- **THEN** 按主机扇出推送每个项目；`dp plan --all` 以同口径先出计划

### Requirement: 变量插值的命名空间固定

系统 SHALL 只支持以下插值命名空间：`${env.X}`（环境变量）、`${git.sha}` / `${git.branch}` / `${git.tag}`（宿主环境 Git 状态）、`${release.id}` / `${release.current}`（plan 期解析）、`${project}` / `${env}` / `${now}`（上下文变量）。凭据只写引用（`env:NAME`），scheme 只有 `env:` 一种。

#### Scenario: 引用环境变量

- **WHEN** 配置值里写 `${env.DEPLOY_URL}`
- **THEN** 渲染期以该环境变量的当前值替换

#### Scenario: 凭据不写明文

- **WHEN** 配置里需要密码或 token
- **THEN** 只写 `env:NAME` 形式的引用，渲染时从环境变量取值

### Requirement: 主机与多跳字段参考

`hosts.<id>` 字段如下（`defaults.hosts` / `profiles.<env>.hosts` 同形状，不重复列出）：

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ssh` | string | — | user@host[:port] |
| `hops[]` | hop[] | — | 末跳是目标机 |
| `hops[].ssh` | string | — | 必填 |
| `hops[].auth.type / identityFile` | key / agent, string | agent | 跳板不用密码；私钥 |
| `hops[].knownHosts` | strict/accept-new/tofu/off | — | 密钥策略 |
| `hops[].port` | number | — | 1–65535 |
| `local` | boolean | — | 本地目标 |
| `become.type` | none/sudo/su/doas/custom | none | 不提权合法 |
| `become.user` | string | — | 提权到谁 |
| `become.method` | auto/nopasswd/stdin/pty | auto | 取密码方式 |
| `become.passwordRef` | string | — | `env:NAME` |
| `become.preserveEnv` | boolean | false | 保留环境变量 |
| `become.template` | string | — | 必含 `${cmd}` |
| `layout` | auto/system/user | auto | 路径由能力推导 |
| `transport.strategy` | 链 rsync/tar-ssh/sftp/scp/local | rsync,tar-ssh,sftp,scp | 报 `DP.PREF.UNSUPPORTED` |
| `transport.delete / compress` | boolean, auto/none/gzip/zstd | false / auto | 删多余文件 / 压缩 |

约束：`ssh` 与 `hops` 二选一，同时给出即报错；`hops` 一跳一个条目、最后一跳是目标机，`hops: []` 按「没给」处理；`hops[].port` 与串内端口冲突报错；`become.template` 除 `${cmd}` 外出现 `${` 被拒。native-ssh（`-o ProxyJump=`）只约束当跳板的那几跳：跳板只能 `key` / `agent`，不能单独设 `knownHosts`。ssh2 逐跳 direct-tcpip：逐跳认证可逐跳用密码，但凭据绝不向下继承；不支持抗量子 KEX；跳板禁 TCP 转发时失败，可开 `allowNcHopFallback` 用 `nc` 兜底（默认关）。未落地的字段（`crypto`、连接层 `timeouts`、抗量子）不在 schema 里，写了即被拒。

#### Scenario: ssh 与 hops 同时给出

- **WHEN** 同一台主机既写 `ssh` 又写 `hops`
- **THEN** 校验报错说明二选一

#### Scenario: 跳板带密码认证

- **WHEN** 某一跳的 `auth.type` 写了密码类取值
- **THEN** 校验报错：跳板只能 key / agent

### Requirement: 多主机扇出语义

系统 SHALL 让 `projects.<id>.hosts` 缺省时投向全部主机，每台主机算一条独立 plan 并共用同一 `releaseId`，以便跨机对齐版本与回滚。候选主机多于一台时 MUST 显式指定 `--host` 才能查单机状态。

#### Scenario: 投向全部主机

- **WHEN** 项目未写 `hosts`
- **THEN** 部署扇出到配置里的每一台主机

#### Scenario: 同一版本重跑某台

- **WHEN** 某台主机上该 `releaseId` 已存在
- **THEN** 该台跳过上传，直接参与 activation

#### Scenario: 查单机当前版本

- **WHEN** 运行 `dp status --host <id>` 且该 `releaseId` 存在于多台
- **THEN** 返回该台当前版本；未指定 `--host` 而候选多于一台时报错

### Requirement: 目标类型字段参考

`projects.<id>` 的目标相关字段：

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `target.type` | 链 static/nginx/docker/systemd/process | static | 点名须给段 |
| `target.pick` | auto / fail | auto | 仲裁口径 |
| `target.confd` | string | 能力推导 | conf.d 目录 |

`target.type` 可取值只有 static / nginx / docker / systemd / process；pm2 / 单镜像 / caddy / k8s / delegate 不在其列。不填 `target` 时由探测层自动识别（证据表与仲裁 → openspec/specs/target-detection/spec.md）。

#### Scenario: 点名类型但没给对应段

- **WHEN** `target.type` 写了 `nginx` 但没有 `target.nginx` 段
- **THEN** 校验报错指出两者必须一致

### Requirement: nginx 目标字段参考

`target.nginx` 字段如下。conf 由 `@dp/target-nginx` 生成，不手写；`confd` 属 `target.confd`，由实测可写性推导。

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `server` | 块对象 / 块数组 | — | 必填 |
| `server[].serverName` | string[] | — | 省略 → `_` |
| `server[].listen` | (number / string)[] | — | 端口或 `443 ssl` |
| `server[].root` | string | — | 静态根 |
| `server[].index` | string[] | — | index |
| `server[].locations[].path` | string | — | 匹配串 |
| `server[].locations[].tryFiles` | string | — | try_files |
| `server[].locations[].proxy.upstream` | string | — | 后端地址 |
| `server[].locations[].proxy.websocket` | boolean | — | Upgrade 头 |
| `server[].locations[].proxy.timeouts.*` | number | — | connect/send/read 秒 |
| `server[].locations[].extra` | string[] | — | 原样输出 |
| `filename` | string | `<项目名>.conf` | 文件名 |
| `force` | boolean | — | 覆盖未标记文件 |
| `reload` | string[] / false | — | argv；false = 外部重载 |

语义：`upstream` 值里的斜杠二义即报错；`extra` 原样输出；`$host` 原样保留，字面量写 `$${x}`。生效顺序（影子目录 → 校验 → 备份 → 原子替换 → 整树复验 → reload）、覆盖保护与回滚 → openspec/specs/target-nginx/spec.md。

#### Scenario: server 块缺 root

- **WHEN** 某个 server 块未给 `root`
- **THEN** 校验报错定位到该块

### Requirement: docker 目标字段参考

`target.docker` 字段如下。本轮只实现 `remote-cli`：compose 文件随 release 上传后在目标机跑 compose CLI（`<容器运行时>` 按环境选一个 compose 兼容 CLI 代入）。

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | remote-cli | remote-cli | 余者报 `DP.DOCKER.MODE_UNSUPPORTED` |
| `compose.files` | string[] | — | 必填；相对 release 目录 |
| `compose.projectName` | string | — | 必填；`-p` 前缀 |
| `compose.envFile` | string | — | → `--env-file` |
| `compose.pull` | boolean | true | 浮动 tag 不 pull = 旧镜像 |
| `compose.wait` | boolean | true | `up --wait` |
| `healthcheck.services / expectStates` | string[] | ps 全部 / running,healthy | 只查这些服务与状态 |

语义：compose 变量由 compose 自己插值（`${VAR}` / `$$`），本工具不解释；路径须相对 release 目录且非空串，否则 `DP.DOCKER.COMPOSE_FILE_INVALID`；验收读编排级状态（`<容器运行时> compose ps --format json`），读不出结论报 `DP.DOCKER.PS_PARSE_FAILED`；`dp verify` 不通过退 2。文件缺失即不发 pull / up；activate 失败不回滚、退出码非 0。生效顺序与回滚 → openspec/specs/target-docker/spec.md。

#### Scenario: compose 文件路径是绝对路径

- **WHEN** `compose.files` 里出现绝对路径
- **THEN** 报 `DP.DOCKER.COMPOSE_FILE_INVALID`

### Requirement: systemd 目标字段参考

`target.systemd` 字段如下。unit 由 `@dp/target-systemd` 生成，不手写；`unitDir` 由可写性按 scope 推导（system → `/etc/systemd/system`，user → `~/.config/systemd/user`），推导不出报 `DP.PERM.UNIT_DIR_NOT_WRITABLE`。

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `unit` | string | `<项目名>.service` | 文件名 |
| `unitDir` | string 绝对路径 | 可写性推导 | 推导不出报 `DP.PERM.UNIT_DIR_NOT_WRITABLE` |
| `scope` | system / user | system | user 随会话存活 |
| `execStart` | string | — | 必填，非空白 |
| `workingDirectory` | string | — | WorkingDirectory |
| `environment` | record<string> | — | 环境变量 |
| `restart` | SYSTEMD_RESTART_POLICIES | on-failure | 正常退出不重启 |
| `restartSec` | number | — | RestartSec 秒 |
| `after` | string[] | — | After 名 |
| `wantedBy` | string | multi-user.target | WantedBy |
| `enabled` | boolean | true | 是否 enable |
| `extra` | string[] | — | 原样，含换行被拒 |

语义：`enabled: false` 只跳 enable（`DP.SYSD.ENABLE_FAILED` 是 enable 跑不动）；只覆盖 `# managed by dp`，否则 `DP.SYSD.UNIT_NOT_MANAGED`（需 `force`）；回滚还原 `<unit>.dp-backup`，无备份报 `DP.SYSD.NO_PREVIOUS`。生效顺序与覆盖保护 → openspec/specs/target-systemd/spec.md。

#### Scenario: extra 行含换行

- **WHEN** `extra` 数组里某行含换行
- **THEN** 校验拒绝，说明那等于注入 unit 指令

### Requirement: process 目标字段参考

`target.process` 字段如下。裸进程，自带极简进程管理：pidfile 记 pid，停止先信号后强杀，存活靠 `kill -0`。`process` 没有探测证据，只能显式写 `target.type`。

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `command` | string | — | 必填；argv[0]，不经 shell |
| `args` | string[] | — | 启动参数 |
| `workingDirectory` | string | current 软链 | 工作目录 |
| `env` | record<string> | — | 环境变量 |
| `stopSignal` | PROCESS_STOP_SIGNALS | SIGTERM | 不含 SIGKILL |
| `stopTimeoutMs` | number | 10000 | 优雅期上限 |
| `pidFile / stdoutLog` | string | — | 相对发布根；日志落盘 |

语义：脚本跟版本目录（`<release>/.dp/`），pid 与日志在发布根固定位置；所有值在渲染期烘进脚本，运行期只跑 `sh <脚本>`，只渲染一半会让 `${release.current}` 变成字面文本；停止脚本强杀后再查一次；回滚跑上一版实际部署的脚本，不在报 `DP.PROC.NO_PREVIOUS`。生效顺序（先停旧再起新，旧的不停就不起新的）→ openspec/specs/target-process/spec.md。

#### Scenario: 未显式指定 process 目标

- **WHEN** 源清单没有可识别的探测证据而用户想要 process 目标
- **THEN** 必须显式写 `target.type: process`，探测层不会推出它

### Requirement: 覆盖优先级链固定

系统 SHALL 按以下优先级合成主机段配置，后者胜出：

```text
schema 默认值（withDefault） < defaults.hosts[<id>] < hosts[<id>] < profiles.<env>.hosts[<id>]
```

合成只发生在 hosts 一段（连接层随环境变），在一处实现；项目段没有环境覆写层。`--config` / `--env` / `--project` / `--host` / `--all` 做的是选择与路由，不是值覆盖。`dp plan` 打出布局、发布根、步数与能力候选。

#### Scenario: 三层都写了同一字段

- **WHEN** `defaults.hosts[prod].transport.compress`、`hosts[prod].transport.compress` 与 `profiles.staging.hosts[prod].transport.compress` 同时存在且 env 为 staging
- **THEN** 取 `profiles.staging` 的值

#### Scenario: 项目段不存在环境覆写

- **WHEN** 试图给 `projects.<id>` 找环境覆写层
- **THEN** 不存在这一层，项目段只有一份

### Requirement: 项目字段参考

`projects.<id>` 字段如下（`transport.*` 同 `hosts.<id>.transport`，项目级覆盖）：

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `source.root` | string | — | 必填；不以分隔符结尾 |
| `source.include / exclude` | string[] | — | 包含 / 排除模式 |
| `hosts` | string[] | 全部主机 | 不写则投全部 |
| `release.root` | string | 能力推导 | 发布根 |
| `release.keep` | number | 5 | 保留版本数 |
| `release.shared` | string[] | — | 跨版本共享路径 |
| `release.owner` | string | — | 属主 |
| `release.dirMode / fileMode` | string | — | 目录 / 文件权限 |
| `release.switchStrategy` | auto/symlink/copy | auto | 切换方式 |
| `healthcheck.command` | string | — | 退出码 0 健康 |
| `healthcheck.http` | {path, expectStatus, port} | — | expectStatus 200 |
| `healthcheck.tcp` | {port} | — | port 必填 |
| `healthcheck.fileExists` | string[] | — | 必须存在的路径 |
| `healthcheck.timeoutMs / intervalMs` | number | 5000 / 2000 | 超时 / 轮询间隔 |
| `activation.mode` | trial-promote / direct | trial-promote | 先起验过再切 |
| `activation.trialTimeout` | string | 10m | trial 超时 |
| `activation.autoPromote` | when-healthcheck-passes/never/always | when-healthcheck-passes | 无 healthcheck 则 never |
| `activation.promoteConsecutivePasses` | number | 3 | 通过次数 |
| `activation.promoteWindow` | string | 30s | 时间窗 |

说明：`withDefault` 字段输入可省、输出必有值，「默认」即该值，`—` = 不给就没有；偏好链可写单值或数组；字段速查可从 `dp schema` 反查（`node scripts/dump-schema-fields.mjs`，schema 改过就重跑）。

#### Scenario: release.keep 显式给 0

- **WHEN** 配置写 `release.keep: 0`
- **THEN** 按保留一版处理（见版本清理规则）

#### Scenario: activation.autoPromote 依赖 healthcheck

- **WHEN** 配了 when-healthcheck-passes 但没有定义任何 healthcheck
- **THEN** 按 never 处理
