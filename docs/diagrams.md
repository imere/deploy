# 图集：全景到细节

> 本文用图把整个系统说清楚。**结构与流程以本文为准**，各文档的文字负责给出理由和取舍。
>
> 阅读顺序：全景 → 分层 → 数据流 → 连接与传输 → 目标落地 → 事务与验收 → 扩展与发布。

---

## 1. 全景

```mermaid
flowchart TB
    U["用户 / CI"] --> CLI["@dp/cli<br/>唯一组装根 · bin: dp"]
    CLI --> CFG["@dp/config<br/>文件 / 对象 → 归一化 + 校验"]
    CFG --> SCHEMA["@dp/schema<br/>zod 单一真源 → TS 类型 + JSON Schema"]
    CLI --> CORE["@dp/core<br/>plan() 纯函数 · 编排 · 事务"]
    CORE --> PORTS["@dp/ports<br/>Runner / Target / Transferer / Registry"]
    PORTS --> IMPL["实现包"]
    IMPL --> HOSTS["目标：本机 / 远端 / 集群"]
    CORE --> TRACE["trace + 结构化日志（脱敏出口）"]

    classDef ui fill:#1e293b,stroke:#94a3b8,color:#e2e8f0
    classDef core fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    classDef pure fill:#312e81,stroke:#818cf8,color:#e0e7ff
    classDef edge fill:#422006,stroke:#f59e0b,color:#fef3c7
    class U ui
    class CLI,IMPL edge
    class SCHEMA,PORTS,CORE pure
    class CFG,TRACE core
    class HOSTS ui
```

---

## 2. 分层与依赖方向

```mermaid
graph BT
    A["应用层：cli（唯一接线）"]
    B1["target-static / target-nginx / target-docker"]
    B2["local / ssh / transfer"]
    C["core（编排 · 事务 · 计划）"]
    D1["template（渲染）"]
    D2["config（装载 · 合并）"]
    E["schema（类型 · 校验 · 插值）"]
    F["ports（接口 · 注册表 · 零实现）"]
    G["testing（测试基建 · 也发布，给扩展作者用）"]

    F --> E
    C --> F
    D2 --> E
    B1 --> F
    B1 --> D1
    B2 --> F
    A --> C
    A --> B1
    A --> B2
    A --> D2
    G --> F

    classDef lay0 fill:#312e81,stroke:#818cf8,color:#e0e7ff
    classDef lay1 fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    classDef lay2 fill:#1e293b,stroke:#38bdf8,color:#e2e8f0
    class F,E lay0
    class C,D1,D2 lay1
    class A,B1,B2,G lay2
```

**依赖单向向下。`core` → `ports` → 无**：这就是为什么 core 里不知道 ssh 存在，也是本地目标与远端目标能共用同一条管线的原因。

---

## 3. 配置：从各种来源到一个可校验对象

```mermaid
flowchart LR
    S1["deploy.config.ts<br/>defineConfig()"] --> LOAD["loader"]
    S2["deploy.config.yaml / .json"] --> LOAD
    S3["代码里传对象"] --> LOAD
    S4["CLI --set / --env"] --> LOAD
    LOAD --> MERGE["① 深合并<br/>defaults → profiles.<env> → projects → CLI"]
    MERGE --> INTERP["② 变量插值<br/>${env.*} ${git.*} ${project} ${release.*}"]
    INTERP --> VALID["③ zod 校验<br/>失败要带字段路径 + 建议"]
    VALID --> OUT["最终生效配置<br/>每个值都能追溯来源"]
    VALID --> JS["derive：TS 类型 + JSON Schema（编辑器提示）"]

    classDef box fill:#1e293b,stroke:#38bdf8,color:#e2e8f0
    class LOAD,MERGE,INTERP,VALID,OUT,JS box
```

---

## 4. 运行时数据流

```mermaid
sequenceDiagram
    participant U as 用户/CI
    participant CLI as cli
    participant CFG as config
    participant H as host(Runner)
    participant P as core.plan
    participant T as target adapter
    participant R as 远端/本机

    U->>CLI: dp deploy <project>
    CLI->>CFG: 装载 + 合并 + 校验
    CFG-->>CLI: 生效配置
    CLI->>H: connect(hops) + probe
    H->>R: 加密隧道 · 认证 · 复合探测脚本
    R-->>H: Facts
    CLI->>P: plan(config, facts)
    P-->>CLI: steps（含 unwind 撤销项）
    CLI->>U: dry-run 预览
    U->>CLI: 确认 / --yes
    CLI->>H: acquire lock
    CLI->>T: install → activate
    T->>R: 写文件 · 渲染 conf · 原子切换
    CLI->>R: verify（HTTP / 容器 / nginx -t）
    alt 通过
        CLI->>R: finalize（reload · prune · release lock）
        CLI-->>U: exit 0
    else 失败
        CLI->>H: 逆序执行 unwind
        CLI-->>U: exit 2（并输出 trace）
    end
```

---

## 5. Runner 端口：一个接口，两个世界

```mermaid
flowchart TB
    CORE["core / target 只认 Runner 端口"]
    subgraph IMPL["实现"]
        L["@dp/local<br/>child_process + node:fs"]
        S["@dp/ssh<br/>ssh2 多跳链 + 提权 + 隧道"]
    end
    CORE --> L
    CORE --> S
    L --> M1["本机目录 / Windows / macOS / Linux"]
    S --> M2["跳板机后的内网服务器"]

    classDef port fill:#312e81,stroke:#818cf8,color:#e0e7ff
    classDef impl fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    class CORE port
    class L,S impl
```

端口能力：`probe` / `exec` / `streamExec` / `shell` / `fs` / `close`。**上层永远不知道对面是本机子进程还是三跳之外的机器。**

---

## 6. 多跳链

```mermaid
flowchart LR
    APP["本机 deploy-kit"]
    H1["hop① jump.example.com:22<br/>agent 认证"]
    H2["hop② 10.8.0.7:22<br/>password 认证"]
    CMD["远端命令"]

    APP -- "Client①.connect()" --> H1
    H1 -- "forwardOut → direct-tcpip" --> H2
    H2 -- "exec('nginx -t')" --> CMD
    APP -. "Client②.connect({ sock: ①转发的流 })" .-> H2

    classDef hop fill:#1e293b,stroke:#38bdf8,color:#e2e8f0
    class H1,H2 hop
```

每跳独立：认证、主机密钥、**crypto 协商**（任意一段不抗量子，整条链就被拉低）、超时、保活。关闭必须逆序。

---

## 7. 提权决策

```mermaid
flowchart TB
    A["become"] --> B{"已是目标用户?"}
    B -->|是| NONE["不包装"]
    B -->|否| C{"method"}
    C -->|auto| D["探测 sudo -n true"]
    D -->|成功| NOPW["sudo -n：全程免密"]
    D -->|失败| E{"有凭据?"}
    E -->|有| F{"能走 stdin?"}
    F -->|是| STDIN["sudo -S -p '' + stdin 注入<br/>仍用 exec 通道"]
    F -->|否：su / requiretty| PTY["shell() 开 pty<br/>匹配提示符应答 · 复用会话"]
    E -->|无| ERR["报错 + 建议<br/>不回落到不安全模式"]

    classDef good fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    classDef warn fill:#422006,stroke:#f59e0b,color:#fef3c7
    classDef bad fill:#450a0a,stroke:#f87171,color:#fee2e2
    class NOPW,STDIN good
    class PTY warn
    class ERR bad
```

---

## 8. 传输：协商 + 流式流水线

```mermaid
flowchart TB
    subgraph SEL["① 协商（纯函数：policy + facts → decision）"]
        S{"显式 strategy?"} -->|否| P{"facts：双方 rsync?"}
        P -->|是| R["rsync + dp-rsh 隧道"]
        P -->|远端有 tar+gzip| T["tar-ssh"]
        P -->|都没有| SF["sftp 镜像"]
    end
    subgraph PIPE["② 流水线（本机不落地）"]
        W["walk（只 stat）"] --> Q["有界并发队列"]
        Q --> RD["读流 chunk=64KB"]
        RD --> HA["哈希旁路 → releaseId"]
        HA --> Z{"压缩 adaptive"}
        Z --> OUT["出口分帧"]
        OUT --> CH["SSH 通道（背压）"]
        CH --> REM["远端落盘 + checksums"]
    end
    SEL --> PIPE

    classDef out fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    class R,T,SF,CH,REM out
```

---

## 9. Release 布局与原子切换

```mermaid
flowchart LR
    subgraph TREE["远端 /srv/web"]
        REL["releases/<br/>20261001-a1b2c3d4/<br/>20260930-9f8e7d6c/"]
        SH["shared/.env · uploads/"]
        CUR["current → releases/20261001-a1b2c3d4"]
        DP[".dp/<br/>lock · index.json · checksums · trace/"]
    end
    subgraph SW["切换：必须原子"]
        A["ln -s releases/<id> .current.new"] --> B["mv -T .current.new current"]
    end

    classDef box fill:#1e293b,stroke:#38bdf8,color:#e2e8f0
    class REL,SH,CUR,DP box
```

`ln -sfn` 不原子（中间有一帧没有 `current`）。busybox 无 `mv -T`、Windows 无权限建软链时按 Facts 退化到 `rename` / `copy`，**并明确告知这次不是原子切换**。

---

## 10. 目标适配器契约

```mermaid
flowchart TB
    T["target: static / nginx / docker / delegate / 未来"]
    T --> I["planInstall：渲染 conf · shared 链接 · 权限"]
    T --> AC["planActivate：原子切换 / compose up / unit enable"]
    T --> V["planVerify：HTTP · 容器 · nginx -t · fileExists"]
    T --> RB["planRollback：默认条旧 release + 恢复 conf/env/port"]
    I --> UA["每一步都带 unwind（撤销项）"]
    AC --> UA
    UA --> TX["交给事务协调器"]

    classDef box fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    class I,AC,V,RB,UA,TX box
```

四种落地语义，同一个契约：**干货只差 install 阶段做什么。**

---

## 11. nginx：影子校验 + 两步 `-t`

```mermaid
sequenceDiagram
    participant D as deploy-kit
    participant H as 主机
    participant N as nginx

    D->>H: 渲染候选 conf → 影子目录
    D->>N: nginx -t -c <影子主配置>（第一步：语法 + include 树）
    alt 校验失败
        N-->>D: fail
        D-->>D: 报错退出，生产目录零改动
    else 通过
        N-->>D: ok
        D->>H: 检查目标文件是否带托管标记（没有则拒，除非 force）
        D->>H: 原子替换 → 第二步 nginx -t（整棵树）
        D->>N: reload（systemd / signal / command）
    end
```

---

## 12. 容器：四种供给方式

```mermaid
flowchart TB
    SRC["release（Dockerfile / compose）"] --> M{"target.mode"}
    M -->|build-push| A["构建机 buildx --platform"] --> B["push registry<br/>tag: ${git.sha}"] --> C["各主机 pull"]
    M -->|build-load| D["本机 docker save → SSH stdin"] --> E["远端 docker load"]
    M -->|remote-build| F["各主机各自构建"]
    M -->|image-only| G["只 pull 现成镜像"]
    C --> UP["compose up -d --wait"]
    E --> UP
    F --> UP
    G --> UP
    UP --> VER["验收：容器 healthy + mount + 端口 + 镜像 digest"]

    classDef box fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    class A,B,C,D,E,F,G,UP,VER box
```

---

## 13. 集群扇出与并发隔离

```mermaid
flowchart TB
    DEP["一次 dp deploy --all"] --> G["按 project 分组"]
    G --> P1["project A<br/>host: 3 台 · rolling batch=1"]
    G --> P2["project B<br/>host: 1 台"]
    G --> P3["project C<br/>host: 2 台 · canary"]
    P1 -.->|并行| P2
    P2 -.->|并行| P3
    P1 --> LK["lockKey = hash(hostId, release.root)"]
    P2 --> LK
    P3 --> LK
    LK --> NS["命名空间隔离：<br/>incoming-* · trace · IPC token · conf 文件名 · unit 名"]
    NS --> POOL["SSH 连接复用（exec 通道共享）<br/>pty 提权会话不可共享"]

    classDef box fill:#1e293b,stroke:#38bdf8,color:#e2e8f0
    class LK,NS,POOL box
```

---

## 14. 源产物识别与分流

```mermaid
flowchart TB
    S["源"] --> K{"魔术字节识别"}
    K -->|目录| D["常规流式传输"]
    K -->|tar / tar.gz / xz| T["远端解包（拒绝绝对路径/../逃逸链接）"]
    K -->|zip / 7z / rar| Z["按 facts 选 bsdtar > unzip > 7z"]
    K -->|deb / rpm / apk| P["架构校验 → --test 预演 → 安装（不可逆·需显式允许）"]
    K -->|iso / img| I["优先提取；必要时 loop 挂载（带 umount 清理）"]
    K -->|elf / 单文件| F["直传 + 权限 + 可执行性验收"]
    K -->|未知| U["报错并提示 source.kind"]

    classDef bad fill:#450a0a,stroke:#f87171,color:#fee2e2
    classDef warn fill:#422006,stroke:#f59e0b,color:#fef3c7
    classDef ok fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    class U bad
    class P,I warn
    class D,T,Z,F ok
```

---

## 15. 预检 → 事务 → 验收：三道门

```mermaid
flowchart TB
    C1["连接 + Facts"] --> LOCK["取锁（预检期间唯一的写）"]
    LOCK --> PRE["① 预检：连接/加密 · 权限实证 · 磁盘 · 端口 · 依赖 · conf 冲突 · 架构"]
    PRE -->|FAIL| EXIT["解锁 · 零副作用 · exit 3/4"]
    PRE -->|PASS| PLAN["② plan + unwind（回滚计划）"]
    PLAN --> CG["③ 提交前复检：空间/可写/锁持有"]
    CG -->|FAIL| EXIT
    CG -->|PASS| DO["④ 实施（流式写入 .incoming → 校验 → rename）"]
    DO --> VER["⑤ 验收"]
    VER -->|失败| ROL["⑥ 逆序补偿 + 取证"]
    VER -->|通过| FIN["⑦ reload · prune · 解锁 · exit 0"]

    classDef gate fill:#422006,stroke:#f59e0b,color:#fef3c7
    classDef bad fill:#450a0a,stroke:#f87171,color:#fee2e2
    classDef good fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    class PRE,CG,VER gate
    class EXIT,ROL bad
    class DO,FIN good
```

**最好的回滚，是根本不需要回滚**：三条禁令 —— 环境不猜、target 冲突不猜、空间不够不开始。

---

## 16. 事务状态机

```mermaid
stateDiagram-v2
    [*] --> Preparing
    Preparing --> Running: 快照完成 + 加锁成功
    Running --> Committing: 全部步骤成功
    Running --> Compensating: 任一步失败
    Committing --> Committed: 验收通过
    Committing --> Compensating: 验收失败
    Compensating --> RolledBack: 撤销全部成功
    Compensating --> NeedsHealing: 存在不可撤销项 / 撤销失败
    RolledBack --> [*]: exit 2
    Committed --> [*]: exit 0
    NeedsHealing --> [*]: 保留现场 + 告警 + 给出人工下一步
```

`NeedsHealing` 是诚实承认失败的状态，不允许被吞掉。三类 unwind：`none` / `compensate` / `snapshot` / `irreversible`（后者 plan 期必须显式允许）。

---

## 17. 验收裁决

```mermaid
flowchart TB
    O["观测：容器状态 / HTTP / TCP / 命令 / 文件 / mount / 端口 / 镜像 digest"]
    O --> SM["容器状态机：<br/>starting→healthy（轮询）<br/>重启循环=失败<br/>无 healthcheck 不算健康"]
    SM --> SET["settle 窗口：稳定才能算数"]
    SET --> AG{"聚合"}
    AG -->|critical 失败| FAIL["整体失败 → 回滚"]
    AG -->|失败数 > maxFailed| FAIL
    AG -->|全部通过| OK["成功"]
    AG -->|少量失败且 quorum 允许| WARN["降级接受 + 显著告警"]

    classDef bad fill:#450a0a,stroke:#f87171,color:#fee2e2
    classDef good fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    classDef warn fill:#422006,stroke:#f59e0b,color:#fef3c7
    class FAIL bad
    class OK good
    class WARN warn
```

判定逻辑保持**纯函数**（观测 → accept / reject / warn），于是可以像 `plan()` 一样做矩阵快照测试。

---

## 18. 扩展点：按名字查注册表

```mermaid
flowchart TB
    CFG["配置里的字符串 key"] --> REG["registry"]
    REG --> H["host.type：ssh / local / docker-exec …"]
    REG --> TR["transport.strategy：rsync / tar-ssh / sftp / local …"]
    REG --> BT["become.type：none / sudo / su / doas / custom"]
    REG --> AU["auth.type：key / agent / password / kbdint"]
    REG --> TG["target.type：static / nginx / docker / delegate / caddy …"]
    REG --> SE["secretRef scheme：env / file / prompt / cmd / vault …"]
    REG --> HOOK["hooks：阶段名"]

    classDef reg fill:#312e81,stroke:#818cf8,color:#e0e7ff
    class REG reg
```

**规则：不许出现 `switch(type)` 的第二个分支 —— 新能力一律是「新包 + 一次注册」。** 同名重复注册默认报错（`allowOverride` 仅给测试用）。

---

## 19. 工程质量门禁与发布

> ⚠️ **这张图画的是目标流水线，不是当前状态**：其中的 eslint、依赖检查工具、死代码检查、
> vitest、ESM/UMD 双产物、包 smoke、changesets **都还没接入**。当前真正跑的只有
> `tsc -b` 与 `node --test`（见 README 的「质量门禁」表）。

```mermaid
flowchart LR
    PR["PR"] --> TS["tsc --noEmit<br/>源码 + 测试两个 project"]
    TS --> LINT["eslint<br/>import 边界 4 条铁律"]
    LINT --> CRUISER["依赖检查<br/>无循环 · 无非法方向"]
    CRUISER --> DEAD["死代码/未使用导出检查"]
    DEAD --> TEST["vitest<br/>纯逻辑包四项 100%"]
    TEST --> BUILD["构建产物 ESM/UMD + .d.ts"]
    BUILD --> SMOKE["包 smoke：入口存在 · CJS/ESM 双导入"]
    SMOKE --> PW["verify 通过 → 合并"]
    PW --> CS["changesets 自动算版本"]
    CS --> PUB["pnpm publish（--provenance）"]
    PUB -.-> NIGHT["nightly：变异测试 + 真实 sshd/nginx/docker 集成"]

    classDef good fill:#134e4a,stroke:#2dd4bf,color:#ccfbf1
    classDef edge fill:#422006,stroke:#f59e0b,color:#fef3c7
    class PW good
    class NIGHT edge
```

`verify` 的顺序不能改：产物层的检查必须在 build 之后。
