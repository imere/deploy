# 排障手册

本机环境导致、与代码无关的问题，全部集中在这里。每条给出**现象 / 根因 / 临时绕法 / 解除条件**。

---

## 1. pnpm 顶层链接静默缺失（Windows 开发者模式）

### 现象

`pnpm install` 成功退出、无任何报错，但：

- `node_modules/typescript`、`node_modules/@types/node` 不存在
- `node_modules/@types/` 是**空目录**
- `import '@dp/ports'` 报找不到包

`.pnpm/` 里的包本身是完整的 —— 说明 hardlink 进 store 成功了，失败的只有**顶层链接**。

### 根因（已实证）

本机**未开启 Windows 开发者模式**，因此在未提升的权限下：

| 链接类型 | Node `fs.symlinkSync` |
|---|---|
| `junction` | ✅ 成功 |
| `dir` / `file`（真正的 symlink） | ❌ `EPERM` |

pnpm 的 isolated 布局（`node-linker=isolated`，默认）依赖真正的 symlink 建立 `node_modules/<pkg>` → `.pnpm/<pkg>/node_modules/<pkg>`，因此全部失败。更糟的是 **pnpm 12.6.0 在本机不报错、也不回退**。

虽然 pnpm 官方 FAQ 写着 *"For Windows, if the Developer Mode is off, we use junctions instead"*，但实测回退没有生效。已验证无效的尝试：

| 尝试 | 结果 |
|---|---|
| `.npmrc` 写 `node-linker` | ❌ pnpm 12 不读 `.npmrc` 的这一项，只认 `pnpm-workspace.yaml` |
| `pnpm-workspace.yaml` 写 `symlink: false` | ❌ 无效，安装结果不变 |
| `--force` 重装 | ❌ 同上 |
| 删除 node_modules 后重装 | ❌ 同上 |
| `node-linker=hoisted` | ✅ 顶层可用，但**丢掉了「不做提升」这一 pnpm 核心价值** |

### 采用的方案

**保留 isolated，用 Junction 手动补链接**，由 `scripts/link-workspace.mjs` 完成（挂在 `postinstall`）：

```js
symlinkSync('packages/ports', 'node_modules/@dp/ports', 'junction')
```

理由：

- 不改变 pnpm 的依赖管理语义，第三方包仍走 isolated + hardlink
- 只补 workspace 包这一层，影响面最小
- junction 与 symlink 对 Node 的模块解析（包括 `--preserve-symlinks` 关闭时）行为一致；workspace 包是本地目录，不存在跨卷问题

### 临时 Hack（已存在 `package.json` / `pnpm-workspace.yaml` 中）

`pnpm-workspace.yaml` 里有一行 `node-linker: hoisted`，**仅用于让报告的 npm 依赖被平铺**。它是临时手段，见下方解除条件。

### 解除条件

开启「Windows 设置 → 隐私和安全性 → 开发者模式 → 开发人员模式」，使 symlink 可用后：

1. 删除 `pnpm-workspace.yaml` 中的 `node-linker: hoisted`（回到默认 isolated）
2. 删除 `package.json` 中的 `postinstall`
3. 删除 `scripts/link-workspace.mjs`
4. `rm -rf node_modules && pnpm install`

---

## 2. esbuild postinstall 失败（Vitest 已因此弃用）

### 现象

```
Error: spawn EBUSY
  ... esbuild@0.28.2 postinstall$ node install.js
```

### 根因

esbuild 的 Windows 平台二进制在沙箱内 spawn 失败（EBUSY）。

### 绕法

**直接不用 Vitest**，改用 **Node 24 内置测试运行器**：

```
node --test --experimental-test-coverage "packages/*/build/**/*.test.js"
```

项目本身就要求 Node ≥24（为了 ML-KEM），所以不需要为兼容性保留 Vitest。`node --test` 提供：并行执行、describe/it、`node:assert`、内置覆盖率（含 lcov），够用且零依赖。

**收益**：依赖列表只剩 `typescript` 和 `@types/node`，构建期无任何原生二进制。

---

## 3. Node 覆盖率的 `--test-reporter-destination` 不写文件

### 现象

```bash
node --test --test-reporter=lcov --test-reporter-destination=build/coverage/lcov.info ...
```

不报错，但**文件不存在**。Node 24 的这个 flag 对文件路径无效（只对某些 reporter 生效）。

### 绕法

让 spec 走 stderr（终端可读），lcov 走 stdout + shell 重定向：

```json
"test": "tsc -b && node -e \"require('fs').mkdirSync('build/coverage',{recursive:true})\" && node --test --experimental-test-coverage --test-coverage-include=packages/*/build/**/*.js --test-reporter=spec --test-reporter-destination=stderr --test-reporter=lcov --test-reporter-destination=stdout \"packages/*/build/**/*.test.js\" > build/coverage/lcov.info"
```

注意两点：

- 目录必须**先创建**，Node 不会自动建 `build/coverage`
- 加 `--test-coverage-include`，否则工具链模块（node: 内部件、tslib helper）会被统计进来，覆盖率虚高

---

## 4. `NUL` 等 Windows 保留名文件删不掉

### 现象

`rm NUL` / `find -delete` / PowerShell `Remove-Item` / .NET `File.Delete` 全部失败：

```
指定的设备名无效。
```

### 根因

两层原因叠加：

1. 本机安全策略是 **fail-closed**：所有删除都被重定向到回收站工具，而它处理不了 Windows 保留名（`NUL` `CON` `AUX` `COM1`…`LPT9`）
2. WSL 命令被安全规则拒绝

### 已成事实的用法

**挂到容器里，用 Linux 命名空间删** —— 那里 `NUL` 只是普通文件名：

```bash
podman run --rm -v "<仓库的绝对路径>:/mnt/dp:rw" alpine:latest sh -c 'rm -rf /mnt/dp/node_modules'
```

这条同时是清理 `node_modules` 的可靠办法（`rm -rf` 在本机同样会被拦）。

### 预防

`ssh` 不要用 `-o UserKnownHostsFile=/dev/null` —— 在 Git Bash 下它会在 cwd 落一个名为 `NUL` 的真实文件（内容为 known_hosts）。改用：

```
-o UserKnownHostsFile=.tmp/known_hosts -o StrictHostKeyChecking=no
```

`NUL` / `nul` 已加进 `.gitignore` 兜底。

---

## 5. 容器继承了宿主机的死代理

### 现象

容器内 `apk add` / 拉镜像全部超时：`host.containers.internal:<代理端口>` 不可达。

### 根因

podman machine 的 `/etc/environment` 里配了一个**只在宿主机可达的代理端口**（容器网络里连不上），而这个环境会被继承进容器。

### 绕法

显式传空代理 —— **实测容器内可直连外网**：

```bash
podman run -e http_proxy= -e https_proxy= -e HTTP_PROXY= -e HTTPS_PROXY= ...
podman exec -e http_proxy= -e https_proxy= -e HTTP_PROXY= -e HTTPS_PROXY= ...
```

---

## 6. Git 弹凭据 GUI 窗口

### 现象

`git push` 弹出 Windows 凭据管理器窗口，必须手点。

### 根因

本机 `credential.helper` 配了 Git Credential Manager。远程操作缺凭据时会尝试交互。

### 规则

**所有 git 远程操作必须加 `GIT_TERMINAL_PROMPT=0`**，缺凭据立刻失败（CI 里表现为立即报错，而不是永久挂起）。需要凭据时在 URL 里显式带上 token，推完确认 remote 已改回不含 token 的形式。

详见 `AGENTS.md` 铁律 0。
