# 配置模型

> 一句话：**最少只需要三个字段就能部署；需要更多控制时，每一层能力都独立可选，不会为了用一个高级功能而把整份配置写长。**

原则：

1. **约定优于配置**：绝大多数字段有安全默认值，能推导的一律推导。**写高级能力不该增加基础用法的复杂度。**
2. **单一真源**：所有字段只在 `@dp/schema` 的一份自研 DSL 里定义（零依赖）；TS 类型、运行时校验、**JSON Schema**（给编辑器提示）全部由它派生。手写第二份类型视为缺陷。
3. **就近覆盖**：profiles 覆盖 defaults，project 覆盖 profile，CLI `--set` 覆盖一切。但**不允许跨层猜测**。
4. **默认值宁保守不激进**：默认不做破坏性动作（`--delete`、覆盖非托管文件、清理旧版本都需要显式开关）。

---

## 1. 最简形态（推荐从这开始）

```ts
// deploy.config.ts
import { defineConfig } from '@dp/schema'

export default defineConfig({
  projects: {
    web: {
      source: { root: './dist/**' }, // 要传什么：`./dist/**` 只放目录内容；`./dist` 连目录本身一起放
      hosts: ['prod'],               // 传到哪：`hosts` 里的名字，一台或多台
      release: { root: '/var/www/web' }, // 放哪：远端发布根；不写则按实测能力推导
    },
  },
  hosts: {
    prod: { ssh: 'deploy@10.0.0.7' }   // ssh 连接串：user@host[:port]。串内只能写一跳；多跳用下面的 hops
  },
})
```

跑起来：`dp deploy web`。

**上面的配置里省掉了什么？** 传输方式（自动协商 rsync/tar-ssh/sftp）、target 类型（自动识别，缺省 static）、release 布局与回滚（默认开启）、日志脱敏（默认开启）、是否提权（探测后再决定要不要问密码）、target 的生效步骤（没有 target 段就按 static 走）。

必填的只有 **谁（source.root）、去哪（hosts）**；放哪不写就由实测能力推导。JSON 里同一个对象：

```json
{
  "projects": {
    "web": {
      "source": { "root": "./dist/**" },
      "hosts": ["prod"],
      "release": { "root": "/var/www/web" }
    }
  },
  "hosts": {
    "prod": { "ssh": "deploy@10.0.0.7" }
  }
}
```

---

## 2. 字段提示与 schema

`dp` 按顺序自动发现 `deploy.config.ts | .js | .json`（前者能写逻辑，后者最通用），也支持 `--config` 指定。文件与对象走同一份 schema：`defineConfig()` 就是配置文件的编程式入口，不存在「文件里能写的比对象里多」。

字段提示有三条路：TS / JS 写法直接吃 `defineConfig()` 的类型；JSON 写法跑 `dp schema` 拿 JSON Schema（默认输出到 stdout，`--out <路径>` 会写到指定文件），在编辑器的 JSON Schema 关联设置里把它绑到 `deploy.config.json`。配置文件本身**不收** `$schema` 这类元键：schema 拒未知字段，写了过不了校验。

---

## 3. 多环境（dev / staging / prod）

三种机制，按复杂度递增，可混用：

### 3.1 profile：同一份配置里的差异层

```ts
export default defineConfig({
  projects: { web: { source: { root: './dist/**' }, hosts: ['web'] } },
  hosts: { web: { ssh: 'deploy@origin.example.com' } },
  profiles: {
    staging: { hosts: { web: { ssh: 'deploy@stg.example.com' } } },
    prod:    { hosts: { web: { ssh: 'deploy@prod.example.com' } } },
  },
})
```

`dp deploy web --env prod`。**没有 `--env` 时必须有明确的默认 profile，否则报错** —— 不猜环境，猜错了就是把预发的东西发到生产。

profile 能覆写的只有 **hosts**（合成顺序 `defaults.hosts ⊂ hosts ⊂ profiles.<env>.hosts`，schema 只留有真实语义的字段）：「同一台机器名在预发连别处、生产连快一点」是环境差异，release / transport / activation 不随环境变 —— 想按环境调 keep，把它写进项目段或用配置生成器按环境生成整份配置。

### 3.2 一次推整个环境：`--all`

`dp apply --all --env prod` → 把 `projects` 里的每个项目都推上去（按主机逐个扇出）；`dp plan --all` 用同一个覆盖口径先出计划。

profile 段能覆写的只有上表那四类：hosts / release / transport / activation。项目的 target 类型与 source 是项目自己的属性，不随环境变 —— 「同一项目在不同环境连不同机器」交给 hosts 覆写，别在 profiles 里试图重定义项目。

### 3.3 环境变量插值与 secretRef

任何字符串值里可以用变量：

| 写法 | 含义 |
| --- | --- |
| `${env.DEPLOY_KEY}` | 环境变量 |
| `${git.sha}` `${git.branch}` `${git.tag}` | 本地 Git 状态 |
| `${release.id}` `${release.current}` | 运行时才确定，由 template 层在 plan 期解析 |
| `${project}` `${env}` `${now}` | 上下文变量 |

凭据**永远写成 ref，不写明文**：

```ts
// auth 段在 hosts.<id> 下
{ auth: { type: 'password', passwordRef: 'env:DEPLOY_PASSWORD' } }
```

scheme 目前只有 `env:`（环境变量）一种 —— 别的来源没有实现，写了也取不到值。

---

## 4. 主机与多跳、提权、传输

> **这一节混了「已落地」与「设计形态」，逐项标注如下，别照抄。**
> 已落地的字段：`ssh`（单跳连接串）、`hops`（多跳，两种驱动都支持）、`hops[].knownHosts`
> （每跳的主机密钥**策略**枚举 strict / accept-new / tofu / off，不是 known_hosts 文件路径）、
> `local`、`become`、`layout`、`transport`。
> **未落地**：`crypto`、主机连接层的 `timeouts` —— schema 里没有这两样
> （nginx 反代的代理超时、健康检查的超时是各自的专属字段，与这项无关），
> 抗量子目前由驱动偏好链决定（只能走 `native-ssh`，`ssh2` 不支持 PQC），不是配置项。

已落地的写法：

```ts
// hosts / become / layout / transport 段都在 hosts.<id> 下
{
  host: {
    ssh: 'deploy@10.0.0.7',        // user@host[:port]。与 hops 二选一
    become: {                      // 可选。不写 = 纯普通用户，同样受支持
      type: 'sudo',                // none | sudo | su | doas | custom
      user: 'root',
      method: 'auto',              // auto | nopasswd | stdin | pty
      passwordRef: 'env:SUDO_PASSWORD',
      preserveEnv: false,
    },
    layout: 'auto',                // auto | system | user。路径由能力推导，不写死系统路径
    transport: {
      strategy: 'auto',            // auto | rsync | tar-ssh | sftp | scp | local
      delete: false,
    },
  },
  localBox: { local: true },       // 本机目标
}
```

多跳：把整条链写进 `hops`，**最后一跳就是目标机**：

```ts
// 一跳一个条目，最后一跳就是目标机
hops: [
  { ssh: 'ops@jump.example.com', auth: { type: 'agent' } },
  { ssh: 'deploy@10.0.0.7',      auth: { type: 'key', identityFile: '~/.ssh/id_ed25519' } },
]
```

这些限制都会在配置加载或拼 argv 时**显式报错**，不会静默降级。

下面两条是 **`native-ssh`（`-o ProxyJump=`）路径**的限制，由「跳板连接由系统 ssh 自己发起」
这一点决定，不是 hops 本身的限制。**它们只约束链里当跳板的那几跳** —— 最后一跳是目标机，
不进 `-J`，所以不受「`-J` 只有一条命令行」那条的约束。
（但逐跳 `auth` 的 `type` 只有 `key` / `agent` 两种是**配置层**就定死的，
对目标机同样成立 —— 目标机要用密码就别走 hops，走单跳 `ssh`。）

- **跳板只能 key / agent**。我们既没有它的凭据通道，也保证不了不交互
  （它会去读 tty，在 CI 里就是一次永久挂起）。改用密钥/agent，
  或把跳板的端口与密钥写进 ssh_config 的 `Host` 块。
- **跳板不能单独设 knownHosts**。`-J` 只有一条命令行，跳板机与目标机共用同一组
  `StrictHostKeyChecking` / `UserKnownHostsFile`；跳板要不同策略只能走 ssh_config。

`ssh2` 驱动走的是另一条路（逐跳 direct-tcpip 串成链），所以限制不同：

- **逐跳认证独立**，可以逐跳用密码 —— 通道是我们自己开的，凭据也是我们发的
- **不支持抗量子 KEX**（ssh2 没有任何 PQ 算法），需要 PQC 就只能走 native-ssh
- 跳板禁 TCP 转发（`AllowTcpForwarding no`）时 `direct-tcpip` 会直接失败。
  可开 `allowNcHopFallback` 用跳板上的 `nc` 兜底，**默认关**：nc 是在跳板机上起进程，
  等于把「目标能不能到」交给跳板上装了什么。两次都失败时报错会列出两次各自的原因
- 凭据**绝不向下继承**：每一跳都要显式给 `auth`。继承意味着把目标机的密码发给了跳板机

`hops: []` 按「没给」处理（等同单跳）。

> **不假设 root。** `sshUser` 一律是普通账号，`become` 只是可选项而非必经步骤（`type: none` 是一等公民）。
> 目标机上的路径 —— 状态目录、systemd unit 位置、confd —— **都不是配置项**：由实测能力推导出
> `system | user` 两种布局之一（`auto` 由能力推导），并在 plan 里打印出来供核对。

**设计要点**：`hosts` 描述「怎么过去」，`target` 描述「到了之后怎么生效」，两者正交。所以同一份 nginx 配置，挂 `prod-bastion` 就是远端部署，挂 `local-box` 就是本机部署 —— target 的代码一行不用改。

---

## 5. 多主机 / 集群扇出

一个 project 可以同时投向**多台主机**：

```ts
{
  projects: {
    web: {
      source: { root: './dist' },
      hosts: ['prod-web-01', 'prod-web-02', 'prod-web-03'], // 不写则投向所有主机
    },
  },
}
```

扇出的单位要清楚：**一次部署里，每台主机各自算一条独立的 plan**（各自的 Facts 可能不同 ——
机器间 rsync 版本不一样是常事），共用一个 `releaseId`，以便跨机器对齐版本与回滚。
`dp status --host <id>` 看某一台当前指向的版本，逐台跑一遍就能判断集群是否一致；
候选多于一台又没指定时 `--host` 是必填的（dp 不替你选一台）。

幂等在这里特别值钱：同一 `releaseId` 已在某台机器上存在时，那台机器跳过上传直接参与
activation，跨机重复运行也就安全了。

---

## 6. 目标类型：nginx / docker / systemd / process 与自动识别

`target` 不填时走 **TargetResolver**，两个阶段：

1. **探测器（Detector）**：在项目根收集证据。每个探测器返回 `(confidence, evidence[])`。
2. **仲裁**：按「命中数量 + 显式开关」决定，并**打印它为什么这么选**。

| 探测到的证据 | 结论 | 有执行器 |
| --- | --- | --- |
| `docker-compose.yml` / `compose.yaml` / `docker-compose.*.yml` | `docker`（`mode: remote-cli`） | ✅ |
| `nginx.conf` / `conf.d/*.conf` / `*.nginx.conf` | `nginx` | ✅ |
| 只有静态文件（含 `index.html`） | `static` | ✅ |
| `Dockerfile` 且无 compose | `docker`（单镜像） | ❌ |
| `*.service` 单元文件 | `systemd` | ✅ |
| `ecosystem.config.js` | `pm2` | ❌ |
| （无探测证据，只能显式点名） | `process` | ✅ |
| `package.json` 有 `scripts.deploy` / `.deploy/scripts/*` | `delegate`（交给项目自带的方式） | ❌ |
| `Caddyfile` | `caddy` | ❌ |
| `Chart.yaml` / k8s manifests | `k8s` | ❌ |

右列是 ❌ 的那些**不在 `target.type` 的取值里**（`dp schema` 里查不到）：它们被认出来是为了把
「为什么选了别的」说清楚，以及防止「源里躺一个 `Caddyfile` 就把 compose 项目判成 caddy」。

仲裁策略必须保守：

实现在 `@dp/core` 的 `detect.ts`（纯函数，源清单与 `package.json` 的 scripts 都由调用方注入）。

- **0 命中** → 报错并列出「它看到了哪些文件」（超过 10 条截断并给总数），而不是假装 static
- **1 命中** → 用它，日志打印：`检测到 docker-compose.yml → target.type=docker（可用 target.type 覆盖）`
- **1 命中但本仓还没实现**（如只有 `Dockerfile` 的单镜像、Caddyfile、pm2、k8s、
  delegate）→ 报错，列出已实现的类型供显式指定，**绝不静默降级成 static**
- **多命中** → `target.pick: fail`（默认 `auto`）直接报错，列出所有候选与排除办法；
  `auto` 取 confidence 最高的那个，**最高分有并列就报错**（并列时靠数组顺序选 = 暗选）。
  未实现的候选**不参与**「取最高」—— 源里躺一个 `Caddyfile` 不该让 compose 项目报
  「不支持」；但**全部**候选都未实现时报「都还没实现」。

置信度档位（越难被巧合凑出来越高）：compose 90 > nginx.conf 80 > systemd / pm2 60
（**刻意同档**：两者都是「项目自带进程监管配置」，没有依据偏向谁，撞档就是歧义）>
单镜像 Dockerfile 50 > Caddyfile 45 > delegate 40 > Chart.yaml 30 > index.html 20
（它几乎每个前端产物都有，是兜底档，排前面会把 compose 项目判成 static）。

### nginx：`target.nginx`

conf **不手写**，由 `@dp/target-nginx` 从结构化配置生成。`confd` 不在这里 —— 它是
`target.confd`，由实测可写性推导（目标机上的路径不是配置项）。

```ts
{
  projects: {
    web: {
      source: { root: './dist' },
      release: { root: '/srv/web' },
      target: {
        type: ['static', 'nginx'],   // 先按静态投放，再换 conf
        // confd: '/etc/nginx/conf.d', // 推导不出来时才显式写（注意写的是主配置 include 的那个目录）
        nginx: {
          filename: '${project}.conf', // 可选，默认 <项目名>.conf。不含目录
          force: false,                // 覆盖未带 `# managed by dp` 的同名文件（仍先备份）
          reload: ['systemctl', 'reload', 'nginx'], // argv[]；false = 由外部机制重载
          server: {                    // 单个块，或块数组
            serverName: ['www.example.com'],
            listen: [80, '443 ssl'],
            root: '${release.current}', // 软链，不是具体版本目录
            index: ['index.html'],
            locations: [
              { path: '/', tryFiles: '$uri $uri/ /index.html' },
              {
                path: '/api/',
                proxy: {
                  upstream: 'http://127.0.0.1:8080', // 末尾斜杠的两种语义不同，它报错而不替你选
                  websocket: true,
                  timeouts: { connect: 5, send: 30, read: 30 },
                },
              },
            ],
            extra: ['add_header X-Deployed-By dp always;'], // 原样输出，连 `;` 都不补 —— 分号自己写
          },
        },
      },
    },
  },
}
```

生效顺序固定：**渲染到影子目录 → `nginx -t` 影子校验 → 备份 → 原子 rename → 整棵树 `-t`
复验 → reload**。`$host` / `$request_uri` 这类 nginx 变量**原样保留**（要字面量 `${x}` 写
`$${x}`）。只覆盖带 `# managed by dp` 的文件；遇同名未标记文件报 `DP.NGX.NOT_MANAGED`，
需要 `force` 才继续。`dp apply` 里的位置是 install → deploy → activate，activate 失败
**不回滚发布**（版本是好的，旧 conf 指向 `current` 软链所以服务没断）。

### docker：`target.docker`

本轮只实现 **`remote-cli`**：compose 文件随 release 上传，然后在目标机上跑
`docker compose`。`build-push` / `build-load` / `image-only` 需要本机 docker 与镜像仓库，
**显式报 `DP.DOCKER.MODE_UNSUPPORTED`**，不按 remote-cli 静默降级。

```ts
{
  projects: {
    api: {
      source: { root: './deploy' }, // compose 文件在这里，随 release 一起上传
      release: { root: '/srv/api' },
      target: {
        type: 'docker',
        docker: {
          mode: 'remote-cli',
          compose: {
            files: ['docker-compose.yml', 'docker-compose.prod.yml'], // 相对 release 目录，按顺序生效
            projectName: 'api',   // compose -p：容器名/网络名前缀，只允许 [a-z0-9_-]
            envFile: '.env.prod', // 可选 → --env-file
            pull: true,           // 默认 true：浮动 tag 不 pull 等于部署上一轮的镜像
            wait: true,           // 默认 true：up --wait，关掉后 verify 是唯一一道关
          },
          healthcheck: {
            services: ['api'],    // 可选，空 = ps 输出里每个服务都要通过
            expectStates: ['running', 'healthy'],
          },
        },
      },
    },
  },
}
```

**compose 文件里的变量不由 dp 解释**：compose 自己用 `${VAR}` 插值、`$$` 转义，dp 再
解释一遍就是两份引擎互吃（tag 变空或 `variable is not set`）。镜像 tag 的注入另开回合，
方向是 `${dp.image}` 白名单前缀 —— 两套变量不共享，`${dp.*}` 之外的原文原样保留。

路径一律相对 release 目录：绝对路径、`..`、反斜杠都会被 `DP.DOCKER.COMPOSE_FILE_INVALID`
顶回 —— 它们会让「这次部署的 compose 文件」变成盘上任意一个文件。验收用
`docker compose ps --format json`（不是 `docker ps`：后者列的是这台机器上所有容器）。
**stdout 读不出结论就报错，绝不判通过**（空输出 / 坏行 → `DP.DOCKER.PS_PARSE_FAILED`）。

回滚 = 用上一版 release 目录里的 compose 重新 up（**不 pull**：浮动 tag 再拉一次会把
上一版换成新镜像）。首次部署没有上一版 → `DP.DOCKER.NO_PREVIOUS`，**不返回假成功**；
也不自动 `down`（那会连停掉目标机上同名的其它项目）。

`dp apply` 里的位置是 **deploy → install → activate**（与 nginx 的 install → deploy →
activate 相反）：compose 文件是随 release 上传的，install 只做「确认它们在盘上」，
排在传输之前它永远失败或什么也没证明。compose 文件没传上去 →
`DP.DOCKER.FILE_MISSING`，且一条 `pull` / `up` 都不发（结果里也不造 docker 段：
空段等于声称拉过起过）。activate 失败**不回滚发布**，退出码非 0，并把执行器给的
`healing` 逐条带出来（执行器刻意零补偿，那几条命令是用户唯一的下一步）。

三条运维命令：`dp verify` 跑只读的 `compose ps`，不通过**退 2**（CI 的闸）；
`dp status` 把 ps 读到的服务状态放进结果，`composeRead` 区分「读到了 0 个服务」与
「没读到」（ps 失败只给 warning，不让 status 整条变红）；`dp rollback` 没有上一版时
报错而不是假成功。

### systemd：`target.systemd`

unit **不手写**，由 `@dp/target-systemd` 从结构化配置生成。`unitDir` 也不是随手填的路径：
它由实测可写性按 scope 推导（system → `/etc/systemd/system`，user →
`~/.config/systemd/user`），推导不出可写的那个目录时报 `DP.PERM.UNIT_DIR_NOT_WRITABLE`
而不是挑一个「大概是」的落点。user scope 不需要提权，但**只在用户会话存活期间运行** ——
linger 没开的话人一注销服务就停，这是它的语义而不是缺陷，所以不自动替你选 system。

```yaml
projects:
  api:
    source: { root: './dist' }
    release: { root: '/srv/api' }
    target:
      type: [static, systemd]      # 先按静态投放，再换 unit
      # systemd.unitDir 不写：由实测可写性推导
      systemd:
        unit: '${project}.service'  # 可选，默认 <项目名>.service。不含目录，必须以 .service 结尾
        scope: system               # system | user
        execStart: '${release.current}/bin/api'   # 必填。${release.current} 是软链
        workingDirectory: '${release.current}'
        environment: { NODE_ENV: 'production' }
        restart: on-failure         # 默认 on-failure：正常退出不该被无限重启
        restartSec: 5
        after: ['network.target']
        wantedBy: 'multi-user.target'
        enabled: true               # 默认 true：写了 [Install] 就要 enable，否则重启后服务不起来
        extra: ['MemoryMax=512M']   # 逐行原样输出；行里带换行等于多出几条指令，会被拒
```

生效顺序固定：**渲染 → 写影子候选 → `systemd-analyze verify` → 备份 → 原子 rename →
`daemon-reload` → `enable` → `restart`**。`enabled: false` 时跳掉 enable 一步，服务照旧
重启 —— 关掉自启的正当理由是「这个服务本来就不该开机自启」，不是「enable 跑不动」；
后者报 `DP.SYSD.ENABLE_FAILED`（服务本身没受影响，缺的是重启之后那一半）。影子候选落在版本目录下而不是 unitDir 之下 —— unitDir 会被
systemd 递归扫描，同名的候选放那儿就是往机器里塞一份重复 unit。只覆盖带
`# managed by dp` 的文件；遇同名未标记文件报 `DP.SYSD.UNIT_NOT_MANAGED`，需要 `force`
才继续（仍先备份）。值里的控制字符在渲染期就被拒（unit 是一行一条指令，换行等于注入）。

`dp apply` 里的位置是 install → deploy → activate：unit 里的 `ExecStart` 用
`${release.current}` 软链，先切版本再换 unit 是安全的。`daemon-reload` 或 `restart`
失败**都不回滚 unit 也不回滚发布** —— 盘上的 unit 是好的，退回它只会让现场更难判断。
回滚还原 `<unit>.dp-backup` 后重新 reload + restart；首次部署没有备份 →
`DP.SYSD.NO_PREVIOUS`，**不返回假成功**。

### process：`target.process`

裸进程目标，**自带极简进程管理**：pidfile 记 pid，停止走「先信号后强杀」，存活靠
`kill -0`。不接 pm2 / supervisord 一类外部进程管理器 —— 它们要进目标机的依赖清单，
于是「目标机没装 pm2」会在部署期被报成「打包漏了东西」，而真正的原因是环境缺件。

```yaml
projects:
  api:
    source: { root: './dist' }
    release: { root: '/srv/api' }
    target:
      type: [static, process]      # 先按静态投放，再起进程
      process:
        command: '${release.current}/bin/api'   # 必填。argv[0]，不是一行 shell
        args: ['--port', '8080']
        workingDirectory: '${release.current}'  # 默认 current 软链
        env: { NODE_ENV: 'production' }
        stopSignal: SIGTERM         # 只收给进程收尾机会的那几个；SIGKILL 不给
        stopTimeoutMs: 10000        # 优雅期，是上限而不是「等它结束」
        # pidFile: '.dp/process.pid'   # 相对**发布根**，不跟着版本目录漂
        # stdoutLog: '.dp/process.log'
```

启动与停止脚本跟着**版本目录**（`<release>/.dp/`），pid 与日志落在**发布根下的固定位置**
—— 激活时要停的是「当前跑着的那个」，而那一刻还不知道 current 指向哪。命令、参数、
环境变量、工作目录、pidfile 全在渲染期烘进脚本，运行期只跑 `sh <脚本>`，且**每个值都过
模板渲染**：只给一半字段渲染的话，`${release.current}` 会在 args 里静默变成字面文本 ——
它不报错、能被写进脚本，只在目标机 exec 时才以 not found 炸出来，而那一刻错误指向机器
而不是配置。回滚要跑的是**上一版实际部署出去的那份脚本**，运行期手上只有当前配置，把
command 当参数传进去的回滚会变成「用当前配置的命令在上一版目录里跑一次」。停止脚本在强杀之后**再查一次**，
只发 `KILL` 就当成功是这类脚本最常见的假成功。

`dp apply` 里的位置是 **deploy → install → activate**（与 systemd 相反）：脚本写在版本
目录里，传输之前那个目录还不存在。activate 先停旧的再起新的，**旧进程停不下来就不起
新的**（两个实例会抢同一个端口）；新进程起不来时旧进程已停，报告必须说清服务是空窗的。
回滚跑上一版目录里的启动脚本，它不在 → `DP.PROC.NO_PREVIOUS`，**不返回假成功**。
`process` 没有探测证据（`*.service` 之外的裸进程无从识别），只能显式写 `target.type`。

---

## 7. 覆盖优先级

```
schema 默认值（withDefault）  <  defaults.hosts[<id>]  <  hosts[<id>]  <  profiles.<env>.hosts[<id>]
```

后者胜出。合成只发生在 **hosts** 一段（连接层随环境变），在 `@dp/cli` 的 targets 一处实现；
项目段（source / release / target / transport / healthcheck / activation）没有环境覆写层 ——
它们是项目自己的属性。命令行参数（`--config / --env / --project / --host / --all`）
做的是**选择与路由**，不是值覆盖。

「这次会做什么」由 `dp plan` 打出来：布局、发布根、步数与目标机能力候选（可达/可写逐项
给 ✓/✗ 与原因）。配置值本身没有「每个值打印来源」这道输出 —— 覆盖链只此一处实现，
查链就去读那一处，不做两份可能与真值分叉的解释器。

---

## 8. 字段速查表

下面这张表是**从 `dp schema` 的 JSON Schema 反查出来的**（`node scripts/dump-schema-fields.mjs`，
schema 改过就重跑一次），不是手抄的 —— 抄出来的表一定会
和实现分叉，而分叉之后用户照着文档写的配置在校验期就被顶回来。

（`defaults.hosts` 与 `profiles.<env>.hosts` 就是 `hosts` 同形状的覆写位，故不重复列出。）

| 字段 | 必填 | 类型 / 取值 |
| --- | --- | --- |
| `hosts` | 可选 | {} |
| `hosts.*.ssh` | 可选 | string |
| `hosts.*.hops` | 可选 | [] |
| `hosts.*.hops[].ssh` | 必填 | string |
| `hosts.*.hops[].auth` | 可选 | {} |
| `hosts.*.hops[].knownHosts` | 可选 | strict | accept-new | tofu | off |
| `hosts.*.hops[].port` | 可选 | number |
| `hosts.*.local` | 可选 | boolean |
| `hosts.*.become` | 可选 | {} |
| `hosts.*.become.type` | 必填 | none | sudo | su | doas | custom |
| `hosts.*.become.user` | 可选 | string |
| `hosts.*.become.method` | 必填 | auto | nopasswd | stdin | pty |
| `hosts.*.become.passwordRef` | 可选 | string |
| `hosts.*.become.preserveEnv` | 必填 | boolean |
| `hosts.*.become.template` | 可选 | string |
| `hosts.*.layout` | 必填 | auto | system | user |
| `hosts.*.transport` | 可选 | {} |
| `hosts.*.transport.strategy` | 必填 | rsync | tar-ssh | sftp | scp | local[] |
| `hosts.*.transport.delete` | 必填 | boolean |
| `hosts.*.transport.compress` | 必填 | auto | none | gzip | zstd |
| `projects` | 必填 | {} |
| `projects.*.source` | 必填 | {} |
| `projects.*.source.root` | 必填 | string |
| `projects.*.source.include` | 可选 | string[] |
| `projects.*.source.exclude` | 可选 | string[] |
| `projects.*.hosts` | 可选 | string[] |
| `projects.*.release` | 可选 | {} |
| `projects.*.release.root` | 可选 | string |
| `projects.*.release.keep` | 必填 | number |
| `projects.*.release.shared` | 可选 | string[] |
| `projects.*.release.owner` | 可选 | string |
| `projects.*.release.dirMode` | 可选 | string |
| `projects.*.release.fileMode` | 可选 | string |
| `projects.*.release.switchStrategy` | 必填 | auto | symlink | copy |
| `projects.*.target` | 可选 | {} |
| `projects.*.target.type` | 必填 | static | nginx | docker | systemd | process[] |
| `projects.*.target.pick` | 必填 | auto | fail |
| `projects.*.target.confd` | 可选 | string |
| `projects.*.target.nginx` | 可选 | {} |
| `projects.*.target.docker` | 可选 | {} |
| `projects.*.target.systemd` | 可选 | {} |
| `projects.*.target.process` | 可选 | {} |
| `projects.*.healthcheck` | 可选 | {} |
| `projects.*.healthcheck.command` | 可选 | string |
| `projects.*.healthcheck.http` | 可选 | {} |
| `projects.*.healthcheck.tcp` | 可选 | {} |
| `projects.*.healthcheck.fileExists` | 可选 | string[] |
| `projects.*.healthcheck.timeoutMs` | 必填 | number |
| `projects.*.healthcheck.intervalMs` | 必填 | number |
| `projects.*.activation` | 可选 | {} |
| `projects.*.activation.mode` | 必填 | trial-promote | direct |
| `projects.*.activation.trialTimeout` | 必填 | string |
| `projects.*.activation.autoPromote` | 必填 | when-healthcheck-passes | never | always |
| `projects.*.activation.promoteConsecutivePasses` | 必填 | number |
| `projects.*.activation.promoteWindow` | 必填 | string |
| `projects.*.transport` | 可选 | {} |
| `projects.*.transport.strategy` | 必填 | rsync | tar-ssh | sftp | scp | local[] |
| `projects.*.transport.delete` | 必填 | boolean |
| `projects.*.transport.compress` | 必填 | auto | none | gzip | zstd |

「必填」是**归一化输出**的口径：`withDefault` 的字段输入可省、输出一定有值，所以它们是必填。
`target.type` 可以写单个值或偏好链（`[]` 表示数组），取值只有上表列出的那几种。

各 target 自有段（`target.nginx.*` / `target.docker.*` / `target.systemd.*` /
`target.process.*`）的完整形状见第 6 节，以及
`dp schema` 导出的 JSON Schema —— schema 即文档，两者不容许不一致。
