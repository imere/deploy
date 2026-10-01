# 权限模型：不假设 root

> 一条前提必须先钉死：**正常运维只有普通账号，最多有 sudo。** 任何"先取得 root 再谈别的"的设计，在真实机器上根本落不了地。

早期设计犯的错不是某个路径写错了，而是**模型层面默认了 root 存在**：`/usr/libexec/dp`、`root:root`、`root timer`、`/etc/systemd/system` —— 全是系统级路径，全需要 root。本文档把这一层纠正过来。

---

## 1. 核心转变：从「身份」到「能力集」

**不要问"我是不是 root"，要问"我实际能做什么"。**

`Facts` 里存的是一组**实证**出来的能力，不是从 uid 推出来的结论：

| 能力 | 实证方式 | 说明 |
|---|---|---|
| `canWrite[path]` | 建带随机后缀的临时文件后立刻删除 | 只读挂载 / SELinux / ACL 都能让"看着有"变成"实际没有" |
| `canChown[owner]` | `getent passwd` 存在性 + 试 chown 一个自己新建的文件 | 见 `preflight.md` §2.3 |
| `systemdScope` | `systemctl --user` 可用性 + `loginctl` linger 状态 | 决定 `system` / `user` / `none` |
| `canBindPrivilegedPort` | 实际试探绑定 | 普通用户绑不了 80/443 |
| `sudoAllowlist` | 逐条 `sudo -n <cmd> --dry-run` 式试探 | **能 sudo 哪几条命令**，而不是"能不能 sudo" |
| `become` | `sudo -n true` / `su -c true` 成败 | 见 `transport.md` §提权 |

实证优先于推断这条原则，和已有设计一致（提权从来都要求实证），这里只是**把它推广到所有能力**。

---

## 2. 三种布局（layout），由能力推导

**路径是推导结果，不是配置项。** 配置里不写系统路径，只写 `layout: 'auto'`（默认），由能力集推导出实际布局，并在 plan 里打印出来供核对。

| | **system** | **hybrid** | **user** |
|---|---|---|---|
| 触发条件 | become 成功到 root | 普通用户 + 受限 sudo | **纯普通用户，无 sudo** |
| 状态目录 | `/var/lib/dp/state/<proj>/` | `$XDG_STATE_HOME/dp/` | `$XDG_STATE_HOME/dp/` |
| 代码（rescue） | `/usr/libexec/dp/`<br/>Debian 系 `/usr/lib/dp/` | **不装**（带外救援不可用） | `$XDG_DATA_HOME/dp/` + 用户级 timer |
| release 根 | 用户配 `release.root`（如 `/srv/app`） | 同左 | **必须是用户可写**（如 `~/apps/<proj>`） |
| systemd | `/etc/systemd/system/` | 借 sudo 白名单投递 system unit | `~/.config/systemd/user/` |
| nginx confd | 用户配的路径 | 需 sudo 或目录组授权 | **不可达 → 报错** |
| 绑 80/443 | ✅ | ✅ | ❌ 只能走反向代理 |

XDG 未设置时的回落：`$XDG_STATE_HOME` → `~/.local/state`，`$XDG_DATA_HOME` → `~/.local/share`。

### 2.1 代码/数据分离原则在每种布局下都成立

上一轮定的原则不变，只是**两个域的具体路径随布局变**：

| 布局 | 代码域（不可被部署身份写） | 数据域（可写） |
|---|---|---|
| system | `/usr/libexec/dp/` `root:root 0755` | `/var/lib/dp/state/` |
| user | `~/.local/share/dp/` 该用户 own `0755` | `~/.local/state/dp/` |
| hybrid | 无（带外救援不启用） | `~/.local/state/dp/` |

注意 user 布局下的差异：代码域归**该用户自己**，但规则仍然是**不能被其他能部署的同组用户写** —— 所以校验条件从"root 拥有"改成通用的：

> **目录链每一级的 owner 必须等于布局所有者，且非 group/other 可写。**

目录链逐层校验、sha256 自校验、数据永不 `eval` 这三条在任何布局下都一样。

### 2.2 布局一致性（一个容易踩的坑）

同一台机器上，今天用 root 部署、明天改用普通用户部署，状态目录会变成 root 拥有 → 后者读都读不了。

**规则**：项目首次部署时把布局写进状态索引；后续部署若推导出的布局与记录不符 → 报 `DP.LAYOUT.MISMATCH` 并**中止**，提示要么保持一致，要么显式迁移（`dp host migrate --to user`）。

别让权限错乱在部署中途才暴露。

---

## 3. 三条不可绕过的约束（不许"想办法绕过"）

普通用户模式下有些事就是做不到。我们的职责是**提前说清楚并给建议**，不是偷偷 chmod 系统目录或自动改 sudoers。

### 3.1 端口 < 1024 绑不了

`canBindPrivilegedPort: false` 时只能：

1. **反向代理**（推荐）—— nginx 本身以 root 跑，应用监听高位端口
2. **一次性 `setcap cap_net_bind_service`** —— 需要 root，属于 `dp host prepare`
3. 改用高位端口

**我们绝不自动 setcap**，也绝不静默改端口。

### 3.2 系统 confd 写不进就是写不进

`/etc/nginx/conf.d/` 不可写 → 报 `DP.PERM.CONFD_NOT_WRITABLE`，并给出**三条建议**让用户自己选：

1. sudoers 白名单：只允许 `nginx -t` / `nginx -s reload`
2. 目录组授权：把 confd 组改成 deploy 组并 `g+w`（运维自己决定要不要这么做）
3. nginx 主配置里 `include` 一个**用户可写的目录**（多数场景最干净）

**我们不替用户 chown/chmod 任何系统目录。** 那不是部署工具该动的东西。

### 3.3 systemd user unit 没有 linger 就不会常驻

`systemdScope: user` 且 linger 未开启时，用户一注销服务就停。必须：

- 预检探测 linger 状态，未开启 → 告警 `DP.SYSTEMD.NO_LINGER`，明确告知"服务不会在注销后存活"
- 开启 linger（`loginctl enable-linger`）需要 root → 属于 `dp host prepare`，不是部署动作

这条特别重要：**用户级服务看起来部署成功了，第二天发现没了** —— 比直接失败更难查。

---

## 4. 配置表达

```ts
host: defineHost({
  sshUser: 'deploy',                      // 登录身份：永远不该是 root
  become: { type: 'sudo', user: 'root' }, // 可选。type:'none' = 纯用户模式
  layout: 'auto',                         // auto | system | user（默认 auto）
})
```

要点：

- **`sshUser` 默认不是 root**，示例里一律写普通账号
- **`become` 是可选的**，不是必经步骤。`type: 'none'` 是合法且受支持的一等公民
- **`layout` 默认 `auto`** —— 由能力推导，用户不写路径
- 用户**可以**显式指定 `layout: 'system'` 或 `'user'` 来覆盖推导，此时预检会验证该布局所需能力是否具备，不具备就报错而不是默默降级

`become` 已有的 `none | sudo | su | doas | custom`（见 `config.md`）保持不变 —— 提权机制本身是对的，错的是提权之后**假设了系统级路径可用**。

---

## 5. 对其他文档的影响

| 文档 | 修改 |
|---|---|
| `failures.md` §7 | rescue 位置随布局走；纯用户模式下带外救援是**用户级**的，只能切 symlink，不能 mask 系统服务 |
| `security.md` §6.1 | 状态目录路径随布局；`<root>/.dp/trace/` 改为 XDG 路径；校验条件改为"owner = 布局所有者" |
| `preflight.md` §2.3 | 目录链校验的"root 拥有"改为"布局所有者拥有" |
| `decisions.md` §16 | 同上 |
| `config.md` | `hosts.*` 增加 `layout` 字段 |

---

## 6. 一句话

**把「路径」从输入变成输出。** 配置里只写"我是谁、我能提权到哪"，剩下的路径由实测能力推导出来 —— 这样同一份配置在 root 机器和普通机器上都能用，区别只是推导出的布局不同。
