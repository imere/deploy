---
name: host-gotchas
description: Windows 宿主 + 沙箱会让「看起来像代码坏了」的环境坑 —— 删除被垫片托管、node 派生子进程间歇性 EBUSY、测试并发起不来、git 弹凭据窗。当命令莫名超时、EBUSY、SIGTERM、一批不相关用例同时失败时使用。
metadata:
  pattern: tool-wrapper
  domain: windows-host
---

# 宿主环境坑

这些坑的共同点：**报错看起来像代码或依赖坏了，实际是环境**。完整清单与实测细节见 `references/gotchas.md`。

## 排查顺序（不要先改代码）

1. 报错里有没有环境关键字：`safe-delete` / `bulk guard` / `genie-trash` / `EBUSY` / worker 超时 / 锁超时
2. 单跑那一个用例或那一个包，是不是就通过了
3. 把它从调用链里摘出来单独跑一次（单独跑得通、链里跑不通 = 那一层的问题）
4. 关掉沙箱复跑
5. 以上都无效，才怀疑代码

**为环境现象改代码会引入真 bug，而且掩盖真实原因。**

## 三条最容易误判的

- **EBUSY 是间歇性的，不是永久的。** 一度归因成「git 专属」「任何子进程都派生不了」，据此改过架构——那层复杂度是被假结论逼出来的。机器空闲时五种 stdio 配置全部正常，高负载时全变 EBUSY。遇到先降负载再重试：查残留的 node / 子代理进程并清掉
- **多个不相干的用例一起慢 = 机器层面，单个用例慢 = 用例层面。** 实测过并行子代理吃掉 1.6GB，导致用例耗时涨到 800s
- **`finally` 里的清理不许抛错。** 清理抛错会替换掉用例真正的失败原因，看到的是误导性的错误信息（实测「子进程超时」被 `rmdir EBUSY` 吃掉）

## git 远程操作：绝不弹窗

三层防护缺一不可——`GIT_TERMINAL_PROMPT=0` 只压终端提示，压不住 GUI 凭据助手那个独立进程：

```bash
GIT_TERMINAL_PROMPT=0 \
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0= \
git push origin main
```

- 凭据用环境变量接，URL 里显式带：`https://<用户名>:${TOK}@<host>/...`
- **推完把 remote 改回不含 token 的形式**（remote URL 会被提交和展示）
- 输出必须脱敏再打印，否则 token 进日志
- 走代理时可能要显式指定 HTTP/1.1，否则报协议协商错误

## 删除

`rm` 与 node 的 `fs.rmSync` 都走垫片，不是原生的。垫片状态会卡死，卡死后 bash 的 `rm` 也一样被拦。有正规总开关 `CODEBUDDY_SAFE_DELETE_ENABLED=0`，只在本次命令环境里开、作用域限于项目自己的 `.tmp/`——**不要为它改脚本**。
