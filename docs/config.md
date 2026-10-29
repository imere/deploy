# 配置模型

> 最少三个字段即可部署；每层能力独立可选。

- **约定优于配置**：默认值保守，能推导的一律推导。
- **单一真源**：字段只在 `@dp/schema` 的自研 DSL（`packages/schema/src/config.ts`）里定义；TS 类型、运行时校验、JSON Schema 由它派生。
- **就近覆盖**：`defaults.hosts` → `hosts` → `profiles.<env>.hosts`，后者胜出。
- **默认不做破坏性动作**：`--delete`、覆盖非托管文件、清理旧版本都要显式开关。

---

## 1. 最简形态

```ts
import { defineConfig } from '@dp/schema'

export default defineConfig({
  projects: { web: { source: { root: './dist/**' }, hosts: ['prod'], release: { root: '/var/www/web' } } },
  hosts: { prod: { ssh: 'deploy@10.0.0.7' } },
})
```

`dp deploy web`。必填只有 `source.root` 与 `hosts`。`root` 写 `./dist` 连目录本身，`./dist/**` 只放内容。

---

## 2. 字段提示与 schema

自动发现 `deploy.config.ts | .js | .json`，`--config` 可指定；文件与对象走同一份 schema。

- TS / JS：直接吃 `defineConfig()` 的类型。
- JSON：跑 `dp schema` 拿 JSON Schema（`--out <路径>` 写文件），在编辑器的 JSON Schema 关联设置里绑到 `deploy.config.json`。
- 不收 `$schema` 类元键 —— schema 拒未知字段。

---

## 3. 多环境（dev / staging / prod）

### 3.1 profile：同一份配置里的差异层

```ts
profiles: { prod: { hosts: { web: { ssh: 'deploy@prod.example.com' } } } }  // 覆写位：profiles.<env>.hosts
```

`dp deploy web --env prod`。无 `--env` 时必须有明确的默认 profile，否则报错。profile 只覆写 `hosts`（`profiles.<env>` 只有 `hosts` 一个键）；release / transport / activation / target 不随环境变。

### 3.2 一次推整个环境：`--all`

`dp apply --all --env prod` 推每个项目（按主机扇出）；`dp plan --all` 同口径先出计划。

### 3.3 变量插值与 secretRef

`${env.X}` 环境变量；`${git.sha}` / `${git.branch}` / `${git.tag}` 宿主环境 Git 状态；`${release.id}` / `${release.current}` plan 期解析；`${project}` / `${env}` / `${now}` 上下文变量。凭据只写 ref（取 `env:NAME`），scheme 只有 `env:` 一种。

---

## 4. 主机与多跳、提权、传输

已落地：`ssh`、`hops`、`hops[].knownHosts`（密钥策略 strict / accept-new / tofu / off，非 known_hosts 文件路径）、`local`、`become`、`layout`、`transport`。未落地：`crypto`、连接层 `timeouts`、抗量子（由驱动偏好链决定）。

```ts
// ssh 与 hops 二选一（同时给报错）；hops 一跳一个条目，最后一跳是目标机，hops: [] 按「没给」处理
hops: [{ ssh: 'ops@jump.example.com', auth: { type: 'agent' } }, { ssh: 'deploy@10.0.0.7', auth: { type: 'key' } }]
```

- native-ssh（`-o ProxyJump=`，只约束当跳板的那几跳）：跳板只能 `key` / `agent`；不能单独设 `knownHosts`（`-J` 只有一条命令行）
- ssh2（逐跳 direct-tcpip）：逐跳认证可逐跳用密码，但**凭据绝不向下继承**；不支持抗量子 KEX；跳板禁 TCP 转发时失败，可开 `allowNcHopFallback` 用 `nc` 兜底（默认关）

> **不假设 root**：`ssh` 用户一律普通账号，`become.type: none` 是一等公民；目标机上的状态目录 / unit 目录 / confd 不是配置项，由实测能力推出 `system | user`。

---

## 5. 多主机 / 集群扇出

`projects.<id>.hosts` 不写则投向所有主机。每台主机算一条独立 plan，共用同一 `releaseId` 以便跨机对齐版本与回滚；`dp status --host <id>` 看某台当前版本，候选多于一台时 `--host` 必填；同一 `releaseId` 已存在时该台跳过上传直接参与 activation。

---

## 6. 目标类型与自动识别

不填 `target` 时走 **TargetResolver**：探测器（`@dp/core` 的 `detect.ts`）返回 `(confidence, evidence[])`，仲裁后打印理由。

探测证据 → 结论（按置信度降序）：compose 文件 90 → `docker`；`nginx.conf` 80 → `nginx`；`*.service` 60 → `systemd`；`ecosystem.config.js` 60 → `pm2`；`Dockerfile` 50 → 单镜像；`Caddyfile` 45 → `caddy`；`scripts.deploy` 40 → `delegate`；k8s 30 → `k8s`；静态文件 20 → `static`；无证据 → `process`。

pm2 / 单镜像 / caddy / k8s / delegate **不在** `target.type` 取值里（`TARGET_KINDS` 只有 static / nginx / docker / systemd / process）。

仲裁：0 命中 → 报错并列出看到的文件（超 10 条截断）；1 命中 → 用它；1 命中但未实现 → 报错并列出已实现类型；多命中 → `target.pick: fail` 报错，`auto` 取置信度最高且**并列就报错**，未实现候选不参与取最高。

### nginx：`target.nginx`

conf 由 `@dp/target-nginx` 生成，不手写；`confd` 属 `target.confd`，由实测可写性推导。

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

生效顺序：影子目录 → `nginx -t` → 备份 → 原子 rename → 全树 `-t` → reload。`upstream` 斜杠二义报错；`extra` 原样输出；`reload` argv 空串被拒；`$host` 原样（字面量 `$${x}`）。只覆盖 `# managed by dp`，否则 `DP.NGX.NOT_MANAGED`（需 `force`）。`dp apply`：install → deploy → activate，失败不回滚。

### docker：`target.docker`

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `mode` | remote-cli | remote-cli | 余者报 `DP.DOCKER.MODE_UNSUPPORTED` |
| `compose.files` | string[] | — | 必填；相对 release 目录 |
| `compose.projectName` | string | — | 必填；`-p` 前缀 |
| `compose.envFile` | string | — | → `--env-file` |
| `compose.pull` | boolean | true | 浮动 tag 不 pull = 旧镜像 |
| `compose.wait` | boolean | true | `up --wait` |
| `healthcheck.services / expectStates` | string[] | ps 全部 / running,healthy | 只查这些服务与状态 |

本轮只实现 `remote-cli`：compose 文件随 release 上传后在目标机跑 compose CLI（`<容器运行时>` 按环境选一个 compose 兼容 CLI 代入）。compose 变量由 compose 自己插值（`${VAR}` / `$$`），dp 不解释。路径须相对 release 目录且非空串，否则 `DP.DOCKER.COMPOSE_FILE_INVALID`。验收用 `<容器运行时> compose ps --format json`，读不出结论报 `DP.DOCKER.PS_PARSE_FAILED`。回滚用上一版 compose 重新 up（不 pull、不 `down`），无上一版 → `DP.DOCKER.NO_PREVIOUS`。`dp apply`：deploy → install → activate；文件没传上去 → `DP.DOCKER.FILE_MISSING` 且不发 pull / up；activate 失败不回滚，退出码非 0；`dp verify` 不通过退 2。

### systemd：`target.systemd`

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

unit 由 `@dp/target-systemd` 生成，不手写；`unitDir` 由可写性按 scope 推导（system → `/etc/systemd/system`，user → `~/.config/systemd/user`）。生效顺序：渲染 → 影子候选（在版本目录）→ `systemd-analyze verify` → 备份 → 原子 rename → `daemon-reload` → `enable` → `restart`。`enabled: false` 只跳 enable（`DP.SYSD.ENABLE_FAILED` 是 enable 跑不动）。只覆盖 `# managed by dp`，否则 `DP.SYSD.UNIT_NOT_MANAGED`（需 `force`）。`dp apply`：install → deploy → activate；回滚还原 `<unit>.dp-backup`，无备份 → `DP.SYSD.NO_PREVIOUS`。

### process：`target.process`

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `command` | string | — | 必填；argv[0]，不经 shell |
| `args` | string[] | — | 启动参数 |
| `workingDirectory` | string | current 软链 | 工作目录 |
| `env` | record<string> | — | 环境变量 |
| `stopSignal` | PROCESS_STOP_SIGNALS | SIGTERM | 不含 SIGKILL |
| `stopTimeoutMs` | number | 10000 | 优雅期上限 |
| `pidFile / stdoutLog` | string | — | 相对发布根；日志落盘 |

裸进程，自带极简进程管理：pidfile 记 pid，停止先信号后强杀，存活靠 `kill -0`。脚本跟版本目录（`<release>/.dp/`），pid 与日志在发布根固定位置。所有值在渲染期烘进脚本，运行期只跑 `sh <脚本>`；只渲染一半会让 `${release.current}` 变字面文本。回滚跑上一版实际部署的脚本，不在 → `DP.PROC.NO_PREVIOUS`；停止脚本强杀后再查一次。`dp apply`：deploy → install → activate，先停旧再起新，旧的不停就不起新的。`process` 无探测证据，只能显式写 `target.type`。

---

## 7. 覆盖优先级

```text
schema 默认值（withDefault） < defaults.hosts[<id>] < hosts[<id>] < profiles.<env>.hosts[<id>]
```

后者胜出。合成只发生在 hosts 一段（连接层随环境变），在 `@dp/cli` 的 targets 一处实现；项目段没有环境覆写层。`--config / --env / --project / --host / --all` 做的是选择与路由，不是值覆盖。`dp plan` 打出布局、发布根、步数与能力候选。

---

## 8. 字段速查表

从 `dp schema` 反查（`node scripts/dump-schema-fields.mjs`，schema 改过就重跑）。`withDefault` 字段输入可省、输出必有值，「默认」即该值，`—` = 不给就没有；偏好链可写单值或数组；各 target 段见上文对应小节。

**`hosts.<id>`**（`defaults.hosts` / `profiles.<env>.hosts` 同形状，不重复列出）

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

`hops[].port` 与串内端口冲突报错；`become.template` 除 `${cmd}` 外出现 `${` 被拒。

**`projects.<id>`**

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
| `target.type` | 链 static/nginx/docker/systemd/process | static | 点名须给段 |
| `target.pick` | auto / fail | auto | 仲裁口径 |
| `target.confd` | string | 能力推导 | conf.d 目录 |
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
| `transport.*` | 同 `hosts.<id>.transport` | 同上 | 项目级覆盖 |
