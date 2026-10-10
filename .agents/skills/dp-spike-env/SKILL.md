---
name: dp-spike-env
description: 用容器运行时起一次性 SSH 靶机（跳板机 + 内网靶机），验证多跳、提权、rsync 隧道，并跑 @dp/ssh 的真机 e2e。需要真实 SSH 目标做验证时使用。
metadata:
  pattern: tool-wrapper
  domain: ssh-spike
---

# SSH 靶机

起两台 alpine 容器：跳板机（端口映射到宿主机）+ 靶机（只在内网可达，模拟真实多跳）。
完整命令、实测事实表、常用片段见 `references/ssh-spike.md`，初始化脚本在本目录 `target-setup-alpine.sh`（**不要引用 `.tmp/` 下的副本**，那目录会被清掉）。

## 前置坑

- **容器虚拟层里配了容器网络内不可达的代理** → 拉镜像和 `apk` 都会失败。给容器传空代理：`-e http_proxy= -e https_proxy= -e HTTP_PROXY= -e HTTPS_PROXY=`
- Windows 通常**没有 rsync、没有 sshpass**；OpenSSH 版本视机器而定
- 不要为测试改 WSL 发行版（引入不必要的攻击面）。用容器
- **永不交互**：ssh 一律 `BatchMode=yes`（密钥）或 `SSH_ASKPASS`+`force`（密码）+ `< /dev/null`，所有命令带 `timeout`。Windows 上 ssh 缺口令会弹 GUI，绝不依赖

## 起环境

下面用 `<rt>` 代表容器运行时命令——`network create` / `run -d` / `exec -i` / `rm -f` 这组子命令在常见运行时里是同构的，按当前环境选一个代入。

```bash
<rt> network create dpnet
<rt> run -d --name dp-jump   --network dpnet -p 2222:22 \
  -e http_proxy= -e https_proxy= alpine:latest sleep infinity
<rt> run -d --name dp-target --network dpnet \
  -e http_proxy= -e https_proxy= alpine:latest sleep infinity

SETUP=.agents/skills/dp-spike-env/target-setup-alpine.sh   # sshd + rsync + sudo + 测试账号
<rt> exec -e http_proxy= -e https_proxy= -i dp-jump   sh < "$SETUP"
<rt> exec -e http_proxy= -e https_proxy= -i dp-target sh < "$SETUP"
```

账号 `dpuser/dppass123`、`root/rootpass123`。

## 跑真机 e2e

e2e 默认 skip，用环境变量打开并指向跳板机：

```bash
DP_SSH_E2E=1 DP_SSH_HOST=127.0.0.1 DP_SSH_PORT=2222 DP_SSH_USER=dpuser \
DP_SSH_PASSWORD=dppass123 node --test packages/ssh/build/e2e.test.js
```

不给 `DP_SSH_PASSWORD` 就走 agent/key 认证。

**两种驱动能力不对称，选哪个要先想清楚**：`native-ssh`（默认）走 `-o ProxyJump=`，逐跳只能 key/agent；`ssh2` 逐跳 direct-tcpip 串成链、逐跳认证独立可密码，但**靶机 `AllowTcpForwarding` 默认 no** → `direct-tcpip` 必失败，要么改靶机配置要么开 `allowNcHopFallback` 走跳板上的 nc。

## 清理

```bash
<rt> rm -f dp-jump dp-target && <rt> network rm -f dpnet
```
