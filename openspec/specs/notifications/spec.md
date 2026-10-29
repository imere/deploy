# Notifications Specification

## Purpose

部署生命周期事件对外通知的模型：事件清单、驱动注册表与通知自身失败时的处置口径。

## Requirements

### Requirement: 生命周期事件集固定

系统 SHALL 在以下生命周期节点发出通知事件：`pre-resolve`、`pre-connect`、`post-connect`、`pre-transfer`、`post-transfer`、`pre-activate`、`post-activate`、`on-verify`、`on-promote`、`on-failure`、`on-rollback`。

#### Scenario: 事件按阶段发出

- **WHEN** 一次部署走到某个生命周期节点
- **THEN** 对应事件被发出，未配置通知驱动时发出动作本身零开销

#### Scenario: 失败与回滚都有事件

- **WHEN** 部署失败并随后回滚
- **THEN** `on-failure` 与 `on-rollback` 都被发出，消费方能区分两者

### Requirement: payload 是脱敏后的结构化事件

系统 SHALL 让通知 payload 是结构化事件，且在发出前按日志同源规则脱敏，MUST NOT 把密码、私钥或 token 带出进程。

#### Scenario: payload 里含凭据字段

- **WHEN** 事件载荷里出现疑似凭据的键或值
- **THEN** 发出前被替换为占位符，与日志出口同一套规则

### Requirement: 通知驱动走注册表

系统 SHALL 以驱动注册表扩展通知渠道，内置 `exec`（本地命令）、`webhook`、`email(smtp)` 与 `js`（用户函数）四类驱动。

#### Scenario: 配置多个驱动

- **WHEN** 同一事件配置了多个驱动
- **THEN** 各驱动独立收到事件，互不阻塞

#### Scenario: 未知驱动名

- **WHEN** 配置里写了注册表之外的驱动名
- **THEN** 校验报错指出该驱动不存在

### Requirement: 通知自身必须配 onFailure 与 timeout

每个通知配置 SHALL 必须给出 `onFailure: 'abort' | 'warn' | 'ignore'`（默认 `warn`）与 `timeout`，MUST NOT 允许无超时的通知调用。

#### Scenario: 通知端点挂起

- **WHEN** 某个通知驱动超过 timeout 仍未返回
- **THEN** 该通知按 timeout 判失败，随后按 onFailure 处置：abort 终止部署、warn 记告警、ignore 静默继续

#### Scenario: 通知失败不静默改语义

- **WHEN** 通知失败的处置被配置为非默认值
- **THEN** 按配置执行，且缺省时不等价于 ignore
