---
name: dp-subagent-dispatch
description: 在本仓派发 mcode 子代理干活的标准姿势 —— 必读清单、prompt 骨架、验收清单、已知故障。当要把一个包/一块功能交给子代理实现，或写完了要验收时使用。
---

# 派发子代理（mcode）

## 1. 调用姿势（非交互）

mcode 不在默认 PATH，绝对路径是 `<全局 bin 目录>/mcode`（0.6.2）。
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

```bash
node_modules/.bin/tsc -b
node --test "packages/*/build/**/*.test.js"   # fail 必须为 0
```

再抽查：
- 禁项 grep：`console.log` / 静态 `import 'ssh2'` / `execShell` / `node:fs`（纯包里）
- 私有环境没被写进代码或注释（见 §7）
- **写一份独立验收脚本**断言行为，不采信它的测试（`.tmp/accept-*.mjs`）
- 注释是"解释为什么"还是"复述代码"——后者要删

## 6. 已知故障

| 现象 | 处理 |
|---|---|
| `The run failed: terminated. Retry after the connection recovers.` | 运行时掉线，非代码问题。盘点残留产物 → `--continue` 续跑 |
| `mcode exec cancelled` + `safe-delete ... ETIMEDOUT` | 同上；清理临时目录时卡住拖垮了进程 |
| 单次跑 15 分钟以上 | **拆小**：先源码、再测试、再收口。每轮目标 ≤ 10 分钟 |
| 一次派两个子代理 | **绝对不要**。会同时改 `ports/src/index.ts`、并发 `tsc -b` 打架 |
| 同一个包先后派两个（前一个还没停） | 更糟：产出**两套设计叠加的半成品**（两份 config 加载模块、孤儿文件、编译错）。**派发前先确认没有在跑的同包任务**；发现撞车就先停掉后发的那个，再派一个"收敛"轮：指定保留哪套、删掉孤儿模块对 |

## 7. 子代理产出物的两个常见病

1. **注水**：注释复述代码、文档写大片套话、为了满足"要注释"而注释。
   处置：注释只留「为什么这么定 / 不这么定会怎样」，其余删。
2. **泄露私有环境**：把本机绝对路径、代理端口、token、用户名写进文档或注释。
   处置：提交前 grep 一遍（仓库绝对路径 / 代理端口 / `127.0.0.1` / `ghp_` / `C:\Users\<用户名>`），命中就参数化。
   注意区分：容器靶机地址（`127.0.0.1:2222`、`dpuser`）是**可复现的实验环境**，不算泄露。
