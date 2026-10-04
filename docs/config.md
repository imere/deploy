# 配置模型

> 一句话：**最少只需要三个字段就能部署；需要更多控制时，每一层能力都独立可选，不会为了用一个高级功能而把整份配置写长。**

原则：

1. **约定优于配置**：绝大多数字段有安全默认值，能推导的一律推导。**写高级能力不该增加基础用法的复杂度。**
2. **单一真源**：所有字段只在一个 zod schema 里定义；TS 类型、运行时校验、**JSON Schema**（给编辑器提示）全部由它派生。手写第二份类型视为缺陷。
3. **就近覆盖**：profiles 覆盖 defaults，project 覆盖 profile，CLI `--set` 覆盖一切。但**不允许跨层猜测**。
4. **默认值宁保守不激进**：默认不做破坏性动作（`--delete`、覆盖非托管文件、清理旧版本都需要显式开关）。

---

## 1. 最简形态（推荐从这开始）

```ts
// deploy.config.ts
import { defineConfig } from '@dp/config'

export default defineConfig({
  projects: {
    web: {
      source: './dist',          // 要传什么：目录（尾随 / 影响语义）或若干文件
      host: 'prod',              // 传到哪：`hosts` 里的名字
      to: '/var/www/web',        // 远端哪里
    },
  },
  hosts: {
    prod: { ssh: 'deploy@10.0.0.7' }   // ssh 连接串：user@host[:port]。当前只支持单跳
  },
})
```

跑起来：`dp deploy web --env prod`。

**上面的配置里省掉了什么？** 传输方式（自动协商 rsync/tar-ssh/sftp）、target 类型（自动识别）、release 布局与回滚（默认开启）、日志脱敏（默认开启）、是否提权（探测后再决定要不要问密码）、CONF passiert 步骤（没有 target 就不需要）。

只有三个字段是真正必填的：**谁（source）、去哪（host）、放哪（to 或 target）**。

---

## 2. 同样的配置，写成 YAML / JSON

完全等价，`dp` 自动按顺序找 `deploy.config.ts | .js | .mjs | .yaml | .yml | .json`，也支持 `--config` 指定：

```yaml
# yaml-language-server: $schema=./.dp/deploy.schema.json
projects:
  web:
    source: ./dist
    host: prod
    to: /var/www/web
hosts:
  prod:
    ssh: deploy@10.0.0.7
```

`dp schema` 会导出 JSON Schema。把它写进 `$schema` 那一行，**编辑器就能做字段名补全、类型校验、悬停文档** —— 这就是「ts/json/schema 保证参数提示」的具体落地。

你也可以不用文件，直接在代码里当库用：

```ts
import { deploy } from '@dp/core'
const result = await deploy({
  projects: { web: { source: './dist', host: 'prod', to: '/var/www/web' } },
  hosts: { prod: { ssh: 'deploy@10.0.0.7' } },
})
```

对象与文件走同一套 schema，不存在「文件里能写的比对象里多」。

---

## 3. 多环境（dev / staging / prod）

三种机制，按复杂度递增，可混用：

### 3.1 profile：同一份配置里的差异层

```ts
export default defineConfig({
  defaults: { release: { keep: 5 } },
  profiles: {
    staging: { hosts: { web: { ssh: 'deploy@stg.example.com' } } },
    prod:    { hosts: { web: { ssh: 'deploy@prod.example.com' } }, release: { keep: 10 } },
  },
})
```

`dp deploy web --env prod`。**没有 `--env` 时必须有明确的默认 profile，否则报错** —— 不猜环境，猜错了就是把预发的东西发到生产。

### 3.2 project × env 的矩阵：多个项目同时多环境

```ts
profiles: {
  prod: {
    projects: {
      web:   { host: 'prod-web',   to: '/srv/web' },
      admin: { host: 'prod-admin', to: '/srv/admin' },
      api:   { target: { type: 'docker', compose: { projectName: 'api' } } },
    },
  },
}
```

`dp deploy --all --env prod` → 一次把整个环境推上去（按主机逐个扇出）。

### 3.3 环境变量插值与 secretRef

任何字符串值里可以用变量：

| 写法 | 含义 |
| --- | --- |
| `${env.DEPLOY_KEY}` | 环境变量 |
| `${git.sha}` `${git.branch}` `${git.tag}` | 本地 Git 状态 |
| `${release.id}` `${release.current}` | 运行时才确定，由 template 层在 plan 期解析 |
| `${project}` `${env}` `${now}` | 上下文变量 |

凭据**永远写成 ref，不写明文**：

```yaml
auth: { type: password, passwordRef: env:DEPLOY_PASSWORD }
```

scheme 有 `env:` / `file:` / `prompt:` / `cmd:`，注册表化，未来可加 `vault:` / `op:` —— 见 security.md。

---

## 4. 主机与多跳、提权、传输

> **这一节混了「已落地」与「设计形态」，逐项标注如下，别照抄。**
> 已落地的字段：`ssh`（**单跳**连接串）、`local`、`become`、`layout`、`transport`。
> **未落地**：`hops`（多跳）、`crypto` / `knownHosts` / `timeouts` —— 这三个 schema 里没有，
> 抗量子目前由驱动偏好链决定（只能走 `native-ssh`，`ssh2` 不支持 PQC），不是配置项。

已落地的写法：

```yaml
hosts:
  prod:
    ssh: 'deploy@10.0.0.7'          # user@host[:port]。当前**只支持单跳**
    become:                          # 可选。不写 = 纯普通用户，同样受支持
      type: sudo                     # none | sudo | su | doas | custom
      user: root
      method: auto                   # auto | nopasswd | stdin | pty
      passwordRef: env:SUDO_PASSWORD
      preserveEnv: false
    layout: auto                     # auto | system | user。路径由能力推导，不写死系统路径
    transport:
      strategy: auto                 # auto | rsync | tar-ssh | sftp | local
      delete: false

  local-box: { local: true }         # 本机目标
```

多跳是**设计形态，尚未开放** —— schema 里没有 `hops` 字段，`@dp/ssh` 的 `connect()`
对非空 `hops` 会显式报错；argv 层虽能构造 `-J` 与 `ProxyCommand`，但用户侧没有入口：

```yaml
    ssh:
      hops:
        - { ssh: 'ops@jump.example.com', auth: { type: agent } }
        - { ssh: 'deploy@10.0.0.7',     auth: { type: password, passwordRef: env:DEPLOY_PASSWORD } }
```

> **不假设 root。** `sshUser` 一律是普通账号，`become` 只是可选项而非必经步骤（`type: none` 是一等公民）。
> 目标机上的路径 —— 状态目录、systemd unit 位置、confd —— **都不是配置项**：由实测能力推导出
> `system | hybrid | user` 三种布局之一，并在 plan 里打印出来供核对。完整模型见 `privilege.md`。

**设计要点**：`hosts` 描述「怎么过去」，`target` 描述「到了之后怎么生效」，两者正交。所以同一份 nginx 配置，挂 `prod-bastion` 就是远端部署，挂 `local-box` 就是本机部署 —— target 的代码一行不用改。

---

## 5. 多主机 / 集群扇出

一个 project 可以同时投向**多台主机**（集群），`host` 写成数组或 host group：

```yaml
hostGroups:
  prod-cluster: ['prod-web-01', 'prod-web-02', 'prod-web-03']

projects:
  web:
    source: ./dist
    host: { group: prod-cluster }
    rollout:
      strategy: rolling          # all | rolling | canary | serial
      batch: 1                   # rolling 时每批几台
      pauseMs: 5000              # 批间隔
      failPolicy: abort          # abort | continue | ask
      healthWaitMs: 30000
```

| 策略 | 行为 | 适合 |
| --- | --- | --- |
| `all` | 全并行 | 无状态服务、追求最快 |
| `rolling` | 分批，`batch: 1` 时就是逐台 | 有状态 / 要保容量 |
| `canary` | 先一台，验健康后推全量 | 高风险发布 |
| `serial` | 严格串行并在每台之间等待人工确认 | 关键业务的保守节奏 |

扇出的单位要清楚：**一次部署里，每台主机各自算一条独立的 plan**（各自的 Facts 可能不同 —— 机器间 rsync 版本不一样是常事），共用一个 `releaseId`，以便跨机器对齐版本与回滚。`dp releases --all` 能看到每台机器上当前指向的版本，用来判断集群是否一致。

幂等在这里特别值钱：同一 `releaseId` 已在某台机器上存在时，那台机器跳过上传直接参与 activation，跨机重复运行也就安全了。

---

## 6. 容器：动态构建 / 推拉 / 多服务编排

容器场景容易写成一个死板的开关列表，所以这里按「**镜像从哪来**」这条主线组织：

```mermaid
flowchart TB
    SRC["release 内容<br/>（含 Dockerfile / compose 文件）"] --> MODE{"target.mode"}
    MODE -->|build-push| A["在 build host 构建<br/>docker buildx build --platform"]
    A --> B["push 到 registry<br/>tag: ${git.sha} + ${env}"]
    B --> C["各主机 pull"]
    MODE -->|build-load| D["本机/构建机构建<br/>docker save → SSH stdin"]
    D --> E["远端 docker load"]
    MODE -->|remote-build| F["每台各自构建<br/>（开发/测试环境常用）"]
    MODE -->|image-only| G["只 pull 现成镜像<br/>不由本流水线构建"]
    C --> UP["compose up -d --wait<br/>或 docker run / stack deploy"]
    E --> UP
    F --> UP
    G --> UP
    UP --> V["健康检查：compose ps --format json"]

    classDef box fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    class A,B,C,D,E,F,G,UP,V box
```

```yaml
projects:
  api:
    source: { root: ./apps/api, include: ['**'], exclude: ['**/node_modules/**'] }
    target:
      type: docker
      mode: build-push              # build-push | build-load | remote-build | image-only
      image:
        name: registry.example.com/team/api
        tags: ['${git.sha}', '${env}-latest']     # 多标签
        platform: 'linux/arm64'      # 交叉构建目标架构
      build:                        # **设计形态，未实现**：docker 目前只有 remote-cli 一种 mode
        where: local                # local | remote | buildHost
        buildHost: builder-arm64    # where=buildHost 时用它
        dockerfile: Dockerfile
        context: .
        cacheFrom: ['type=registry,ref=...']
        buildkit: true
      registry:                     # 同上，未实现
        auth: { usernameRef: env:REG_USER, passwordRef: env:REG_PASS }
      compose:
        files: ['docker-compose.yml', 'docker-compose.prod.yml']
        projectName: api
        envFile: .env.prod
        pull: true
        wait: true                   # docker compose up --wait
    healthcheck:
      - { type: command, run: 'docker compose ps --format json', expect: 'running' }
      - { type: http, url: 'http://127.0.0.1:8080/healthz', expectStatus: [200,204] }
```

要点：

- **多容器天然支持**：compose 文件就是多服务定义，我们不重造编排语义，只负责「把文件送过去 + 用正确的 projectName/env 执行 + 验健康」。多主机时每个主机各自 `up`。
- **动态推拉**：`mode: build-push` 时，镜像 tag 由 `${git.sha}` 与 `${env}` 决定，无需手写版本；compose 文件里的镜像引用可以写成 `${image}` 变量，由我们在 plan 期注入（避免 compose 文件里写死 tag）。
- **`image-only`** 是给「镜像由别的流水线做好」的场景留的位置 —— 同一个 target 类型覆盖四种供给方式，而不是四个互斥的 target。
- **默认 `remote-build` 之外都避免依赖本机 docker CLI**：`build-load` 需要本机 docker，`build-push` 若为交叉构建则需要 buildx。缺什么要明确报错 + 建议退到哪里。

---

## 7. 交叉编译

「在哪构建」和「构建出什么架构」是两回事，配置里分开表达：

```yaml
projects:
  edge-agent:
    build:                      # 独立于 source.prepare，是「构建」而非「拷贝」的阶段
      where: buildHost          # local | remote | buildHost | auto
      buildHost: builder-arm64  # 一台架构匹配的构建机
      platform: 'linux/arm64'   # 目标架构
      strategy: auto            # cross | native | buildx
      command: 'make build'     # 非 docker 场景：自己承担交叉编译（GOARCH / --target 等）
      env: { GOOS: linux, GOARCH: arm64 }
      artifact: ./dist/edge-agent
```

推导规则（`strategy: auto` 时）：

```mermaid
flowchart TB
    A{"本地 arch == 目标 arch?"} -->|是| NAT["本机构建即可"]
    A -->|否| B{"配了 buildHost<br/>且架构匹配?"}
    B -->|是| REM["在 buildHost 上原生构建"]
    B -->|否| C{"用容器?"}
    C -->|是| BX["buildx crossPlatform 构建<br/>--platform 指定"]
    C -->|否| CCMD["本机跑用户给定的<br/>交叉编译命令 + 环境变量"]
    CCMD --> WARN["构建产物无法在本机验证<br/>→ 必须开启更强的 healthcheck"]

    classDef box fill:#1e293b,stroke:#38bdf8,color:#e2e8f0
    classDef warn fill:#422006,stroke:#f59e0b,color:#fef3c7
    class NAT,REM,BX,CCMD box
    class WARN warn
```

有一条硬规则：**交叉编译出来的产物不能在本机验证**。因此 `strategy: cross | buildx` 且没配 healthcheck 时，給出警告（不阻断，但要用户知情）——这是为避免「推上去了才发现跑在错误的架构上」。

---

## 8. 自动识别：不写 target 会发生什么

`target` 不填时走 **TargetResolver**，两个阶段：

1. **探测器（Detector）**：在项目根收集证据。每个探测器返回 `(confidence, evidence[])`。
2. **仲裁**：按「命中数量 + 显式开关」决定，并**打印它为什么这么选**。

| 探测到的证据 | 建议 target |
| --- | --- |
| `docker-compose.yml` / `compose.yaml` / `docker-compose.*.yml` | `docker`（mode: remote-build 或 image-only） |
| `Dockerfile` 且无 compose | `docker`（single image） |
| `nginx.conf` / `conf.d/*.conf` / `*.nginx.conf` | `nginx` |
| `Caddyfile` | `caddy`（后续功能） |
| `*.service` 单元文件 | `systemd` |
| `ecosystem.config.js` | `pm2` |
| `package.json` 有 `scripts.deploy` / `.deploy/scripts/*` | **`delegate`**：交给项目自带的部署方式 |
| 只有静态文件（含 `index.html`） | `static` |
| `Chart.yaml` / k8s manifests | `k8s`（后续功能） |

仲裁策略必须保守：

实现在 `@dp/core` 的 `detect.ts`（纯函数，源清单与 `package.json` 的 scripts 都由调用方注入）。

- **0 命中** → 报错并列出「它看到了哪些文件」（超过 10 条截断并给总数），而不是假装 static
- **1 命中** → 用它，日志打印：`检测到 docker-compose.yml → target.type=docker（可用 target.type 覆盖）`
- **1 命中但本仓还没实现**（如只有 `Dockerfile` 的单镜像、Caddyfile、`*.service`、pm2、k8s、
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

```yaml
projects:
  web:
    source: { root: './dist' }
    release: { root: '/srv/web' }
    target:
      type: [static, nginx]        # 先按静态投放，再换 conf
      # confd: '/etc/nginx/conf.d' # 推导不出来时才显式写（注意写的是主配置 include 的那个目录）
      nginx:
        filename: '${project}.conf'   # 可选，默认 <项目名>.conf。不含目录
        force: false                  # 覆盖未带 `# managed by dp` 的同名文件（仍先备份）
        reload: [systemctl, reload, nginx]   # argv[]；false = 由外部机制重载
        server:                       # 单个块，或块数组
          serverName: ['www.example.com']
          listen: [80, '443 ssl']
          root: '${release.current}'  # 软链，不是具体版本目录
          index: ['index.html']
          locations:
            - path: '/'
              tryFiles: '$uri $uri/ /index.html'
            - path: '/api/'
              proxy:
                upstream: 'http://127.0.0.1:8080'   # 末尾斜杠的两种语义不同，它报错而不替你选
                websocket: true
                timeouts: { connect: 5, send: 30, read: 30 }
          extra: ['add_header X-Deployed-By dp always;']   # 原样输出，连 `;` 都不补 —— 分号自己写
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

```yaml
projects:
  api:
    source: { root: './deploy' }        # compose 文件在这里，随 release 一起上传
    release: { root: '/srv/api' }
    target:
      type: docker
      docker:
        mode: remote-cli
        compose:
          files: ['docker-compose.yml', 'docker-compose.prod.yml']  # 相对 release 目录，按顺序生效
          projectName: 'api'            # compose -p：容器名/网络名前缀，只允许 [a-z0-9_-]
          envFile: '.env.prod'          # 可选 → --env-file
          pull: true                    # 默认 true：浮动 tag 不 pull 等于部署上一轮的镜像
          wait: true                    # 默认 true：up --wait，关掉后 verify 是唯一一道关
        healthcheck:
          services: ['api']             # 可选，空 = ps 输出里每个服务都要通过
          expectStates: ['running', 'healthy']
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

### delegate：项目自带部署方式

很多项目已经有自己的部署脚本/compose/Makefile，我们不该抢活。此时本项目的角色变成：**在一旁提供版本布局、锁、日志、回滚与验证**。

```yaml
projects:
  legacy:
    target:
      type: delegate
      run: 'npm run deploy'      # 或 deploy.sh / make deploy
      cwd: '.'
```

contract 通过环境变量传给脚本：

```
DP_RELEASE_DIR   /srv/app/releases/<releaseId>
DP_CURRENT_DIR   /srv/app/current
DP_RELEASE_ID    20261001-003000-a1b2c3d4
DP_ENV           prod
DP_HOST_COUNT    3          # 多台时
```

于是「项目自带的方式」与「我们的 release/rollback/audit」各司其职：**沙箱由项目负责，秩序由我们负责。**

---

## 9. 覆盖优先级

```
CLI --set / 参数  >  project 内的 target  >  profiles.<env>.projects.<name>
                 >  profiles.<env>.defaults  >  defaults      （后者被前者覆盖）
```

嵌套对象**深合并**，数组**整体替换**（数组合并的语义永远说不清）。

`dp plan` 会输出「最终生效配置」的解析结果与来源，例如：

```
release.keep = 10        ← profiles.prod.release.keep
transport.strategy = auto ← defaults（本次协商结果：tar-ssh）
```

**每一个生效值都要能解释「它从哪来」** —— 这是配置系统的可调试性底线。

---

## 10. 字段速查表

| 层级 | 关键字段 |
| --- | --- |
| `defaults` / `profiles` | `hosts`、`projects`、`release`、`transport`、`crypto`、`timeouts` |
| `hosts.*` | `ssh`（**单跳**连接串）、`local`、`become`、`layout`、`transport`。**未落地**：多跳 `hops[]`、`crypto`、`knownHosts`、`timeouts`、`retry` |
| `projects.*.source` | `root`、`include`、`exclude`、`files`、`dotfiles`、`prepare`（本机前置命令） |
| `projects.*.build` | `where`、`buildHost`、`platform`、`strategy`、`command`、`env`、`artifact` |
| `projects.*.release` | `root`、`keep`、`shared[]`、`owner`、`dirMode`、`fileMode`、`switchStrategy` |
| `projects.*.transfer` | `strategy`、`delete`、`compress`、`checksum`、`bandwidthLimit` |
| `projects.*.rollout` | `strategy`、`batch`、`pauseMs`、`failPolicy`、`healthWaitMs` |
| `projects.*.target` | `type`、`pick`、`confd`、`service` + 各 target 自有段（`target.nginx.*` / `docker.image` / ...） |
| `projects.*.target.nginx` | `server`（块或块数组）、`filename`、`force`、`reload`（argv[] 或 `false`）。 |
| `projects.*.target.docker` | `mode`（仅 `remote-cli`）、`compose.{files[],projectName,envFile,pull,wait}`、`healthcheck.{services[],expectStates[]}`。 |
| `projects.*.healthcheck` | `command` / `http` / `tcp` / `fileExists` |
| `projects.*.hooks` | `before|after × prepare|transfer|install|activate|verify`，每条带 `where: local|remote` |
| `projects.*.rollback` | `enabled`、`onFailure: auto|ask|never` |

完整字段名以 `dp schema` 导出的 JSON Schema 为准 —— schema 即文档，两者不容许不一致。
