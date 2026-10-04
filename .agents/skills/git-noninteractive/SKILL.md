---
name: git-noninteractive
description: 让所有 git 远程操作绝不弹窗、绝不挂起 —— 禁用 GUI 凭据助手、显式带 token、输出脱敏、代理配置。自动化环境里推拉代码、或遇到凭据弹窗/长时间挂起时使用。
---

# git 免交互操作

**铁律：自动化环境里任何 git 操作都不许弹窗。** 弹一次 GUI 凭据窗口就会挂几分钟，
而且在无人值守场景下永远不会有人去点。

## 1. 三层防护，缺一不可

```bash
export GIT_TERMINAL_PROMPT=0                                    # ① 压终端提示
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper \
       GIT_CONFIG_VALUE_0=                                      # ② 压 GUI 凭据助手
git push "https://<用户名>:${TOK}@<host>/<org>/<repo>.git" <分支> # ③ 显式带凭据
```

**① 只能压终端提示，压不住 GUI 凭据助手。** 实测：只设了 `GIT_TERMINAL_PROMPT=0`，
推送仍然弹了 Git Credential Manager 的窗口、挂了 3 分 4 秒才继续。
**② 才是根治** —— 把 `credential.helper` 置空，git 就不会去找 GCM。

禁用凭据助手后实测从 3 分钟降到 5 秒内、无弹窗。

## 2. 凭据怎么带

- 用**环境变量**接 token，不要写进命令历史之外的配置文件
- URL 里显式带：`https://<任意用户名>:${TOK}@<host>/...`
- **输出必须脱敏**：管道里 `sed -E "s/${TOK}/***/g"` 再打印，否则 token 会进日志
- 推完把 remote 改回**不含 token** 的形式（remote URL 是会被提交和展示的）

## 3. 反面教材（实测踩过）

先带 token 推一次 → 把 remote 改成无 token → 再用 remote 名推第二次 → **弹窗**。
因为第二次没有凭据可用，git 转而去问凭据助手。

**要么每次都显式带完整 URL，要么就别改 remote。**

## 4. 走代理

```bash
export https_proxy=<代理> http_proxy=<代理>
```

需要注意的坑（实测）：
- git 走 HTTP 代理可能要显式指定 HTTP/1.1，否则报
  `fatal: expected flush after ref listing` —— 看着像仓库损坏，实为协议协商问题
- 代理支持 CONNECT 时可承载 SSH 隧道（`git@host:` 形式）

## 5. 所有远程操作都要加

不止 push：`fetch` / `ls-remote` / `clone` / `pull` 都会触发凭据流程。
把 ①② 两个 export 做成每次会话的固定前置，别只在一处加。

排查顺序：报「仓库损坏 / 协议错误」时，先确认是不是代理或协议版本问题，
再怀疑仓库本身 —— 实测「expected flush after ref listing」就是代理侧协议问题。

## 6. 相关

- 历史重写后的强推：`repo-sanitize-history`
