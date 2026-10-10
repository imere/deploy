# deploy-kit

把目录或文件部署到 nginx / docker / 静态目录：目标可以在远端也可以在本机，传输方式自动协商，失败自动回滚。

端到端已跑通（本机路径为真跑；远端真机用例默认跳过，需 `DP_SSH_E2E=1`）。

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
  template/      纯模板渲染，零 IO
  log/           结构化日志：JSONL + 出口脱敏
  cli/           命令行与退出码契约
openspec/        行为契约（source of truth）
```

---

## 开发

```bash
pnpm install
pnpm verify        # build + lint + test + 七项静态门禁
pnpm run verify:selfcheck   # 门禁自检：注入违规看它们是否还拦得住
pnpm run verify:mutation    # 变异测试
```

Node ≥ 24。产物落各包 `build/`，测试跑的是产物不是源码；lcov 在 `build/coverage/`。

七项门禁：`dead-code` → `check-imports` → `check-deps` → `check-tests` → `check-jsdoc` → `check-coverage` → `smoke`。纯逻辑包（`schema` / `core` / `template`）要求覆盖率 100%。

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
| `target-nginx` / `target-docker` | 两类目标的行为 |
| `templating` | 模板展开与危险字符校验 |
| `logging` | 日志格式与脱敏 |
| `privilege-layout` | 权限与布局推导 |
| `ssh-runner` | 远端执行与主机密钥 |
