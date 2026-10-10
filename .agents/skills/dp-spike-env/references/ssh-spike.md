# SSH 靶机 · 已知实测事实

别再试一遍的：

| 项 | 结论 |
|---|---|
| 跳板机 `AllowTcpForwarding` | **默认 no** → `ssh -W` / `direct-tcpip` 失败；用 `ProxyCommand ssh jump nc %h %p` |
| 从宿主机连靶机 | 只能经跳板机；`dp-target` 在容器网络内解析 |
| `sudo -S -p '' id` | ✅ 有/无 pty 均可提权 |
| `su -c` | ❌ busybox su 缺 suid 位 |
| sftp 子系统 | ✅ `/usr/lib/ssh/sftp-server` |
| `scp` | ✅ 支持 `-O`（传统协议） |
| 容器内版本 | OpenSSH 10.2p1、rsync 3.5.0（宿主机侧 spike 用 10.3，视机器而定） |

# 常用片段

宿主机 → 靶机（经 nc 代理）：

```bash
ssh -i .tmp/spikes/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=.tmp/known_hosts \
  -o ProxyCommand="ssh -i .tmp/spikes/id_ed25519 -o StrictHostKeyChecking=no \
     -o UserKnownHostsFile=.tmp/known_hosts -p 2222 dpuser@127.0.0.1 nc %h %p" dpuser@dp-target 'id'
```

免 sshpass 的密码登录：

```bash
SSH_ASKPASS=<helper> DISPLAY=:0 SSH_ASKPASS_REQUIRE=force ssh -p 2222 dpuser@127.0.0.1 'id' < /dev/null
```

在跳板机内跑 rsync over ssh2 隧道：

```bash
<rt> exec -e NODE_PATH=/root/spikes/node_modules dp-jump sh -c \
  'rsync -e "node /root/spikes/dp-rsh.mjs" -av /tmp/src/ dpuser@dp-target:/tmp/deployed/'
```

# 坑

Windows/Git Bash 下 `-o UserKnownHostsFile=/dev/null` 会在 cwd 落一个名为 `NUL` 的文件，用 `.tmp/known_hosts` 代替。
