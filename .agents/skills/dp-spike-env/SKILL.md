---
name: dp-spike-env
description: 用 podman 起一次性 SSH 靶机（跳板机 + 内网靶机），用于验证多跳、提权、rsync 隧道，以及跑 @dp/ssh 的真机 e2e。当需要真实 SSH 目标做验证时使用。
---

# dp-spike-env

起两台 alpine 容器：跳板机（端口映射到宿主机）+ 靶机（只在内网可达，模拟真实多跳）。
初始化脚本**在本 skill 目录里**（`target-setup-alpine.sh`），不要引用 `.tmp/` 下的副本 —— 那个目录会被清掉。

## 前置坑

- **podman 虚拟机里配了一个容器网络内不可达的代理** → 拉镜像和 `apk` 都会失败。
  解法：给容器传空代理 `-e http_proxy= -e https_proxy= -e HTTP_PROXY= -e HTTPS_PROXY=`，容器内可直连外网。
- Windows 环境通常**没有 rsync、没有 sshpass**；OpenSSH 版本视机器而定（spike 用的是 10.3）。
- 不要为了测试去改 WSL 发行版（会引入不必要的安全面）。用容器。
- **永不交互**：ssh 一律 `BatchMode=yes`（密钥）或 `SSH_ASKPASS`+`force`（密码）+ `< /dev/null`；所有命令带 `timeout`。
  Windows 上 ssh 缺口令会弹 `ssh-askpass` GUI，git 缺凭据会弹 Credential Manager GUI——两者都绝不依赖。

## 起环境

```bash
podman network create dpnet
podman run -d --name dp-jump   --network dpnet -p 2222:22 \
  -e http_proxy= -e https_proxy= -e HTTP_PROXY= -e HTTPS_PROXY= alpine:latest sleep infinity
podman run -d --name dp-target --network dpnet \
  -e http_proxy= -e https_proxy= -e HTTP_PROXY= -e HTTPS_PROXY= alpine:latest sleep infinity

SETUP=.agents/skills/dp-spike-env/target-setup-alpine.sh   # sshd + rsync + sudo + 测试账号
podman exec -e http_proxy= -e https_proxy= -i dp-jump   sh < "$SETUP"
podman exec -e http_proxy= -e https_proxy= -i dp-target sh < "$SETUP"
```

账号 `dpuser/dppass123`、`root/rootpass123`。容器内 OpenSSH 10.2p1、rsync 3.5.0。

## 跑 `@dp/ssh` 的真机 e2e

e2e 默认 skip，用环境变量打开并指向跳板机：

```bash
DP_SSH_E2E=1 DP_SSH_HOST=127.0.0.1 DP_SSH_PORT=2222 DP_SSH_USER=dpuser \
DP_SSH_PASSWORD=dppass123 \
  node --test packages/ssh/build/e2e.test.js
```

不给 `DP_SSH_PASSWORD` 就走 agent/key 认证。

多跳已落地，但**两种驱动能力不对称**，选哪个要先想清楚：
- `native-ssh`（默认）：`hops` → `-o ProxyJump=`。**逐跳只能 key/agent**
  （`-J` 由系统 ssh 发起跳板连接，我们没有它的凭据通道），所以多跳 e2e 用密钥认证
- `ssh2`：逐跳 direct-tcpip 串成链，逐跳认证独立（可密码），
  但**本机靶机的 `AllowTcpForwarding` 默认是 no**（见下表）→ `direct-tcpip` 必失败，
  要么改靶机配置，要么开 `allowNcHopFallback` 走跳板上的 nc

## 已知实测事实（别再试一遍）

| 项 | 结论 |
|---|---|
| 跳板机 `AllowTcpForwarding` | **默认 no** → `ssh -W` / `direct-tcpip` 失败；用 `ProxyCommand ssh jump nc %h %p` |
| 从宿主机连靶机 | 只能经跳板机；`dp-target` 在容器网络内解析 |
| `sudo -S -p '' id` | ✅ 有/无 pty 均可提权 |
| `su -c` | ❌ busybox su 缺 suid 位 |
| sftp 子系统 | ✅ `/usr/lib/ssh/sftp-server` |
| `scp` | ✅ 支持 `-O`（传统协议） |

## 常用片段

```bash
# 宿主机 → 靶机（经 nc 代理）
ssh -i .tmp/spikes/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=.tmp/known_hosts \
  -o ProxyCommand="ssh -i .tmp/spikes/id_ed25519 -o StrictHostKeyChecking=no \
     -o UserKnownHostsFile=.tmp/known_hosts -p 2222 dpuser@127.0.0.1 nc %h %p" dpuser@dp-target 'id'

# 免 sshpass 的密码登录
SSH_ASKPASS=<helper> DISPLAY=:0 SSH_ASKPASS_REQUIRE=force ssh -p 2222 dpuser@127.0.0.1 'id' < /dev/null

# 在跳板机内跑 rsync over ssh2 隧道
podman exec -e NODE_PATH=/root/spikes/node_modules dp-jump sh -c \
  'rsync -e "node /root/spikes/dp-rsh.mjs" -av /tmp/src/ dpuser@dp-target:/tmp/deployed/'
```

> Windows/Git Bash 下 `-o UserKnownHostsFile=/dev/null` 会在 cwd 落一个名为 `NUL` 的文件，
> 用 `.tmp/known_hosts` 代替（排障文档里「known_hosts」那节有展开）。

## 清理

```bash
podman rm -f dp-jump dp-target && podman network rm -f dpnet
```
