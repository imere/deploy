---
name: repo-sanitize-history
description: 清理仓库里的私有环境信息，含**重写全部历史** —— 盘点、备份、filter-repo 配方、复扫、强推。仓库要公开前、或发现本机路径/端口/凭据被提交时使用。
---

# 私有信息清理与历史重写

**当前是私有仓库不代表可以留。** 一旦公开，历史里所有提交都能被翻出来。

## 1. 先盘点：什么算「公开处」

- **已被 git 跟踪的文件**（含历史里的每一个提交）
- 被忽略的本地目录（工作记忆、临时产物）不算 —— 但要确认它真的被忽略了：
  `git ls-files | grep '^<目录>/'` 有输出就是**已经被提交进去了**

要找的东西（逐条 grep）：

| 类别 | 例子 |
|---|---|
| 绝对路径 | 仓库路径、用户主目录、全局 bin 目录 |
| 网络环境 | 代理地址与端口、`127.0.0.1:<端口>` |
| 凭据 | `ghp_` / `github_pat_` / 各种 token / 密码 |
| 机器标识 | 主机名、用户名 |
| 处境描述 | 工作记忆里「项目当前处境」这类不适合公开的内容 |

**注意区分合成数据**：脱敏测试里的假 token（比如假 Slack token 里的数字）是测试数据，
不是泄露，别误删导致测试语义变化。

## 2. 让本地目录退出版本控制（文件本人保留）

写进 `.gitignore` 后，`git rm -r --cached <目录>` 取消跟踪。
**只取消跟踪，不删文件** —— 那是你本人要用的工作记忆。

## 3. 重写历史前：先备份

```bash
git bundle create .tmp/history-backup-<日期>.bundle --all
```

不可逆操作前必须有回滚点。确认 bundle 文件真的生成了再看下一步。

## 4. filter-repo 配方

`git filter-repo` 通常不在 git 自带工具里，用 Python 装（配好代理）：

```bash
<python> -m venv <venv 路径>
<venv>/Scripts/pip install git-filter-repo --proxy <代理>
```

执行（两条可以合成一条命令，也可以分两轮）：

```bash
<venv>/Scripts/git-filter-repo.exe \
  --invert-paths --path "<要整个删掉的目录>/" \
  --replace-text <替换表文件> \
  --force
```

替换表每行 `原文==>替换文`，替换文用**占位符**而不是删空
（例：`127.0.0.1:<某端口>==>127.0.0.1:<代理端口>`）：
删空会让句子读不通，读者反而猜得到。

### ⚠️ 替换表要按「实际出现的字符串」写

同一个值在文档里有**多种形态**，只写一种必漏。实测漏了旧提交里把端口单独写成 `` `7890` ``
（反引号包裹）的形态，跑了第二轮才干净。至少要覆盖：裸写、反引号包裹、带引号。

做法：先 `git grep -e '<值>' $(git rev-list --all)` 把所有形态捞出来，再逐形态写规则。

## 5. 复扫（重写后必做）

```bash
for p in '<模式1>' '<模式2>'; do
  printf '== %s : ' "$p"
  git grep -l -I -e "$p" $(git rev-list --all) 2>/dev/null | sed 's/^[0-9a-f]*://' | sort -u
done
```

**扫全部提交**，不是只扫当前树。当前树改了不代表旧提交改了。

## 6. 恢复 remote 并强推

filter-repo 会**删掉 remote**（它假设你要重造仓库）。推送前重新加：

```bash
git remote add origin <远端地址>
git push --force <带凭据的 URL> <分支>
```

推完把 remote 改回**不含 token** 的形式。

## 7. 顺手做的事

- 文档与 skill 里也别写死盘符/端口：改成「用 `npm prefix -g` 查」这类可复现的说法
- 把这条约定写进仓库纪律文件，避免下次再犯
- 提交信息里同样不能有

## 8. 相关

- 推送不弹窗：`git-noninteractive`
- 文档里的本机指代：`doc-truthfulness`
