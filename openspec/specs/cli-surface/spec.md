# Cli Surface Specification

## Purpose

命令行提供的命令，以及每种失败所对应的退出码。退出码是给 CI 与脚本读的契约。

## Requirements

### Requirement: 提供固定的一组命令

系统 SHALL 提供 plan / facts / schema / help / apply / deploy / rollback / verify / status 这些命令。

#### Scenario: 列出可用命令

- **WHEN** 运行 `dp help`
- **THEN** 输出里包含全部命令名

#### Scenario: 未知命令

- **WHEN** 运行一个不存在的命令
- **THEN** 报用法错误并给出相近命令的建议

### Requirement: 退出码按失败类型区分

系统 MUST 用不同退出码区分：成功、部署失败、验证失败且已回滚、配置错误、环境缺依赖。

#### Scenario: 配置本身不合法

- **WHEN** 配置文件解析或校验失败
- **THEN** 进程退出码为配置错误对应的那一个

#### Scenario: 环境缺少所需工具

- **WHEN** 运行前发现环境缺少必需依赖
- **THEN** 进程退出码为缺依赖对应的那一个

#### Scenario: 部署已执行但健康检查未通过

- **WHEN** 部署动作已发生而随后的健康检查不通过，且系统已完成回滚
- **THEN** 进程退出码为「验证失败且已回滚」对应的那一个

#### Scenario: 其他部署失败

- **WHEN** 失败不属于配置错误、缺依赖或验证失败
- **THEN** 进程退出码为通用失败对应的那一个

### Requirement: 失败类型不被改写成别的类型

错误沿调用链上抛时，系统 MUST 保留其原始分类，MUST NOT 把配置错误报成部署失败，也 MUST NOT 用笼统失败覆盖具体分类。

#### Scenario: 配置错误不被当作部署失败

- **WHEN** 失败根因是配置不合法
- **THEN** 退出码是配置错误那一个，不是通用失败

#### Scenario: 清理失败不掩盖真实失败原因

- **WHEN** 某个命令在收尾清理时抛错
- **THEN** 上报的仍是命令本身的真实失败原因，不被清理错误替换

#### Scenario: 错误附带原始原因

- **WHEN** 底层错误被上层包装后上报
- **THEN** 上报结果里仍能取到原始错误，供排障使用

### Requirement: 机器输出与人类输出分离

带机器可读输出参数时，系统 SHALL 只把结构化结果写到一个流，日志与进度一律写到另一个流。

#### Scenario: JSON 模式下 stdout 是纯 JSON

- **WHEN** 以 JSON 模式运行任意命令
- **THEN** 标准输出可被直接解析为 JSON，日志与警告不出现在其中

#### Scenario: 警告不破坏可解析性

- **WHEN** 运行过程中产生了警告
- **THEN** 警告进入结构化结果的相应字段或另一条流，不混入标准输出

### Requirement: 干跑不产生任何写入

带干跑参数时，系统 MUST 只计算不写入。

#### Scenario: 干跑一个完整部署

- **WHEN** 以干跑方式执行部署
- **THEN** 目标位置不产生任何新增内容，且输出明确说明未写入

### Requirement: 多数命令支持人类可读与机器可读两种输出

系统 SHALL 为面向查询的命令同时提供人类可读输出与结构化输出。

#### Scenario: 查询当前状态

- **WHEN** 不带结构化参数运行状态查询
- **THEN** 输出人类可读摘要

#### Scenario: 以结构化方式查询

- **WHEN** 带结构化参数运行同一命令
- **THEN** 输出可被程序消费的结构化结果

### Requirement: 永不交互，压过其它一切行为

系统 MUST 在任何路径下都不等待人类输入：不弹凭据窗、不等 stdin。凭据一律带外给足（git / ssh 的密钥与密码），不满足即报错。远端吐出未预期提示符——密码、sudo、主机密钥确认三类，清单可扩展——时，系统 MUST 立即杀掉该进程并报 `DP.INTERACTIVE_PROMPT_DETECTED`。连接、exec、传输、验收、hook 均带 `timeout`，挂起即失败。

#### Scenario: 凭据没有带外给足

- **WHEN** 某一步需要凭据而环境里没有
- **THEN** 直接报错缺凭据，不弹任何窗口或提示等待输入

#### Scenario: 远端索要 sudo 密码

- **WHEN** 远端命令输出中出现 sudo 密码提示符
- **THEN** 该进程被立即杀掉，报 `DP.INTERACTIVE_PROMPT_DETECTED`

#### Scenario: 提权需要密码

- **WHEN** `sudo` 需要密码
- **THEN** 先用 `sudo -n` 探免密，需密码时以 `sudo -S -p ''` 从受控通道投喂，不开终端提示

#### Scenario: 主机密钥确认

- **WHEN** 目标主机密钥未知
- **THEN** 依赖预置的主机密钥策略（`strict` / `accept-new`）裁决，MUST NOT 出现 `yes/no` 交互确认

### Requirement: 配置文件按固定优先级指定

系统 SHALL 按 `-c` > `DP_CONFIG` > 自动发现（`deploy.config.ts|js|json` 向上冒泡）的优先级确定配置文件，来源冲突时明确报错。

#### Scenario: 同时给了 -c 与 DP_CONFIG

- **WHEN** 两种来源同时存在
- **THEN** 取 `-c` 指定的那份，结果里能看出来源

#### Scenario: 自动发现到多个候选

- **WHEN** 目录冒泡发现多个配置文件
- **THEN** 报错说明冲突，不暗选一个

### Requirement: 帮助信息齐备

系统 SHALL 为每个命令与子命令提供 `description`、`examples` 与 exit codes 说明，支持 `dp --help`、`dp deploy --help`、`dp deploy --help=config`，且所有命令支持 `--json`。

#### Scenario: 查子命令用法

- **WHEN** 运行 `dp deploy --help=config`
- **THEN** 输出该子命令的说明、示例与退出码表

### Requirement: 退出码取值固定

系统 SHALL 按以下取值退出：`0` 成功；`1` 未知错误（或失败且已回滚）；`2` 用法错、或验证失败且已回滚（`--json` 输出的 `error.code` 区分两者）；`3` 配置错；`4` 缺依赖。

#### Scenario: 验证失败已回滚

- **WHEN** 部署验证失败且系统已完成回滚
- **THEN** 退出码为 2，`--json` 下 `error.code` 指明是验证失败

### Requirement: dp explain 打印有效配置来源

系统 SHALL 提供 `dp explain`，打印生效配置及每项的来源文件与行号。

状态：未实现，属设计承诺。
