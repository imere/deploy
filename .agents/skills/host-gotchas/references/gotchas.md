# 宿主环境坑 · 完整清单

## 删除被垫片托管，且会坏

`rm` 与 node 的 `fs.rmSync` 都走 safe-delete 垫片，垫片自己维护一份状态（报错里出现
`[safe-delete][SAFE_DELETE_BULK_GUARD_ERROR]` 与 `state.json`）。**这份状态会卡死**，之后：

- node 侧 `fs.rmSync` 一律抛错，连删一个两层小目录都失败
- bash 的 `rm` 也一样被拦（垫片抛 EPERM rename state.json）
- 依赖删除的脚本整体不可用，常常表现为命令直接 SIGTERM

曾经以为「bash rm 能用、只有 node 不行」，据此建议「构建前用 bash rm 清 build」——**这条已过时**，
垫片管的是删除这件事本身，不是某个运行时。

- 正规总开关：`CODEBUDDY_SAFE_DELETE_ENABLED=0`（只在本次命令的环境里关，作用域限项目自己的 `.tmp/`）
- **不要为它改脚本**，脚本在干净环境是对的
- 批量删除会撞单轮上限（如 50 个）→ 分批，每批 40 个左右，每批后核对剩余数量

## node 派生子进程间歇性 EBUSY

现象：`execFileSync` / `spawnSync` 报 `EBUSY`（errno -4082），`r.status` 为 `null`、错误挂在 `r.error` 上。

**这条结论被推翻过两次，别往任何一个方向写死：**

- 一度归因成「git 专属」→ 实测 `spawnSync(process.execPath, ...)` 一样失败
- 又一度归因成「任何子进程都派生不了 / 默认要建 stdin 管道」→ 据此把脚本改成「shell 调、node 读 stdin」，那层复杂度是被假结论逼出来的

实情：机器空闲时五种 stdio 配置（default / `['ignore','pipe','pipe']` / `['pipe','pipe','pipe']` / `'inherit'` / `'ignore'`）
全部正常返回 status=7；高负载时（并行子代理、残留 node 进程多）同样的调用全变 EBUSY。

**遇到先降负载再重试。** 排查时别误判成 PATH 问题——换绝对路径一样失败。

测试里仍要留退路：依赖子进程的用例在该环境可能红，且 `r.status` 为 `null` 会把断言报错误导成脚本缺陷。
正确做法是检测 `r.error` 后 `t.skip()` 并写明原因——既不假红也不假绿，CI（Linux）上仍会真跑。

## 经 pnpm 链条派子进程恒 EBUSY

同一个脚本直接 `node scripts/accept-gates.mjs` 跑 9/9 全过；放进 `pnpm verify` 链条
（pnpm → sh → node）后它 `spawnSync` 出来的每一次都是 EBUSY。

判别：**把它从链里摘出来单独跑一次**。

处置不要选「留在链里、红了靠人判断是不是环境」——一个需要人判断「这次红是不是环境」的门禁就已经不是门禁了。
实际做法：从 `verify:gates` 移出，单开一个 `verify:selfcheck`，由 CI（Linux runner 没有这个限制）单独一步跑。

## 测试并发起不来

报「worker 启动失败 / 等待 worker 响应超时」，多个文件全失败且显示「没有用例」——这不是用例坏了。

- 加单线程参数（如 `--no-file-parallelism`）实测全绿
- 某些 pool 模式在该环境完全不可用，默认（forks）才行

## 构建卡在清空产物目录

构建工具在 `prepareOutDir → emptyDir` 挂住，报删除垫片超时——因为走了上面那条被护栏劫持的删除路径。
构建前先清产物目录（bash 的 rm，别用 node）。

## 沙箱造成的假失败

跨包测试、真起子进程的用例在沙箱下会拦临时目录写入与产物读取，让单个用例跑 80~130 秒导致整体超时。
**全量测试要关沙箱跑。** 一批失败同时出现且都涉及 IO/子进程时，先关沙箱复跑再判断。

实测过 21 个「失败」全是环境造成，关沙箱即 0 fail。

## 并行子代理拖垮机器且不会自动回收

多个子代理会话并行时内存占用能到 GB 级，node 启动从 3.5s 涨到几十秒，
于是所有「真起子进程」的用例一起超时。收工后必须自己查一遍残留进程。

配套现象：**宿主 shell 命令会莫名 SIGTERM**（时快时慢）。看到 SIGTERM 先降负载、把长命令拆成几条短的。

## git 免交互完整做法

```bash
export GIT_TERMINAL_PROMPT=0                      # 压终端提示
export GIT_CONFIG_COUNT=1                          # 压 GUI 凭据助手（独立进程，上面那条压不住）
export GIT_CONFIG_KEY_0=credential.helper
export GIT_CONFIG_VALUE_0=
export GIT_HTTP_LOW_SPEED_LIMIT=1000               # 防慢连挂死
export GIT_HTTP_LOW_SPEED_TIME=30
```

- 凭据用环境变量接，不要写进配置文件；URL 里显式带 `https://<用户名>:${TOK}@<host>/...`
- **推完把 remote 改回不含 token 的形式**
- 输出脱敏：`sed -E "s/${TOK}/***/g"` 再打印
- 走代理：`https_proxy` / `http_proxy` 指向可用的代理端口；git 走 HTTP 代理可能要显式 `http.version=HTTP/1.1`，否则报协议协商错误（看起来像仓库损坏）
- 代理支持 CONNECT 时可承载 SSH 隧道（`git@host:` 形式）

## 代理端口

可用的 HTTP 代理端口以实测为准，别沿用记下的旧端口——曾经按旧端口误判机器离线。
直连失败时先试代理，反之亦然。
