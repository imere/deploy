# Target Detection Specification

## Purpose

从源清单推断这次要按哪种目标类型部署。探测为纯推导，拿不准时报错而不是猜。

## Requirements

### Requirement: 探测只看注入的源清单

系统 SHALL 只依据调用方注入的源条目与脚本清单做判定，MUST NOT 自行读盘或读环境。

#### Scenario: 同样的条目清单得到同样的候选

- **WHEN** 两次注入相同的条目与脚本清单
- **THEN** 两次产出的候选、证据与置信度完全相同

#### Scenario: 路径分隔符差异不影响判定

- **WHEN** 同一条路径以不同平台的分隔符写法给出
- **THEN** 判定结果相同，证据里以统一形态呈现

### Requirement: 每个候选都要有证据

系统 SHALL 为每个候选给出命中它的具体条目，MUST NOT 产出没有证据的候选。

#### Scenario: 追问为什么判定成某类型

- **WHEN** 有人问某个候选凭什么成立
- **THEN** 结果里列出命中的具体条目名称

#### Scenario: 同一类型被多个条目命中

- **WHEN** 同一目标类型有多个条目作为证据
- **THEN** 它们合并为一个候选，证据去重后排序

### Requirement: 看到了但未实现的类型要说清

系统 SHALL 把「探测到了但本工具还没实现」与「探测到了且可运行」区分开，MUST NOT 把前者当成后者。

#### Scenario: 只有一个未实现的类型被命中

- **WHEN** 唯一命中的候选属于未实现类型
- **THEN** 报错说明该类型尚未实现，并列出已实现的类型供显式指定

#### Scenario: 只有单个镜像描述文件而无编排文件

- **WHEN** 源里只有镜像构建文件而没有编排文件
- **THEN** 该类型判为未实现，不被当作可运行的编排目标

### Requirement: 零命中不假装成静态站点

源里没有任何可识别证据时，系统 MUST 报错，MUST NOT 静默按静态站点处理。

#### Scenario: 源里没有可识别文件

- **WHEN** 探测不到任何候选
- **THEN** 报错列出它看到的文件，并提示显式指定目标类型

#### Scenario: 源清单本身为空

- **WHEN** 注入的条目清单为空
- **THEN** 错误信息说明源清单为空而不是给出一份空文件列表

### Requirement: 多命中按强度仲裁而不是按出现顺序

多个候选同时命中时，系统 SHALL 按证据强度仲裁，MUST NOT 依赖候选在数组里的先后。

#### Scenario: 强度分明的两个候选

- **WHEN** 多个命中里有一个证据强度最高且唯一
- **THEN** 取强度最高的那个，并在结果里列出被舍弃的其它候选

#### Scenario: 强度并列

- **WHEN** 最高的强度档位上有两个及以上候选
- **THEN** 报错说明无法判定，并给出排除办法，不靠顺序暗选

#### Scenario: 未实现的候选不否决已实现的候选

- **WHEN** 存在一个未实现的强信号候选与一个已实现的候选
- **THEN** 未实现的那个不参与取最高，已实现的候选被选中

#### Scenario: 全部命中都未实现

- **WHEN** 所有候选都属于未实现类型
- **THEN** 报错说明这些类型都还没实现，并列出可显式指定的已实现类型

### Requirement: 禁止猜测的模式真的不猜

配置为禁止猜测时，系统 MUST 在出现多个候选时报错，MUST NOT 自动选一个。

#### Scenario: 配置为禁止猜测而出现多个候选

- **WHEN** 命中数大于一且配置为禁止猜测
- **THEN** 报错列出全部候选及其证据与强度，说明如何显式指定

### Requirement: 歧义报错都要给出排除办法

系统 SHALL 在每一条歧义或不支持的报错里给出可执行的下一步，MUST NOT 只列候选。

#### Scenario: 想排除误命中的文件

- **WHEN** 报错源于某个文件被误判为证据
- **THEN** 报错里说明可以把它排除出源清单或改名

### Requirement: 证据到候选的置信度档位固定

系统 SHALL 按固定的证据-置信度表给候选打分，档位表是导出常量而非随手赋值：

| 证据 | 置信度 | 候选 |
| --- | --- | --- |
| compose 文件 | 90 | docker |
| `nginx.conf` | 80 | nginx |
| `*.service` | 60 | systemd |
| `ecosystem.config.js` | 60 | pm2 |
| `Dockerfile` | 50 | 单镜像 |
| `Caddyfile` | 45 | caddy |
| `scripts.deploy` | 40 | delegate |
| k8s 清单 | 30 | k8s |
| 静态文件 | 20 | static |
| 无证据 | — | process（仅可显式指定） |

pm2 / 单镜像 / caddy / k8s / delegate 是可探测到的候选，但不在 `target.type` 可取值里（只认 static / nginx / docker / systemd / process）。零命中报错并列出看到的文件（超 10 条截断）；一命中直接采用；多命中按仲裁规则（见上）。

#### Scenario: 只有 compose 文件

- **WHEN** 源清单里只出现 compose 编排文件
- **THEN** 以 90 档置信度给出 docker 候选

#### Scenario: systemd 与 pm2 证据同时存在

- **WHEN** 源里既有 `*.service` 又有 `ecosystem.config.js`
- **THEN** 两候选同档并列，按仲裁规则处理（并列即报错，未实现候选不参与取最高）

### Requirement: 运行时画像与进程管理器正交

系统 SHALL 把 runtime profile（画像）与 supervisor（进程管理层）作为两个正交维度：profile 取 `node` / `java` / `python` / `static` / `docker` / `other`，每个 profile 定义 detect 证据、build 命令、产物形态、健康检查、资源预算与 unit 模板默认值；`service.managers` 可多配，按探测激活实际存在的那个（CentOS 6 只有 sysvinit、Alpine 是 OpenRC、容器里可能都没有）。

#### Scenario: Java 项目画像

- **WHEN** 源里检出 `pom.xml` / `build.gradle` / `*.jar`
- **THEN** 判为 java 画像，unit 内存预算按 `MemoryMax=Xmx×1.35` 推导

#### Scenario: Python 项目画像

- **WHEN** 源里检出 `requirements.txt` / `pyproject.toml` / `Pipfile` / `poetry.lock` / `uv.lock`
- **THEN** 判为 python 画像，入口按 venv + gunicorn/uvicorn 推导

#### Scenario: 多个进程管理器候选

- **WHEN** 目标机同时存在多个受支持的进程管理器
- **THEN** 按探测结果激活实际在用的那个，不按配置顺序硬选

状态：`service.managers` 与对应执行器未实现，现状只到探测层。
