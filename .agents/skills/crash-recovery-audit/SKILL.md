---
name: crash-recovery-audit
description: >-
  崩溃 / 硬重启 / 断电之后，审计工作区有什么被写坏了，并按「先救数据、再救构建、最后重做」
  的顺序恢复。适用于：git 报 branch broken、源文件变成二进制、构建突然报找不到模块、
  测试出现无法解释的失败。
---

# 崩溃后审计与恢复

## 1. 顺序不能反

**先救 git（数据安全）→ 再救构建（可重建）→ 最后重做（未入库的活）。**

反过来做，最容易犯的错是「先重跑一遍构建看看」—— 在 HEAD 引用已损坏的状态下跑构建，
可能把损坏的中间产物写进产物目录，把一次可恢复的事故变成真丢失。

## 2. 症状一：git 说 branch broken

```
fatal: your current branch appears to be broken
```
且 `git status` 把**所有**文件显示成 `A`（新增）—— 这不是仓库坏了，
是 `.git/refs/heads/<branch>` 那个 41 字节文件被写成了全 NUL。

**恢复**（对象库通常完好，别慌）：

```bash
tail -5 .git/logs/HEAD          # reflog 最后一条的第二个 sha 就是真 HEAD
printf '<sha>\n' > .git/refs/heads/main
git log --oneline -3            # 验证
```

验证对象库：`git cat-file -t <sha>` 返回 `commit`、`git rev-list --count HEAD` 有数。

## 3. 症状二：文件被「清零」

中断的写入不会留下半截文本，而是留下**整文件 NUL**。表现为 `git diff --stat` 里
该文件显示成 `Bin`（git 判定为二进制）。

**判据用「去掉 NUL 后还剩多少字节」**：

```bash
raw=$(wc -c < f); nonul=$(tr -d '\000' < f | wc -c)
```
`nonul == 0` → 整文件被清零。

### 两个必须知道的陷阱

- **`grep -rlP '\x00'` 扫不出来。** 实测在本仓返回空，而文件确实全是 NUL。
  不要因为 grep 说没事就收工 —— 用第二种方法交叉验证。
- **逐文件派生子进程的扫描会被沙箱截断**（`dofork: CreateProcessW failed`），
  半途而废比不扫更危险：它让你以为「只坏了这几个」。
  **写成单个进程一次遍历**（一个 node 脚本读完所有文件），不要 `while read; do wc; done`。

### 别把正常的当损坏

压缩文件（zip）、git bundle、UTF-16 编码的日志，本来就含 NUL。
判据是「**整文件**是否全是 NUL」，不是「是否含 NUL」。

## 4. 恢复：能救的和救不了的

- 受版本控制的文件 → `git checkout -- <file>`，直接回到 HEAD。
  它们的工作区内容已经全是 NUL，没有任何值得保留的东西，**这个操作没有损失**。
- **未入库的文件（新建的脚本、未提交的产出）→ 救不回来，只能重做。**
  这是「频繁提交」最实在的理由：崩溃时未提交的工作等于没有。

恢复完**再扫一遍确认**，别只信命令的返回码。

## 5. 重建产物：删了 build 必须 `--force`

```
rm -rf packages/*/build && npx tsc -b        # ❌ 会失败
```

`.tsbuildinfo` 还在（或者构建系统认为「已是最新」）→ 直接跳过 →
产物目录是空的 → 满屏 `Cannot find module '@dp/xxx'`。

```
rm -rf packages/*/build && npx tsc -b --force  # ✅
```

## 6. 清干净构建才会暴露的隐藏缺陷

平时增量构建从不触发、但 CI 的 clean build 一定会撞上的问题，会在这一刻集中出现：

- **references 顺序不是拓扑序**：A 的 tsconfig 没引用它依赖的 B，
  `tsc -b` 就按声明顺序构建 A → 报「找不到 B」。增量构建因为 B 早已建好而从不报错。
- **子代理留下的类型错误**：它们通常被禁止跑构建，改完测试文件就走，
  `Cannot find module` / `possibly undefined` 这类错误会留到我这里才炸。

**所以 clean build 之后要再跑一次普通 `tsc -b`** —— 第一次的错误可能是构建顺序造成的
中间态假象，第二次仍报的才是真错误。

## 7. 预防

- **派完子代理立刻提交**。崩溃时未提交的工作 = 白做（本轮实测：两个包整包注释因文件
  被清零而全丢，而先提交过的那批完好无损）。
- 长时间跑的批量任务，让它**小步写文件**而不是一次性写一个大文件 ——
  被清零的概率一样，但损失面小。
- 恢复后**跑一次全量测试**再继续派活。别在损坏状态上继续施工。
