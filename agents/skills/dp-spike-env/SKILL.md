---
name: dp-spike-env
description: 用 podman 起一次性 SSH 靶机（跳板机 + 内网靶机），用于验证多跳、提权、rsync 隧道等需要真 SSH 服务的场景。当需要真实 SSH 目标做验证时使用。
---

# dp-spike-env

起两台 alpine 容器：跳板机（端口映射到宿主机）+ 靶机（只在内网可达，模拟真实多跳）。

## 前置坑

- **podman 虚拟机里配了死代理**（`host.containers.internal:<代理端口>`）→ 拉镜像和 `apk` 都会失败。
  解法：给容器传空代理 `-e http_proxy= -e https_proxy= -e HTTP_PROXY= -e HTTPS_PROXY=`，容器内可直连外网。
- 本机（Windows）**没有 rsync、没有 sshpass**，本机 OpenSSH 10.3。
- 不要为了测试去改 WSL 发行版（会引入不必要的安全面）。用容器。

## 起环境

```bash
podman network create dpnet
podman run -d --name dp-jump   --network dpnet -p 2222:22 \
  -e http_proxy= -e https_proxy= -e HTTP_PROXY= -e HTTPS_PROXY= alpine:latest sleep infinity
podman run -d --name dp-target --network dpnet \
  -e http_proxy= -e https_proxy= -e HTTP_PROXY= -e HTTPS_PROXY= alpine:latest sleep infinity
# 用 .tmp/spikes/target-setup-alpine.sh 初始化（sshd + rsync + sudo + 测试账号）
podman exec -e http_proxy= -e https_proxy= -i dp-jump   sh < .tmp/spikes/target-setup-alpine.sh
podman exec -e http_proxy= -e https_proxy= -i dp-target sh < .tmp/spikes/target-setup-alpine.sh
```

账号 `dpuser/dppass123`、`root/rootpass123`。容器内 OpenSSH 10.2p1、rsync 3.5.0。

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
ssh -i .tmp/spikes/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o ProxyCommand="ssh -i .tmp/spikes/id_ed25519 -o StrictHostKeyChecking=no \
     -o UserKnownHostsFile=/dev/null -p 2222 dpuser@127.0.0.1 nc %h %p" dpuser@dp-target 'id'

# 免 sshpass 的密码登录
SSH_ASKPASS=<helper> DISPLAY=:0 SSH_ASKPASS_REQUIRE=force ssh -p 2222 dpuser@127.0.0.1 'id' < /dev/null

# 在跳板机内跑 rsync over ssh2 隧道
podman exec -e NODE_PATH=/root/spikes/node_modules dp-jump sh -c \
  'rsync -e "node /root/spikes/dp-rsh.mjs" -av /tmp/src/ dpuser@dp-target:/tmp/deployed/'
```

## 清理

```bash
podman rm -f dp-jump dp-target && podman network rm -f dpnet
```
