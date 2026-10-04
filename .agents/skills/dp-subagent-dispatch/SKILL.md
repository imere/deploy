---
name: dp-subagent-dispatch
description: 在本仓派发 mcode 子代理干活的标准姿势 —— 必读清单、prompt 骨架、验收清单、已知故障。当要把一个包/一块功能交给子代理实现，或写完了要验收时使用。
---

# 派发子代理（mcode）

## 1. 调用姿势（非交互）

mcode 不在默认 PATH，**得用全局安装目录里的绝对路径**（各机不同，用 `npm prefix -g` 查；
写死的盘符一换机器就失效，也别把本机路径写进仓库）。版本 0.6.2。
**直接 `mcode <prompt>` 会进 TUI 卡住**，必须用 `exec` 子命令：

```bash
<全局 bin 目录>/mcode exec \
  --cwd "<仓库绝对路径>" \
  --permission full \
  --prompt-mode work \
  --timeout 30m \
  -o .tmp/out-<任务名>.md \
  "$(cat .tmp/prompt-<任务名>.md)"
```

- prompt 很长 → 先写进 `.tmp/prompt-*.md`，再用 `"$(cat ...)"` 传（反引号/`${}` 不会被 shell 二次解析）
- `-o` 落盘的最终汇报要读；`2>&1 | tail -40` 也留一份
- 续跑用 `--continue`（接着上次会话，省掉重读上下文）；它掉线后残留的产物要自己先盘点再续
- 长任务**必须** `run_in_background`，不要用前台等

## 2. 必读清单（强制写进 prompt 的第一节）

子代理不知道本仓约定，不给清单它就会瞎猜、还会把读过的东西复述一遍（烧的是你的 token）。
每条都要写「读它 + 为什么读」：

| 文件 | 为什么要读 |
|---|---|
| `AGENTS.md` | 铁律与工程约定 |
| `packages/ports/src/index.ts` | `Runner`（**只有 `exec(argv[])`，没有 execShell**）、`Facts`、`Capabilities`、`DpError` |
| 同层的**参照实现**（如写 ssh 就看 `packages/local/src/{exec,probe,runner}.ts`） | 照它的风格与抽象层次写 |
| 对应设计文档（`docs/transport.md` / `spikes.md` / `privilege.md` / `security.md` …） | `spikes.md` 是**实测硬约束**，不是参考意见 |
| `docs/config.md` 相关章节 | 配置字段的真实形状 |

要求它在动手前读完；**"我没读过 X" 等于返工**。

## 3. prompt 骨架

1. **背景**：项目是什么、这个包在分层里的位置、依赖方向
2. **铁律**：把本仓铁律逐条抄进去（永不交互、能力实证、歧义靠拒绝、零依赖…）
3. **允许改什么 / 绝对不许改什么**（见下）
4. **详细规格**：API 形状、错误码、边界行为 —— 越具体越好，别让它自由发挥
5. **测试要求**：三类（纯函数单测 / 假实现契约测试 / 真机测试默认 skip）
6. **验收命令**（让它自己跑通再交回）
7. **汇报格式**：文件清单 + 测试数 + git status + 设计取舍 + 没做到的点

## 4. 边界（每次都要写死）

- **不许跑 git**（commit/add/push 全部由 orchestrator 做）
- **不许改 `docs/`**、不许改其他包、不许加依赖、不许跑 `pnpm install`
- 允许且只允许：自己的 `packages/<pkg>/**`；改 `packages/ports/src/index.ts` 时**必须末尾追加**；
  根 `tsconfig.json` 只允许加一行 reference（不加根 `tsc -b` 不会构建新包）
- 源码只许修**被测试暴露的真 bug**，且要写清「原行为 → 为什么是 bug → 改成什么」；
  **不许为了让测试通过放宽断言**（要放宽就说明理由）

## 5. 验收（orchestrator 自己做，不看它的自述）

**第一步永远是 `pnpm build`**（不是 `node --test`）。实测过一次：子代理汇报「全部完成、
错误码都齐了」，而 `tsc -b` 有 16 个错 —— 它新加的错误码没进 `DpErrorCode` 联合，
它自己根本没跑通编译。**自述里的「已完成」不算数。**

```bash
pnpm build                                    # 0 error 才算开始
node --test "packages/*/build/**/*.test.js"   # fail 必须为 0
```

再抽查：
- 禁项 grep：`console.log` / 静态 `import 'ssh2'` / `execShell` / `node:fs`（纯包里）
- **禁项 grep（新增，必查）**：`§` 与 `\w+\.md`。子代理爱在注释里写「见 docs/x.md §N」
  「与 x.md §N 逐字符一致」—— 章节号会漂移、读代码的人手边没有文档，一律删掉并把事实
  就地写清。派发时把这条写进 prompt 的边界里，能省掉一轮返工。
  （清理脚本见 `.tmp/strip-refs*.mjs`；**注意**：别在源码里无差别删 `.md`，测试夹具与
  字符串里的文件名是数据，只处理注释行。）
  ——**先把注释剥掉再 grep**：包头的纪律说明里往往就写着「本包不 import `node:fs`、不读 `process.env`」，
  直接全文件匹配必然误报。用 `/\/\*[\s\S]*?\*\//g` + 行注释过滤后再匹配。
- **「plan 里带了、但没人消费」的字段**：翻一遍新加的 `detail.*`，逐个确认有代码真的读它。
  实测抓到 `onlyServices` 只进了 `detail`、全仓无人消费 —— 下一轮执行器就会自己另写一套判定，
  于是「哪些服务算数」有两处实现。判定要**收口在纯函数侧**，执行器只传参。
- 私有环境没被写进代码或注释（见 §7）
- **写一份独立验收脚本**断言行为，不采信它的测试（`.tmp/accept-*.mjs`）
- 注释是"解释为什么"还是"复述代码"——后者要删

## 6. 已知故障

| 现象 | 处理 |
|---|---|
| `The run failed: terminated. Retry after the connection recovers.` | 运行时掉线，非代码问题。盘点残留产物 → `--continue` 续跑 |
| `mcode exec cancelled` + `safe-delete ... ETIMEDOUT` | 同上；清理临时目录时卡住拖垮了进程 |
| `Runtime shutdown did not complete cleanly` + 沙箱拒写 `C:\Users\<用户名>\.minimax\**` | 它在写自己的会话/日志目录被拦。**先 `git status` 盘点**：它很可能已经把源码写完在盘上了（实测一次：汇报文件没落盘，但 `executor.ts` 与测试都在）。盘点完再决定是否 `--continue`，别看到 failed 就重派（会撞车）。派发时加 `dangerouslyDisableSandbox: true` 可避开 |
| `Sign in to MiniMax to use Agent features. Run \`mcode login\`` | **凭据被清空**（`~/.minimax/auth/prod/cn/mcode-public/auth.json` 的 `records` 变 `{}`、`auth-state.json` 的 `status` 变 `error`）。跑一次 `mcode login --no-browser --region cn`（**必须带 `--no-browser`**，默认会拉起浏览器窗口），多数情况是刷新成功并输出 `Already signed in with MiniMax.` |
| `agent_name_conflict_migration_failed:lock` | 上一次被掐死的进程留下的 runtime 锁。**再跑一次就好**，不要去删 `~/.minimax` 下的 `.lock` 文件 |
| `mcode exec` 报 failed 但 `git status` 干净 | 先探活再决定：`timeout 90 mcode exec --cwd … -o .tmp/out-ping.md "回复 PONG 两个字"`。排查顺序固定 **ping → `login --no-browser` → 再 ping → 才重派**。别因为 mcode 挂了就改派别的子代理（会撞车、且烧的是另一份配额） |
| 全量 `pnpm test` 突然冒出一批跨包失败（`@dp/local` 的 exec、`@dp/ssh` driver、用到 `F:\Temp` 的用例） | **先看是不是沙箱**：它会拦临时目录写入与 build 产物读取，还会让真起子进程的用例单个跑 80~130 秒。实测 21 个失败全是环境造成，关掉沙箱复跑即 0 fail。**不要去改代码** |
| 单次跑 15 分钟以上 | **拆小**：先源码、再测试、再收口。每轮目标 ≤ 10 分钟 |
| 一次派两个子代理 | **绝对不要**。会同时改 `ports/src/index.ts`、并发 `tsc -b` 打架 |
| 同一个包先后派两个（前一个还没停） | 更糟：产出**两套设计叠加的半成品**（两份 config 加载模块、孤儿文件、编译错）。**派发前先确认没有在跑的同包任务**；发现撞车就先停掉后发的那个，再派一个"收敛"轮：指定保留哪套、删掉孤儿模块对 |

## 7. 子代理产出物的常见病

1. **注水**：注释复述代码、文档写大片套话、为了满足"要注释"而注释。
   处置：注释只留「为什么这么定 / 不这么定会怎样」，其余删。
2. **泄露私有环境**：把本机绝对路径、代理端口、token、用户名写进文档或注释。
   处置：提交前 grep 一遍（仓库绝对路径 / 代理端口 / `127.0.0.1` / `ghp_` / `C:\Users\<用户名>`），命中就参数化。
   注意区分：容器靶机地址（`127.0.0.1:2222`、`dpuser`）是**可复现的实验环境**，不算泄露。
3. **用类型 cast 假装接上了不存在的字段**：典型写法
   `(hostConfig as { readonly hops?: readonly string[] }).hops` —— schema 里根本没有这个字段，
   编译过、运行时恒为 undefined，还让人以为能力已接上。
   处置：验收时 grep `as {` / `as unknown as`，命中就问「这个字段在类型定义里真的存在吗」。
4. **只在「提前校验」的那条路径上用用户输入，真正的执行点拿不到**：例 —— 把用户配的
   `preferred` 传给了「为了打日志而先跑一次」的协商，执行函数内部再协商时没传下去，
   于是日志说 A、实际跑 B。
   处置：凡是「同一件事算两遍」的地方，逐处确认输入一致；并写一条**只有这个差别能被观测到**
   的测试（例：两端 rsync/tar 都有时点名 tar-ssh —— 默认链会选 rsync，测不出来就说明测试没用）。

## 8. 变异验证（新写的回归测试到底有没有用）

写完一条回归测试后，用编译产物做一次反向验证，成本一分钟：

```bash
cp packages/<pkg>/build/<file>.js .tmp/x.bak
node -e "改掉 build 里那行修复（sed/replace）"     # 临时撤掉修复
node --test packages/<pkg>/build/<那个>.test.js    # 必须变红
cp .tmp/x.bak packages/<pkg>/build/<file>.js && pnpm build   # 还原并重建
```

撤掉修复仍然全绿 = 这条测试是摆设，重写。
**只改 `build/` 不动 `src/`**，改完一定还原并 `pnpm build`，别把变异留在源码里。

**变异要往「与正确实现只差一点点」的方向做，而且要检查变异后的行为真的不同。**
实测踩过一次：修的是「撤销目录时登记**最外层原本不存在的那级**」，写了条
「不许误删上一轮影子目录」的测试，再变异成「删整条链最外层」—— 结果**全绿**。
因为夹具里 `.dp-shadow` 本来就存在，两条路径算出同一个结果，测试根本没区分它们。
补了「confd 都是本轮刚建的」那个用例才卡住。

所以：变异验证通过 ≠ 覆盖面够。每次变异前先问一句
「**这个变异在当前夹具下，算出来的东西和正确实现一样吗？**」一样就换夹具。
同一种修复往往要做 2~3 个方向的变异（漏删 / 多删 / 记错状态）才算验过。
