# 决策清单（第 3–24 条）

格式：每条给**决策 / 理由 / 落点**。有实测依据的标注来源。

---

## 0 · 永不交互（最高优先级，压过下面所有条）

**起因**：一次 push 用了不含 token 的 remote，触发 Git Credential Manager 弹 GUI 让用户手点。这是不可接受的——**任何弹窗都意味着那次"自动化"根本不是自动化**，且在 CI 里会表现为永久挂起。

**决策**：deploy-kit 自身、以及本项目开发过程，**都不允许出现任何等待人类输入的行为**。

三条落地机制：

1. **凭据必须带外提供，绝不依赖交互提示**
   - git：所有远程操作加 `GIT_TERMINAL_PROMPT=0` → 缺凭据时**立刻失败**而不是弹窗
   - ssh 走密钥：`-o BatchMode=yes -o IdentitiesOnly=yes -o NumberOfPasswordPrompts=0`
   - ssh 走密码：`SSH_ASKPASS=<我们生成的助手> SSH_ASKPASS_REQUIRE=force` + stdin 重定向到 null
   - 两者都不满足 → **直接报错，不去尝试提示**

2. **远端命令的 prompt 嗅探**（这是产品级能力，不只是开发纪律）
   远端若吐出提示符而我们没预期，`dp` 必须杀掉进程并报结构化错误，而不是一直等：
   ```
   DP.INTERACTIVE_PROMPT_DETECTED  匹配到 "Password:" / "[sudo] password" / "Are you sure you want to continue connecting"
   ```
   检测模式可由用户扩展（不同发行版 `su` 措辞不同，我们不穷举）。

3. **一切子进程必须有超时兜底**
   连接、exec、传输、验收、hook 全部带 `timeout`。挂起 = 失败，不允许"可能一直在等"。

**推论**：`sudo` 一律先 `sudo -n` 探测是否免密，需要密码时用 `sudo -S -p ''` **主动投喂**，绝不等它问。主机密钥策略必须预置（`strict` 或显式 `accept-new`），不允许出现 `yes/no` 确认。

---

## 3 · Java / Python 部署；systemd 与 initrc 可同时设置

**决策**：引入 **runtime profile（运行时画像）** 与 **supervisor（进程管理层）** 两个正交维度。

- `runtime`：`node` / `java` / `python` / `static` / `docker` / `other`
  每个 profile 提供：detect 证据、默认 build 命令、产物形态、默认健康检查、默认资源预算、unit 模板默认值。
  - Java：检测 `pom.xml` / `build.gradle` / `*.jar`；`MemoryMax` 按 `Xmx × 1.35` 算（直接对症第 14 条的 OOM）；单元默认 `ExecStart=java -jar`
  - Python：检测 `requirements.txt` / `pyproject.toml` / `Pipfile` / `poetry.lock` / `uv.lock`；venv 路径、gunicorn/uvicorn 入口
- `service.managers`：允许**同时配置多个**，运行时按探测结果激活实际存在的那个

```ts
service: defineService({
  managers: ['systemd', 'sysvinit', 'openrc', 'supervisor'], // 偏好链，见第 5 条
  // 全部会被渲染出来，只有探测到的那个被激活；其余作为 fallback 留在目标机上
})
```

**理由**：老 CentOS 6 只有 sysvinit，Alpine 是 OpenRC，容器里可能什么都没有。同时写多个 = 一份配置走天下，且"写了但不激活"不会有任何副作用。

**落点**：`docs/config.md` runtime 段；新包 `@dp/target-service` 渲染层。

---

## 4 · 每个配置段提供独立 `define*`

**决策**：所有顶层段都有同名 `define*` 函数，全部是 identity function（运行时零成本），只提供类型推导与可选的即时校验。

```
defineConfig  defineHost  defineAuth  defineJump  defineTransport
defineSource  defineBuild  defineRuntime  defineService  defineTarget
defineNginx   defineDocker  defineVerify  defineHook  defineNotify
defineEnv     defineResources  defineLsm
```

每个都支持跨文件复用：`export const prodHost = defineHost({...})`，配置里直接引用。

**理由**：类型提示、可跳转、可组合。`define*` 不做事，所以不会成为性能或调试负担。

**落点**：`@dp/schema` 导出全部 `define*`；`dp schema --emit` 输出 JSON Schema。

---

## 5 · 偏好链（preference chain）+ 链内不支持时的友好报错

**决策**：统一抽象 `resolveChain(kind, candidates)`，应用于 transport / jump / transfer / supervisor / runtime / target / lsm。

```ts
transport: ['native-ssh', 'ssh2']   // 依次尝试
jump:      ['direct-tcpip', 'nc', 'ssh-relay']
transfer:  ['rsync', 'tar-ssh', 'sftp', 'scp']
```

全链失败时输出**结构化错误**（不是"failed"）：

```
DP.CHAIN.EXHAUSTED  kind=transport
  ├ native-ssh   ✗ 未找到 ssh 可执行文件（PATH 中无 ssh）
  ├ ssh2         ✗ cryptoPolicy=pq-required，但 ssh2 不支持任何 PQC KEX
  └ 建议：安装 OpenSSH ≥9.9，或将 cryptoPolicy 降为 pq-preferred（会失去抗量子）
```

每项带：名称、失败原因、**可执行建议**。机器可读（`--json`）。

**理由**：这一条是被 spike 逼出来的（S1/S4）。多跳和抗量子都无法用单一实现覆盖。

---

## 6 · CLI 支持指定配置文件

```
dp deploy -c ./deploy/prod.ts
dp deploy --config ./deploy/prod.ts --env prod --target web-01
DP_CONFIG=./deploy/prod.ts dp deploy
```
优先级：`-c` > `DP_CONFIG` > 自动发现（`deploy.config.ts|js|json` 向上冒泡）。`--config` 与自动发现冲突时明确报错，不静默。

---

## 7 · 结构化日志 + 兼容 OpenTelemetry

**决策**：`@dp/log` 输出 **JSONL**，核心**不依赖** OTel 包（保持零依赖），但字段设计对齐 OTel 语义约定，桥接由可选包提供。

```jsonl
{"ts":"...","level":"info","msg":"transfer.begin","deployId":"d-7f3a","host":"web-01","phase":"transfer","span":"s-2","attempt":1,"bytes":1048576}
```

- 固定字段：`ts / level / msg / deployId / host / phase / span / attempt`
- **内置脱敏**：密码、私钥、token 按 key 名 + 值模式双重识别，命中即 `***`
- `--log-format=json|pretty|logfmt`、`--log-level`、`--log-file`
- OTel 桥接：`@dp/log-otel`（可选依赖）把 span 导出为 OTLP；不装则完全不加载

**理由**：OTel 是重依赖，不能进核心；但字段现在就对齐，以后桥接零成本。

---

## 8 · 通知 / Hook 扩展

**决策**：生命周期事件 + 驱动注册表。

事件：`pre-resolve` `pre-connect` `post-connect` `pre-transfer` `post-transfer` `pre-activate` `post-activate` `on-verify` `on-promote` `on-failure` `on-rollback`

驱动：`exec`（本地命令）、`webhook`、`email(smtp)`、`js`（用户函数）

每个 hook 必配：`onFailure: 'abort' | 'warn' | 'ignore'`、`timeout`。默认 `warn`（通知失败不该搞挂部署）。Hook 收到的 payload 是**脱敏后**的结构化事件。

---

## 9 · 跨平台命令：wrapper + 用户覆盖

**决策**：分三层。

1. **抽象动作**：内置常见操作用动作名表示（`ensureDir` `setMode` `setOwner` `symlink` `remove` `serviceReload` `configTest`），由平台映射表翻译
2. **shell 适配**：远端 shell 可能是 `sh/bash/zsh/powershell/cmd`——**引号规则按目标 shell 生成，不许手工拼串**（安全相关）
3. **用户覆盖**：`commands.overrides.perPlatform: { linux, darwin, win32 }` 或按 `osFamily`/`distro` 细化

```ts
commands: {
  configTest: { perPlatform: { linux: 'nginx -t', win32: 'nginx.exe -t' } }
}
```

**理由**：你不可能猜对所有人环境；但内置常见操作能覆盖 90%，剩下 10% 用覆盖解决。

---

## 10 · SELinux

**决策**：`@dp/lsm` 包，驱动 `selinux` / `apparmor` / `none`。三个必须处理的点：

1. **文件上下文**：新部署的文件 `cp` 过去后上下文不对 → nginx 读不了，**即使 chmod 0777 也没用**。部署后必须 `restorecon -R`（或 `chcon -t httpd_sys_content_t`）
2. **端口上下文**：非标端口要 `semanage port -a -t http_port_t -p tcp 8080`，否则服务起不来
3. **布尔值**：反代场景 `setsebool -P httpd_can_network_connect 1`

预检查：`getenforce`、`ls -Z` 目标目录、`semanage port -l`。
**`semanage` 不存在时给可执行建议，不静默跳过**——"看起来部署成功了但 403"是最难查的故障。

---

## 11 · Node ≥ 24

**决策**：`engines.node: ">=24"`，`.nvmrc` 写 `24`，CI 与 `dp doctor` 都校验。

**修正一条之前的说法**：Node 版本**不是**抗量子的门槛（ssh2 根本没实现 PQC，与 Node 版本无关）。但 Node 24 仍然要，理由是语言/API 一致性（`import attributes`、测试运行器等），且已在本机备好 24.21.0。

---

## 12 · 支持 ssh_config

**决策**：`@dp/ssh-config` 解析 `~/.ssh/config`（含 `Include`），映射：

| ssh_config | 我们 |
|---|---|
| `Host` / `HostName` / `Port` / `User` | 直接映射 |
| `IdentityFile` | privateKey |
| `ProxyJump` | jump 链 |
| `ProxyCommand` | 若形如 `ssh -W`/`nc`，转内部实现；否则 **显式报错不支持** |
| `StrictHostKeyChecking` / `UserKnownHostsFile` | 主机密钥策略 |
| `KexAlgorithms` / `Ciphers` | cryptoPolicy 合并 |

**关键**：ssh_config 只在 `native-ssh` 驱动下能"原生透传"；`ssh2` 驱动下由我们自己解释，遇到不支持的指令必须报错而不是忽略。

---

## 13 · scp（确实漏了，补上）

**决策**：`@dp/transfer` 四个驱动，scp 是最后一个：

| 驱动 | 依赖 | 增量 | 何时用 |
|---|---|---|---|
| `rsync` | 本机 rsync + 远端 rsync | ✅ | 首选 |
| `tar-ssh` | 远端 tar/gzip | ❌ | 本机无 rsync |
| `sftp` | 远端 sftp 子系统 | ❌ | 通用兜底 |
| `scp` | 远端 scp | ❌ | **只需 exec 权限**，sftp 子系统被禁时的最后手段 |

注意：OpenSSH ≥9 的 `scp` 默认走 SFTP 协议，要兼容老目标需 `scp -O`（实测目标机支持 `-O`）。

---

## 14 · 故障边界

→ 见 **`docs/failures.md`**（已单独成文）。结论不是重写架构，而是加**护栏层** + 三机制：目标机状态日志、带租约的部署锁、两阶段激活 `trial→promote`。

---

## 15 · `./dist` 还是 `./dist/**`

**决策**：**歧义靠拒绝，不靠默认值。** 尾斜杠写法直接报错。

| 写法 | 语义 |
|---|---|
| `"./dist"` | 目录本身 → 部署成 `<dest>/dist/...` |
| `"./dist/**"` | 目录内容 → 部署成 `<dest>/...`（不含 dist 这层） |
| `"./dist/*"` | 下一层内容（不含子目录递归） |
| `"./dist/"` | ❌ **报错**：`DP.SOURCE.AMBIGUOUS`，提示改用上面两种 |
| `"./dist/**/*.js"` | 递归匹配 .js |

报错要给出两种写法的预览差异（"你会得到 `<dest>/dist/index.html`，如果改成 `./dist/**` 则是 `<dest>/index.html`"）。

**理由**：rsync 的 `src` vs `src/` 是几十年的经典陷阱。与其猜，不如让它无法被误写。

---

## 16 · 安全加固（路径 / 文件 / 权限信任）

- **路径**：所有路径先 `realpath` 归一化，必须在允许根（allowlist）内；拒绝 `..` 逃逸、拒绝符号链接指向根外（`O_NOFOLLOW` 语义）
- **TOCTOU**：校验与写入之间不允许重新解析路径——先 `open` 拿到 fd 再校验 fd
- **权限**：显式 `mode`（默认文件 `0640`、目录 `0750`），**拒绝 `0777`/`0666`**；umask 显式设置；临时目录 `0700`
- **完整性**：传输后校验 sha256，不匹配即整体作废（staging 丢弃，不动 current）
- **凭据**：不落盘、不进日志（见第 7 条脱敏）、SSH_ASKPASS 助手文件 `0700` 且用完即删
- **主机密钥**：默认 `strict`，`knownHosts: none` 必须显式打开并被 `dp check --security` 列出
- **目录链逐层校验**：不只看目标路径本身的 mode，要**从根逐级校验 owner + 可写性**。两处必检：① 带外脚本路径 `/usr/libexec/dp/`（提权面，`DP.SEC.RESCUE_UNSAFE_PATH` → 拒绝）② 状态路径 `/var/lib/dp/`（伪造租约锁 = 可用性攻击）。**这是预检项，不是运行时警告**
- **代码/数据分离**：被 root 定时执行的代码与可变数据**不得同目录**。状态文件取出的值只作引用过的参数 + allowlist 校验，永不 `eval`。详见 `security.md` §6.2 与 `failures.md` §7.1

---

## 17 · 测试全面性

在 `docs/testing.md` 五层基础上**再加三层**：

6. **故障注入层**：用 podman 靶机真实注入——`AllowTcpForwarding no`、`busybox su`、磁盘写满、只读目录、服务 crash loop、网络中断
7. **契约层**：把 spike 的结论固化成回归测试——rsync `--rsh` argv 契约、`%h` 不替换、不经 shell、scp `-O` 兼容
8. **矩阵层**：`{linux, darwin, win32} × {systemd, sysvinit, openrc, none} × {rsync, tar-ssh, sftp, scp} × {sudo, su, root, none}`

覆盖率产物 → `build/coverage/`。

---

## 18 · CLI 帮助（对人 + 对 agent）

- 每个命令/子命令都有 `description`、`examples`（可直接复制）、`exit codes`
- `--help` 分级：`dp --help` / `dp deploy --help` / `dp deploy --help=config`
- **`--json`**：所有命令支持机器可读输出（agent 用）
- **稳定 exit code**：`0` 成功 / `1` 通用失败 / `2` 配置错误 / `3` 预检失败 / `4` 传输失败 / `5` 验收失败 / `6` 已回滚 / `7` 并发锁占用
- `dp explain`：打印解析合并后的**有效配置**（含来源文件与行号）——排查"为什么这个值生效了"
- `dp schema --emit`：导出 JSON Schema 供编辑器提示

---

## 19 · 产物统一进 build 目录

```
build/
  packages/<pkg>/dist/      # 每个包的编译产物（published files 指向这里，相对路径 dist）
  coverage/                 # 覆盖率
  spikes/                   # spike 输出
  reports/
```
每个包 `outDir` 指向 `build/packages/<pkg>/dist`，`files` 字段写 `["dist"]`——**不直接写 `build`**（否则测试产物会进发布包）。

---

## 20 · 所有包统一版本

`pnpm-workspace.yaml` + changesets **`fixed` 分组**，一次性 bump 全部包；`dp version` 可查看。CI 校验"同一次提交内所有包版本号一致"。

---

## 21 · 精简 scripts

合并原则：能加 flag 的就不新建脚本；该是测试的就写成测试。

```
dev  build  test  lint [--fix]  typecheck  format [--check]  doc  release
```
（目标是 ≤10 个，且 `lint --fix` / `format --check` 这类只留一个入口）

---

## 22 · AGENTS.md 与 agents/skills

- 根目录 `AGENTS.md`：仓库约定、命令、目录职责、提交规范（**保持 <100 行**）
- `.agents/skills/`：**只放真正可复用的操作流程**（如 `dp-spike-env` 靶机环境搭建），不堆积说明性文档

---

## 23 · 临时文件与 Git

- 所有临时物进 `.tmp/`（已在 `.gitignore`）
- 仓库：https://github.com/imere/deploy.git ，代理 `127.0.0.1:<代理端口>`
- 提交节奏：spike 结论落地即提交一次，不等到大段完成
- **凭据不入库**：PAT 只在推送时用，随后把 remote URL 改回不带 token 的形式

---

## 24 · deno / bun 兼容

**分层回答**：

| 层面 | 结论 |
|---|---|
| 我们自己的运行时 | **只承诺 Node ≥24**（用 node: 内建模块 + TS） |
| 用户项目是 deno/bun | ✅ 支持：detector 识别 `deno.json` / `bun.lockb` / `bun.lock`，调用 `deno task build` / `bun run build` |
| 部署产物 | 无论什么运行时，产物都是静态文件 → 后续链路完全一致 |

**理由**：部署工具关心的是"产物"，不是"用什么构建"。识别 + 给正确的 build 命令就够了，成本极低。
**做不到也不做的部分**：把 deploy-kit 自身跑在 deno/bun 上——不承诺。

---

## 附 · 与 Ansible / Terraform 的关系

| | Terraform | Ansible | **deploy-kit（本）** |
|---|---|---|---|
| 干什么 | 供给基础设施 | 配置/编排主机状态 | **发布产物到已存在的机器** |
| 模型 | 声明式 IaC，plan/apply | 声明期望状态，幂等 | 事务式发布，版本化 + 原子切换 |
| 传输 | 不传文件 | 传文件（**无增量同步**） | rsync 增量 / 断点续传 |
| 发布事务 | 无 | 无原生 release 概念 | release 目录 + 原子切换 + 回滚点 |
| 类型安全 | HCL | YAML | **TS 类型 + define\* 提示** |
| 依赖 | 云端 API | Python + SSH | 零目标端依赖（tar/sftp/scp 兜底） |

**结论：不是同一层的东西，不冲突，是上下游。**
Terraform 造机器 → Ansible 装环境 → **deploy-kit 发应用**。可以协作：Terraform 的 output 直接喂给 deploy-kit 的 hosts。

**明确借鉴**：
- Terraform 的 `plan` / `apply` 两段式 → 我们的 `dp plan` / `dp deploy`
- Ansible 的 `--check`（dry-run）、`--limit`、`handler/notify`、`vault` 加密凭据、`tags`
- Ansible 我们**不借鉴**的：目标端必须装 Python。我们坚持零目标端依赖。

**我们补上 Ansible 没做好的**：增量传输、发布事务性、资源护栏注入、两阶段激活、抗量子协商策略。
