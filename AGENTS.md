# AGENTS.md

deploy-kit：把目录/文件通过 rsync / scp / ssh 部署到本地或远端（nginx、docker、systemd 等）。
pnpm 单仓多包，包名前缀 `@dp/*`。**Node ≥ 24**。

## 铁律

0. **永不交互。** 任何命令都不允许等待人类输入——弹窗 = 这次自动化是假的，且在 CI 里表现为永久挂起。
   - git 远程操作一律 `GIT_TERMINAL_PROMPT=0`；**推送必须显式带凭据**，不要先把 token 从 remote 摘掉再 push
   - ssh 走密钥：`-o BatchMode=yes -o IdentitiesOnly=yes -o NumberOfPasswordPrompts=0`
   - ssh 走密码：`SSH_ASKPASS=<助手> SSH_ASKPASS_REQUIRE=force` + `< /dev/null`
   - 所有子进程必须有 `timeout` 兜底

1. **不臆测能力，先实测。** 目标机上"看起来有"的东西不等于能用（例：`command -v su` 有，但 busybox su 缺 suid 位，实际失败）。
2. **歧义靠拒绝，不靠默认值。** source 路径写法、多 target 命中 —— 无法判定时报错并给出可选写法，绝不猜。
3. **安全不让步**：路径归一化 + 允许根校验、显式 mode、传输后哈希校验、主机密钥默认 strict、凭据不进日志。
4. **临时文件一律进 `.tmp/`**，不得散落仓库。
5. **所有产物进 `build/`**（含覆盖率）；包的 `files` 只写 `dist`，不直接写 `build`。
6. **文档保持精炼**，改代码顺手改对应文档，不新增说明性 markdown。

## 命令

```
pnpm build    # tsc -b，产物 packages/<pkg>/build
pnpm test     # 构建 + node --test + 覆盖率 → build/coverage/lcov.info
pnpm verify   # build + test
pnpm clean    # tsc -b --clean
```

Node ≥ 24（见 `.nvmrc`）。**不用 Vitest**：它依赖的 esbuild 平台二进制在部分 Windows 环境装不上，
而 Node 24 内置测试运行器够用且零依赖。

测试文件与源码同目录（`src/*.test.ts`），经 `tsc -b` 落到 `build/` 后由 `node --test` 执行；
覆盖率只统计 `packages/*/build/**`。写新能力时同步补三样：纯函数夹具测试、真实 IO 测试、一条能指导下一步的错误路径断言。

Windows 未开启开发者模式时，pnpm 的 isolated 布局会静默丢链接，`postinstall` 里的
`scripts/link-workspace.mjs` 用 junction 补上。**不要为了绕坑改成 hoisted** ——
那等于丢掉 pnpm 的核心价值。解除条件。

## 目录

```
packages/       @dp/* 各包（ports / schema / core / local / log / ssh / target-static / transport / template / target-nginx / target-docker / cli 均已接线）
docs/           设计文档（★ 优先读：spikes.md failures.md decisions.md privilege.md）
.agents/skills/ 可复用的操作流程（dp-spike-env / dp-subagent-dispatch）
.tmp/           临时物（已 gitignore）
build/          覆盖率产物所在根目录（已 gitignore）
```

## 派发子代理（mcode）

大块实现交给子代理，但**派发与验收都在这里**，见 `.agents/skills/dp-subagent-dispatch/SKILL.md`。三条不能省：

1. **必读清单写进 prompt 第一节**，并强制先读：`AGENTS.md` + `packages/ports/src/index.ts`（Runner 只有 `exec(argv[])`）
   + 同层参照实现（写 ssh 就看 `local/src/{exec,probe,runner}.ts`）+ 对应设计文档（`spikes.md` 是**实测硬约束**）。
   不给清单 → 它瞎猜，还会把读过的东西复述一遍烧你的 token。
2. **边界写死**：不许跑 git、不许改 `docs/`、不许加依赖；改 `ports/src/index.ts` 只能末尾追加。
   源码只许修**被测试暴露的真 bug**，且不许为过测而放宽断言。
3. **验收自己来做**：`tsc -b` + 全量 `node --test` + 一份独立验收脚本断言行为（不采信它的测试）
   + grep 禁项（`console.log` / `execShell` / 纯包里的 `node:fs`）+ grep 私有环境。

## 写作纪律（文档与注释）

- **注释只解释「为什么这么定 / 不这么定会怎样」**，不复述代码在做什么。复述型注释是噪声，见到就删。
- **不引用文档章节**：注释、`hint`、schema 的 description（用户看得见的那几处）里都不写
  「见 docs/x.md §N」「与 x.md §N 逐字符一致」这类指向章节号的引用。**章节号会漂移** ——
  实测撞过一次：文档写 `target.pick: highest | first`，schema 实际是 `auto | fail`。
  而且读代码的人手边没有文档，写了等于没写。依据要么**就地把事实写清楚**，要么指向代码
  （`@dp/template` 的 `KNOWN_VARS`、`canElevate()` 之类）；代码里连文档名都不要出现，
  `spikes.md S5 实测 …` 只留「实测 …」。文档之间的指路不算这条（那是导航，不是依据）。
- **不写私有环境**：开发机绝对路径、代理端口、token、用户名一律不进文档与注释，用占位符或参数化写法。
  （容器靶机地址 `127.0.0.1:2222` / `dpuser` 是可复现的实验环境，不算。）
- **不注水**：文档按"改代码顺手改对应文档"维护，不新增说明性 markdown；套话式的"总结"不写。
- 子代理产出物尤其要过这两条 —— 它天生爱写复述型注释，也会把开发机环境写进去。

## 架构要点（改动前先读）

- **分层**：`schema`（类型/define\*）→ `ports`（接口）→ `core`（编排 + 目标探测）→ 实现包 → `cli`
- **目标探测（`@dp/core/detect.ts`）**：源清单与 `package.json` 的 scripts **都由调用方注入**
  （它零 IO，否则 `makePlan()` 那套纯函数断言就不成立了）。仲裁比探测更保守：
  0 命中报错（列出它看到了哪些文件，不假装 static）、未实现的类型报错而不降级、
  `pick: auto` 下**最高分并列就报错**（并列还靠数组顺序选 = 暗选）。
  未实现的候选**不参与**取最高 —— 否则源里躺一个 `Caddyfile` 就能否决一个 compose 项目
- **偏好链**：transport / jump / transfer / supervisor 都是候选链，全失败时输出结构化错误（每项原因 + 建议）
- **护栏层**：目标机状态日志 + 带租约的部署锁 + 两阶段激活 `trial→promote`；unit 必须注入 `MemoryMax`/`StartLimitBurst`/`Restart=on-failure`
- **抗量子**：ssh2 **不支持**，只能靠 `native-ssh` 驱动；密码登录用 `SSH_ASKPASS`（不需要 sshpass）
- **日志**：一律走 `@dp/log`，脱敏在 sink 出口统一做，禁止单点 `console.log`；日志抛错绝不上抛
- **远端**：`@dp/ssh` 驱动偏好链 `native-ssh` → `ssh2`（ssh2 运行时可选加载，本机没装即表现为不可用）；
  **多跳对用户未开放**：`@dp/ssh` 的 `connect()` 对非空 `hops` 显式抛 `DP.CONFIG.INVALID`；
  `@dp/transport` 的 rsh 能构造 `-J a,b` 与 `ProxyCommand` 两种 argv，但配置里没有 `hops` 字段。
  开放要同时动 schema 与 ssh 驱动，别在 apply 里 cast 一个不存在的字段假装接上了
- **模板**：渲染一律走 `@dp/template`，变量表以 为准（不发明变量名）；
  `$host` / `$request_uri` / `$1` 之类**必须原样保留**（吃掉它们产出的 nginx conf 直接废掉），
  要字面量 `${x}` 写 `$${x}`。包本身零 IO：环境变量、git 状态、时钟都由调用方注入，
  否则 `makePlan()` 就不再是纯函数。缺值与空值一律报 `DP.TPL.*`，**绝不留下 `${x}` 原文**
- **nginx**：conf 不手写，由 `@dp/target-nginx` 从结构化配置生成；反代头是**默认正确**而不是
  「记得才写」。值里的 `;` `{` `}` 一律拒（一个分号就多出一条指令）；`proxy_pass` 末尾斜杠的
  两种语义不同，**报错而不替用户选**；只覆盖带 `# managed by dp` 的文件，遇同名未标记文件报错。
  生效顺序固定：写候选 → 影子校验 → 原子替换 → `nginx -t` 复验 → reload（两步 `-t` 是刻意的）。
  目标机路径（`confd`）**不是配置项**，由实测能力推导后注入：显式 `target.confd` > 按 platform
  取候选里第一个 `canWrite === true` 的 > 都没有报 `DP.PERM.CONFD_NOT_WRITABLE`。
  `canWrite` 里没有那个键就是不可写 —— 当成「可能可写」去猜是这类 bug 的标准形状。
  两份 facts 来源（`@dp/ssh` 与 `@dp/local`）的探测候选**必须一致**，否则同一份配置会
  在远端推得出来、本机推不出来
- **docker**：compose 的每条 argv **只在 `compose.ts` 里写一次**，plan 与执行器各写一份 =
  计划说一套、真跑另一套。校验覆盖面按「值被拼进什么」数：进 argv 的都要过
  `@dp/template` 的 shell 档，项目名另过字符集（它成为容器名/网络名前缀）。
  compose 文件随 release 上传，路径一律相对 release 目录（绝对路径 / `..` / 反斜杠全拒）。
  **compose 文件里的变量不由 dp 解释** —— compose 自己有一套 `${VAR}` 与 `$$`，
  两份引擎互吃的后果是 tag 变空或 `variable is not set`。
  验收用 `compose ps --format json`（不是 `docker ps`：后者列的是这台机器上所有容器），
  **读不出结论就报错，绝不判通过**；`services` 的判定范围也收口在 `parseComposePs` 里。
  回滚 = 用上一版 compose 重新 up 且**不 pull**；首次部署报 `DP.DOCKER.NO_PREVIOUS`
  而不是假成功，也不自动 `down`（那会连停掉目标机上同名的其它项目）。
  **`dp apply` 里 docker 的顺序是 deploy → install → activate，与 nginx 相反**：
  compose 文件是随 release 上传的，install 只做 stat 确认，排在传输之前它永远失败
  或什么也没证明。照抄 nginx 的 install → deploy → activate 是本轮最容易犯的错。
  `dp rollback` 里 docker 的 ctx 要**重建**一份：给 static 的那份 `previousReleaseId`
  是「当前版本」（static 的语义是「从 current 退到 previous」），直接传下去会让执行器
  拿当前版本的 compose 重新 up —— 那不是回滚，而且报告会显示成功
  执行器**不自动补偿**：up 失败既不停容器也不自动 up 上一版（后者是 `dp rollback` 的职责，
  自动做会把「失败」与「已回滚」两个语义混成一个），只把可执行的 `healing` 命令交给用户
- **`dp apply` 里 nginx 的三段顺序是 install → deploy → activate**（docker 相反，见上一条），不是随手排的：install 碰的是影子
  目录，能在动任何生产路径之前挡掉坏 conf；conf 的 `root` 用 `${release.current}` **软链**
  所以先切版本再换 conf 安全（反过来会留下指向未就绪目录的 conf）。activate 失败
  **不回滚 release**：版本本身是好的（健康检查过了），退掉它只会把「一个 conf 问题」
  变成「一次服务中断」；但必须说清状态、退出码非 0
- **nginx 执行器的三条不变量**：① 不重排步骤 —— 每条 argv 都从计划的 `detail.argv` 取，
  执行器里不另写一份（两份 argv 各改各的 = 计划与真跑悄悄分叉）；② 判定先于副作用 ——
  所有权判定排在任何 mkdir/writeFile 之前；③ 失败必须留痕 —— 补偿失败不许吞掉原错误。
  复验失败**必须还原后再验一次**（只 rename 不复验，报出来的「已还原」可能仍是个坏树）；
  reload 失败**不回滚**（盘上 conf 已过 `-t`，换回去只会制造第二次不一致）
- **dryRun 的痕迹不许说谎**：步骤的 `skipped` 判据是「在机器上有没有留下作用」，
  不是「跑没跑」。dryRun 下影子校验照跑（它给的结论是真的，记 ran），
  但它写进去的候选随即被撤销（记 skipped）。「报告了没发生的副作用」比不做更难发现

## 提交

- 粒度：一处结论/一个包一次提交，不要攒大批
- 消息：`类型: 简述`（feat / fix / docs / test / refactor / chore）
- 推送后把 remote URL 改回不带 token 的形式

## 测试靶机

需要真 SSH 目标时用 podman 起容器，见 `.agents/skills/dp-spike-env/SKILL.md`。
