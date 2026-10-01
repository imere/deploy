# Spike 实测结论

> 「先测」的产物。所有结论都来自真机实测，不是读文档推断。
> 复现脚本在 `.tmp/spikes/`，靶机用 podman 容器（见 `agents/skills/dp-spike-env/SKILL.md`）。

## 环境

| 项 | 值 |
|---|---|
| 本机 SSH | OpenSSH 10.3p1 / OpenSSL 3.5.7 |
| 本机 rsync | **无** |
| 本机 sshpass | **无** |
| Node | 22.22.2（已备 24.21.0） |
| ssh2 | 1.17.0 |
| 靶机容器 | OpenSSH 10.2p1 + rsync 3.5.0（alpine） |

---

## S1 · ssh2 **不支持**抗量子 KEX（推翻原假设）

```
SUPPORTED_KEX = curve25519-sha256@libssh.org, curve25519-sha256,
                ecdh-sha2-nistp256/384/521,
                diffie-hellman-group-exchange-sha256/sha1,
                diffie-hellman-group14/15/16/17/18-sha512,
                diffie-hellman-group14-sha1, group1-sha1
```

- 传入 `mlkem768x25519-sha256` → 直接抛 `Unsupported algorithm`
- 无 `sntrup761x25519-sha512@openssh.com`
- 默认协商结果：`curve25519-sha256@libssh.org` + `aes128-gcm@openssh.com` + `ssh-ed25519`

**结论：抗量子这条路 ssh2 走不通，只能靠本机 ssh。** 这是整个安全设计里最硬的一个约束。

## S2 · 本机 ssh 默认就是抗量子的

```
$ ssh -p 2222 dpuser@127.0.0.1 id
debug1: kex: algorithm: mlkem768x25519-sha256     ← 默认就协商出来了
debug1: kex: host key algorithm: ssh-ed25519
debug1: kex: client->server cipher: chacha20-poly1305@openssh.com
```
强制 `mlkem768x25519-sha256` 与 `sntrup761x25519-sha512@openssh.com` 均成功。

## S3 · 免 sshpass 的密码登录：SSH_ASKPASS 可行

```
SSH_ASKPASS=<helper> DISPLAY=:0 SSH_ASKPASS_REQUIRE=force ssh ... < /dev/null
→ ASKPASS_OK / uid=1000(dpuser)
```
Windows 上用 `.cmd` 助手实测通过。**"本机没有 sshpass" 不再是个约束**——它只是把我们从"只能走 ssh2"里解放出来。

## S4 · 多跳：跳板机常常禁 TCP 转发

alpine 默认 `AllowTcpForwarding no`（加固跳板机普遍如此）：

| 方式 | 结果 |
|---|---|
| `ssh -W %h:%p` / ssh2 `direct-tcpip` | ❌ `channel 0: open failed: administratively prohibited` |
| `ProxyCommand ssh jump nc %h %p` | ✅ 成功（只需 exec 权限） |
| 跳板机 exec `ssh target cmd` | ⚠️ 需跳板机有 ssh 客户端 **且**有目标凭据 |

**→ 多跳必须做成偏好链，不能只实现一种。**

## S5 · rsync `--rsh` 契约（实测 rsync 3.5.0）

```
< -e 的 argv（按空白拆分）... >  [ -l <user> ] <host> rsync --server [--sender] <flags> <src> <dst>
```

实测样本：
```
ARGC=8  [-l][dpuser][dp-target][rsync][--server][-vlogDtpre.iLsfxCIvu][.][/tmp/dst1/]
拉取方向多一个 [--sender]
```

四条关键事实：
1. **`%h` 不替换** —— 实测传入的是字面 `%h`。host 总是作为独立 argv 追加。别依赖 `%h`。
2. **不经过 shell** —— `-e "/x a;touch /tmp/pwned"` 得到两个独立 argv，`/tmp/pwned` 未创建。**rsync 侧没有命令注入面**，这是好消息。
3. 无 user 前缀时省略 `-l <user>`（用本地用户名）。
4. `RSYNC_RSH` 环境变量等价生效。

## S6 · rsync over 自建 ssh2 隧道：完全可用 ✅

`rsync -e "node dp-rsh.mjs" -av /tmp/src/ dpuser@dp-target:/tmp/deployed/`

```
首次:  Number of regular files transferred: 2   (16 bytes)
二次:  Number of regular files transferred: 0   ← 增量生效
改1个: Number of regular files transferred: 1   (17 bytes) ← 真正的 delta
```
远端落盘内容正确。**"本机没 rsync / 没 sshpass / 不依赖系统 ssh" 的核心方案成立。**

## S7 · 提权：能用的和不能用的必须实测

| 命令 | 结果 |
|---|---|
| `sudo -S -p '' id`（无 pty） | ✅ `uid=0(root)` |
| `sudo -S -p '' id`（带 pty） | ✅ `uid=0(root)` |
| `su -c 'id' root` | ❌ `su: must be suid to work properly`（busybox su 缺 suid 位） |
| `sudo -n id` | exit 1 `a password is required` ← **可用作 NOPASSWD 探测** |

**→ 提权方式不能靠 uid/发行版推断，必须逐个实证探测**（sudo / su / doas / pkexec）。

## S8 · scp / sftp 可用性

- `sftp-server` 存在，`ssh -s sftp` 子系统正常
- `scp` 存在且带 `-O`（传统 SCP 协议）与 `-D <sftp_path>`
- 注意 OpenSSH 9+ 的 `scp` 默认走 SFTP 协议；要兼容老目标需 `scp -O`

---

## 对设计的冲击（三条，都是架构级）

1. **SSH 客户端必须有两条实现，走偏好链**
   - `native-ssh`：抗量子 ✅、ssh_config ✅、ProxyJump ✅、密码靠 SSH_ASKPASS
   - `ssh2`：零外部依赖、密码走 keyboard-interactive、rsync 隧道 ✅、抗量子 ❌
   - 当 `cryptoPolicy` 要求 `pq-required` 而链里只剩 ssh2 → 报结构化错误并说明原因

2. **多跳也要偏好链**：`direct-tcpip` → `nc` 代理 → `ssh` 中继

3. **预检必须实证、不能推断**：`su` 在这台机上是坏的，但 `command -v su` 是有的。
   凡是"看起来能用"的，都要真的跑一次。

## 已排除的假设

| 原假设 | 实测 |
|---|---|
| ssh2 在 Node ≥24 下支持 ML-KEM | ❌ 与 Node 版本无关，ssh2 根本没实现 |
| 没 sshpass 就只能用 ssh2 | ❌ SSH_ASKPASS 让本机 ssh 也能无交互密码登录 |
| ProxyJump 通用可用 | ❌ 加固跳板机普遍禁 TCP 转发 |
| `%h` 会被 rsync 替换 | ❌ 不会 |
