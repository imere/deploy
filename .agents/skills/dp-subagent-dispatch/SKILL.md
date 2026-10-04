---
name: dp-subagent-dispatch
description: 本仓（@dp/*）派发 mcode 子代理的项目专属补充 —— 本仓必读清单、可改范围、本仓特有的故障。通用方法论与验收纪律见 subagent-dispatch skill。
---

# 派发子代理（本仓补充）

**通用方法论（prompt 骨架、边界写法、验收顺序、故障表、产出物常见病）见
`.agents/skills/subagent-dispatch/SKILL.md`。** 本文件只写本仓专属的部分。

## 1. 调用姿势

mcode 不在默认 PATH，用全局 bin 目录（各机不同，`npm prefix -g` 查；
**别把查出来的盘符写进仓库**）。**直接 `mcode <prompt>` 会进 TUI 卡住**，必须用 `exec`：

```bash
<全局 bin 目录>/mcode exec \
  --cwd "<仓库路径>" \
  --permission full \
  --prompt-mode work \
  --timeout 25m \
  -o .tmp/out-<任务名>.md \
  "$(cat .tmp/prompt-<任务名>.md)"
```

长任务必须后台跑。派发时加 `dangerouslyDisableSandbox: true`（否则它清理自己的会话目录
会被安全护栏卡死，实测会拖垮整个进程）。

## 2. 本仓必读清单（写进 prompt 第一节，每条带「为什么」）

| 文件 | 为什么 |
|---|---|
| `AGENTS.md` | 铁律与工程约定 |
| `packages/ports/src/index.ts` | `Runner`（**只有 `exec(argv[])`，没有 execShell**）、`Facts`、`Capabilities`、`DpError`、`DP_ERROR_CODES` |
| 同层**参照实现**（写 ssh 就看 `packages/local/src/{exec,probe,runner}.ts`） | 照它的风格与抽象层次写 |
| 对应设计文档（`docs/spikes.md` / `failures.md` / `transport.md` / `privilege.md` / `security.md`） | `spikes.md` 是**实测硬约束**，不是参考意见 |
| `docs/config.md` 相关章节 | 配置字段的真实形状 |
| 上一批同主题的改动（`git log` 找） | 保持设计连贯，别另起一套 |

要求它动手前读完；**「我没读过 X」等于返工**。

## 3. 本仓边界

- **不许跑 git**（commit / add / push 全部由我做）
- 允许且只允许：指定的 `packages/<pkg>/**`
- 改 `packages/ports/src/index.ts` 时**必须末尾追加**（并发改必冲突）；
  根 `tsconfig.json` 只允许加一行 reference（不加根 `tsc -b` 不会构建新包）
- 不许改 `docs/`、不许加依赖、不许跑 `pnpm install`
- 源码只许修**被测试暴露的真 bug**，不许为过测放宽断言

## 4. 本仓验收命令

```bash
pnpm build                                    # 0 error 才算开始
node --test "packages/*/build/**/*.test.js"   # fail 必须为 0（关沙箱跑）
```

**第一步永远是构建。** 实测过：它汇报「错误码都齐了」，而构建有 16 个错 ——
新加的码没进 `DP_ERROR_CODES` 联合，它自己根本没跑通。

本仓额外必查：
- 新码必须在 `docs/failures.md` 登记表里（有棘轮测试守着）
- 禁项 grep：`console.log` / 静态 `import 'ssh2'` / `execShell` / 纯包里的 `node:fs`
- 禁项 grep：`§` 与文档名（**先把注释剥掉再匹配**，包头纪律里常写着「本包不用 X」）
- 私有环境（仓库路径 / 代理端口 / 用户名 / token）

## 5. 本仓特有的故障

| 现象 | 处理 |
|---|---|
| 报 failed 但汇报文件空 | **先 `git status` 盘点**：实测多次代码已经写完在盘上。别看到 failed 就重派 |
| 凭据失效 | 用**无浏览器**的登录命令刷新（默认会拉浏览器窗口） |
| 全量测试冒出一批跨包失败 | 多半是沙箱（见 `windows-sandbox-gotchas`）。关沙箱复跑再判断 |
| 一次派两个 / 同包先后派两个 | 绝对不要。会并发 `tsc -b` 打架，或产出两套设计叠加的半成品 |

## 6. 相关

- 通用方法论：`subagent-dispatch`
- 验收强度：`mutation-verify`、`fake-test-audit`、`accept-script`
