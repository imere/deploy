# 故障分类学与运行时护栏

> 回答第 14 条：死锁文件、传输中断、内存耗尽夯机、守护进程固化坏状态、磁盘写满的连带故障……
> 结论写在最前面：**不需要重写架构，但必须新增一层"护栏（guard）"和三个机制**。

---

## 1. 先看清问题的性质

你踩过的那几个坑有一个共同点：**它们都不发生在传输阶段，而发生在"服务已经起来了之后"**。

传统部署工具（ansible、capistrano、fabric）把"启动服务"当作终点。但真正的灾难恰恰在终点之后：

| 你遇到的现象 | 表面原因 | 真正的原因 |
|---|---|---|
| 项目启动后内存不足，机器夯死 | 程序吃内存 | **没有给服务设资源上限**，内核 OOM 时谁都可能被杀，包括 sshd |
| 重启后系统还是不可用 | 程序有 bug | **服务被 enable 了开机自启**，坏状态被固化进启动流程 |
| 磁盘不足导致程序无法写 | 磁盘小 | **预检查只看"当前剩余"，没算部署要占多少、也没留余量** |
| bash tab 补全也报错 | 无关故障 | 磁盘满的**连带症状**——说明"能连上"不等于"可写" |
| 死锁文件 | 文件被占用 | **就地覆盖**这个动作本身就是错的，应该永不覆盖正在使用的文件 |

看出规律了吗？**前两条是"激活之后失控"，后三条是"预检不够实证"。** 两条路线分别对应下面两个新增机制。

---

## 2. 架构增量（三件东西，不推翻现有分层）

### 2.1 目标机状态日志 `state journal`

路径：`/var/lib/dp/state/<project>/journal.jsonl`，append-only，每步一行。

```jsonl
{"ts":"...","deployId":"d-7f3a","step":"transfer","status":"begin","host":"web-01"}
{"ts":"...","deployId":"d-7f3a","step":"activate","status":"begin","trial":true}
```

**为什么必须有**：机器夯死、网络断开、进程被杀之后，`dp` 本地什么都不知道了。有这份日志，`dp status --remote` 连上去（哪怕机器半死）就能读出"卡在哪一步、trial 是否已激活、回滚点在哪"。没有它，崩溃恢复只能靠猜。

### 2.2 带租约的部署锁（不是锁文件，是租约）

```json
{ "holder": "d-7f3a", "pid": 4122, "leaseExpiresAt": "...", "heartbeatAt": "..." }
```

- 锁有 **TTL**，持有者必须心跳续约；持有者死了，锁在 TTL 后自动过期。
- 解决"半途断开 → 锁文件残留 → 之后所有部署都卡住"。
- 获取锁失败时报 `DP.LOCK.HELD`，并打印**持锁者的 deployId 和 age**，让人能判断是并发还是僵尸。

### 2.3 两阶段激活 `trial → promote`（解决"重启后仍不可用"的核心）

```
deploy  ──►  以 trial 态启动  ──►  健康检查连续通过  ──►  promote（才 enable 开机自启）
                   │                                          │
                   └───── trialTimeout 内未 promote ──► 自动停用 + 切回上一版
```

关键点：**`systemctl enable`（开机自启）必须是 promote 的一部分，绝不能在启动时就做。**

这样做之后，你遇到的那个场景会变成：程序吃内存 → 机器夯死 → 重启 → **新服务不会自动起来**（从未 enable），系统回到旧版本，ssh 正常可用。灾难被降级成一次失败的发布。

配套的 `dp-trial-guard` 定时器随服务一起投递，是独立的兜底——即使 `dp` 进程本身挂了，它也会在超时后自动回滚。

---

## 3. 资源护栏注入（让 OOM 杀不掉机器）

`@dp/target-service` 生成的 unit **必须**包含这些，且按 runtime profile 自动算值：

| 指令 | 取值 | 作用 |
|---|---|---|
| `MemoryMax` | profile 计算（Java: `Xmx × 1.35`；Node: `--max-old-space-size × 1.3`） | **OOM 时内核只杀这个 cgroup，sshd 不受影响** |
| `MemoryHigh` | `MemoryMax × 0.85` | 提前触发回收，避免骤死 |
| `CPUQuota` | 可选，默认不限 | 防 CPU 打满导致 ssh 卡顿 |
| `TasksMax` | 默认 `512` | 防进程/线程泄漏拖死 pid 表 |
| `StartLimitBurst` / `StartLimitIntervalSec` | `5` / `60s` | **防 crash loop 风暴** |
| `Restart` | `on-failure`（**默认不用 `always`**） | `always` 会把"启动即崩"变成无限重启 |
| `OOMScoreAdjust` | `0`（服务）/ `-100`（不调整 sshd） | 保证 OOM 优先杀服务 |

一个必须写进文档的判断：**如果你给服务配了 `Restart=always` 而没有 `StartLimitBurst`，你就亲手造了一个重启炸弹。** 这条要作为 `dp check --security` 的检查项。

---

## 4. 故障分类表（这是扩展的骨架）

每个故障有稳定 code，供 hook、通知、文档、测试用例共同引用。

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
| `DP.PORT.OCCUPIED` | 预检 | ✅ | abort（或 `portPolicy`） | `@dp/preflight` |
| `DP.FILE.LOCKED` | 传输/激活 | ⚠️ | 见 §5 | `@dp/target-*` |
| `DP.LOCK.HELD` | 并发 | ✅ | abort + 打印持锁者 | `@dp/core` |
| `DP.TRANSFER.INTERRUPTED` | 传输 | ❌ | 幂等重试 → abort | `@dp/transfer` |
| `DP.TRANSFER.CHECKSUM_MISMATCH` | 传输 | ❌ | abort（staging 作废） | `@dp/transfer` |
| `DP.ACTIVATE.START_FAILED` | 激活 | ❌ | 回滚到上一版 | `@dp/target-service` |
| `DP.VERIFY.HEALTH_TIMEOUT` | 验收 | ❌ | 回滚（trial 自动过期） | `@dp/verify` |
| `DP.RESOURCE.OOM_KILLED` | 运行期 | ❌ | 由护栏兜底 + 通知 | guard |
| `DP.GUARD.TRIAL_EXPIRED` | 运行期 | ❌ | 自动停用 + 切回 | guard timer |
| `DP.DISK.FULL_RUNTIME` | 运行期 | ❌ | 通知 + 可选自动 prune | guard |

**扩展方式**：三类注册表，用户可注册自己的实现——
`registerFailureDetector()` / `registerFailureHandler()` / `registerGuardrail()`。
硬编码进核心的只有上面这些**必然会发生的**，其余靠注册表长出来。

---

## 5. 死锁文件：根本解法是"永不覆盖正在使用的文件"

不要试图在"怎么覆盖一个被占用的文件"上做优化，那是死路。

- Linux 替换运行中二进制 → `ETXTBSY`，必然失败
- Windows 文件被进程持有 → rename 失败
- 日志文件被 tail/采集器持有 → 删不掉

**正解是 release 布局的必然推论**：每次发布写入**新的版本目录** `releases/<id>/`，切换靠符号链接或 unit 指向变更。旧版本的文件只有在没有进程打开它之后才被 prune——而判断依据不是猜，是 `lsof`/`fuser` 实证（或 Windows 的重启管理器探测）。

配置上保留策略开关，但默认走版本目录：

```ts
fileReplace: {
  strategy: 'version-dir' | 'in-place',   // 默认 version-dir
  onLocked: 'fail' | 'wait:30000' | 'stop-service',
}
```

选 `in-place` 时必须显式声明，并且预检会警告——因为它意味着你已经接受了"可能覆盖不了"这个事实。

---

## 6. 磁盘：预检查的是"部署之后还剩多少"

```
need = artifactSize × 2            // staging + release 各一份
     + retainedReleases × avgSize   // 保留的历史版本
need_inodes = fileCount × 2
pass 条件: afterFree >= max(minFreeBytes, total × minFreePercent)
        && afterInodes >= minInodes
```

还要做**实证写入**：真写一个临时文件、真建目录、真删掉。因为磁盘满时"能连上、能列目录，但写不进去"，只看 `df` 会漏。你遇到的 tab 补全报错就是这一类——它甚至不是部署动作自己失败，而是**环境已经退化到连交互 shell 都不可用**。

所以预检里有一条独立的 `DP.DISK.NOT_WRITABLE`，且 `dp doctor` 会把它和 tab 补全这类"看起来无关"的症状关联到同一根因。

---

## 7. 带外救援 `dp rescue`

机器半死时，正常部署链路已经走不通了。需要一条**极简、低资源、短超时**的通道：

- 不启动交互 shell（省资源、省时间）
- 单条 `exec`，超时 5s
- 能做四件事：mask 新服务 / 切回上一版 / 删除 trial guard / 强制释放租约
- **部署开始前就先把 `/var/lib/dp/rescue.sh` 投到目标机**——这样即使部署中途机器失控，脚本已经在那里了，可以借 cron/systemd timer/甚至手动执行来救命

命令形态：`dp rescue <host> --mask-service` / `--rollback` / `--release-lock`。

---

## 8. 与其他文档的分工

| 文档 | 承接内容 |
|---|---|
| `preflight.md` | §4 中所有"可预检 ✅"项的实现，§6 磁盘预算 |
| `transaction.md` | §2.1 日志、§2.2 租约锁、补偿动作编排 |
| `verify.md` | §2.3 健康检查与 promote 判据 |
| `targets.md` | §3 资源护栏注入、§5 版本目录替换 |
| `security.md` | 故障响应中的凭据处理、救援通道的鉴权 |

---

### 为什么"等待输入"要当成故障处理

远端吐出 `Password:` 而我们没预期时，进程会一直挂着——在 CI 里就是永久挂起，在桌面端就是弹窗让人手点。两者都不可接受。

所以 prompt 嗅探不是"锦上添花"，它和超时兜底一样是**把静默挂起转成显式失败**的机制：匹配到提示符 → 杀进程 → 报 `DP.INTERACTIVE_PROMPT_DETECTED` → 提示用户该配什么（比如"给 sudo 配 NOPASSWD，或提供 sudo 密码"）。

## 待确认

1. `trialTimeout` 默认给多少？我倾向 **10 分钟**——够人发现不对劲，又不至于让坏版本活太久。
2. `autoPromote` 默认开还是关？开着更顺手，但意味着"健康检查通过"被当作充分条件。你信你的健康检查吗？
