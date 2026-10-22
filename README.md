# deploy-kit

把目录或文件部署到 nginx / docker / 静态目录：目标可以在远端也可以在本机，传输方式自动协商，失败自动回滚。

端到端已跑通。集成层由 `pnpm run integration` 承担：容器起靶机（sshd / nginx / systemd）
真 ssh 进去部署，断言读的是机器而不是 dp 自己的报告（CI 每次都跑）。六个场景：
static / nginx / process / systemd 在容器靶机上；docker 跑在**宿主**上（容器里塞一个
dockerd 的结论是「环境允不允许」，不是「dp 对不对」，宿主有真 docker 与真 compose）；
hops 是经一跳跳板的多跳，断言不只看落点 —— 还看跳板 sshd 里多出来的会话，因为直连
同样能部署成功。

```bash
dp deploy          # 自动识别项目类型、自动选传输方式、自动提权、自动验证，失败自动回滚
dp rollback        # 回到上一个版本
```

不写配置文件也能用（零配置）。想控制细节时，配置从 3 个字段起步。

---

## 命令

| 命令 | 干什么 |
| --- | --- |
| `dp plan --json` | 干跑：布局 / 发布根候选（含实证可写性）/ 每一步与它的撤销项 |
| `dp facts --json` | 目标机事实与能力，全部实测 |
| `dp schema` | 导出 JSON Schema，写进编辑器就有补全与校验 |
| `dp apply` | 真部署：写 `releases/<id>` → 原子切 `current` → 健康检查 → 保留 N 版。加 `--dry-run` 只算不写 |
| `dp deploy` | 零配置入口。默认干跑，加 `--yes` 才落盘 |
| `dp status --json` | 当前版本 / 上一版 / 健康与否（只读，查到坏消息也退 0） |
| `dp verify --json` | 只跑健康检查，不通过退 2（CI 用） |
| `dp rollback --json` | 切回上一版并复查。只切换不清理，不接受 `--dry-run` |
| `dp help [command]` | 看某个命令的用法 |

退出码：成功 `0` / 部署失败 `1` / **验证失败且已回滚 `2`** / 配置错 `3` / 环境缺依赖 `4`。

`apply` 失败会自动回滚。回滚本身失败时不假装成功，会报告 `needsHealing` 并给出人工下一步命令。

---

## 配置

最简形态（等价的三字段）：

```yaml
project: web
target: { kind: static }
hosts:
  prod: { ssh: deploy@example.com }
```

写在 `.dp/deploy.yml` / `.dp/deploy.yaml` / `.dp/deploy.json` 里，或用 `--config` 指定。完整字段与校验规则见 `openspec/specs/config-schema/spec.md`。

多跳写 `hosts.*.ssh.hops`，逐跳 `{ ssh, auth, knownHosts, port }`，最后一跳是目标机。

---

## 目录地图

```
packages/
  ports/         纯类型与错误码
  schema/        配置 schema DSL（类型推导 + 路径定位 + JSON Schema 导出）
  core/          plan 纯函数：路径校验、布局推导、release 目录推导、step 生成
  local/         本机 Runner：能力实证、命令执行、源枚举
  ssh/           远端 Runner：驱动偏好链 native-ssh → ssh2、主机密钥、能力实证
  transport/     传输协商与执行：rsync-ssh / tar-ssh / sftp / scp / local-copy
  target-static/ 静态投放：releases/<id> + current 原子切换 + keep N
  target-nginx/  nginx 目标：conf 渲染 + 影子校验 + 两步 -t
  target-docker/ docker 目标：compose argv + ps 解析
  target-systemd/ systemd 目标：unit 渲染 + 影子校验 + 原子替换 + is-active
  target-process/ 裸进程目标：pidfile + 先信号后强杀 + kill -0
  template/      纯模板渲染，零 IO
  log/           结构化日志：JSONL + 出口脱敏
  cli/           命令行与退出码契约
openspec/        行为契约（source of truth）
```

---

## 开发

```bash
pnpm install
pnpm verify        # build + lint + test + 八项静态门禁
pnpm run integration        # 真机集成测试（需要容器运行时）
pnpm run verify:selfcheck   # 门禁自检：注入违规看它们是否还拦得住
pnpm run verify:mutation    # 变异测试
pnpm run build:bin # 打成单文件可执行程序 → build/bin/dp-<platform>-<arch>
```

Node ≥ 24。产物落各包 `build/`，测试跑的是产物不是源码；lcov 在 `build/coverage/`。

单文件产物：把编译产物嵌进运行时二进制，启动时落到缓存目录再按 ESM 原样加载
（不打包、不转换模块格式，所以不存在「源码跑得对、产物跑不对」这条分叉）。
**只为构建机所在平台产出**，别的平台交给 CI 矩阵各出一次 —— 当前覆盖 `linux-x64` 与 `win32-x64`。
产物自带自检（真跑一次 `--version` 与 `--help`），跑不起来就是构建失败。
外部工具（ssh / rsync / tar / scp）**不进产物**，仍从执行环境里找，缺了会报缺的是哪个。

发版：`.github/workflows/binary.yml` 里，**只有推送 `v*` 标签才发 Release**，发的是当次流水线
构建并通过自检的那两个文件；推 main 只留 artifact 不发版。

```bash
git tag v0.0.0-alpha && git push origin v0.0.0-alpha   # 触发构建 + 发布
```

八项门禁：`check-versions` → `dead-code` → `check-imports` → `check-deps` → `check-tests` → `check-jsdoc` → `check-coverage` → `smoke`。纯逻辑包（`schema` / `core` / `template`）要求覆盖率 100%。

---

## 行为契约

系统**实际做了什么**写在 `openspec/specs/<capability>/spec.md`，每条需求带可验证的场景。改动行为前先看那里。

| capability | 内容 |
| --- | --- |
| `cli-surface` | 命令与退出码契约 |
| `config-schema` | 配置校验、错误报告、JSON Schema 导出 |
| `planning` | 从配置到计划 |
| `target-detection` | 目标类型探测与仲裁 |
| `facts-capabilities` | 事实与能力的实测范围 |
| `release-layout` | 版本目录布局与原子切换 |
| `rollback` | 回滚触发与失败处理 |
| `transport` | 传输协商与执行 |
| `target-nginx` / `target-docker` / `target-systemd` / `target-process` | 四类目标的行为 |
| `templating` | 模板展开与危险字符校验 |
| `logging` | 日志格式与脱敏 |
| `privilege-layout` | 权限与布局推导 |
| `ssh-runner` | 远端执行与主机密钥 |
| `packaging` | 单文件可执行产物 |
