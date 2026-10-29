# Ssh Runner Specification

## Purpose

在远端目标上执行命令与传输文件时的连接方式、主机密钥策略与能力探测。

## Requirements

### Requirement: 驱动按偏好链选择

系统 SHALL 按固定偏好链选择可用的连接驱动，前一个不可用时才用后一个。

#### Scenario: 首选驱动可用

- **WHEN** 偏好链中第一个驱动可用
- **THEN** 使用它建立连接

#### Scenario: 首选驱动不可用

- **WHEN** 第一个驱动不可用而第二个可用
- **THEN** 自动改用第二个，并在结果里说明降级

#### Scenario: 全部不可用

- **WHEN** 所有驱动都不可用
- **THEN** 报错并说明如何装上所需依赖，而不是崩溃

#### Scenario: 降级时说明能力差异

- **WHEN** 连接降级到备选驱动
- **THEN** 明确告知该连接不具备首选驱动才有的安全特性

### Requirement: 主机密钥策略有四种且默认严格

系统 SHALL 提供严格、接受新密钥、首次信任并记住、完全关闭四种策略，默认取严格。

#### Scenario: 严格模式遇到未知主机

- **WHEN** 主机密钥策略为严格且遇到未在已知列表中的主机
- **THEN** 拒绝连接

#### Scenario: 接受新密钥

- **WHEN** 策略为接受新密钥且主机未知
- **THEN** 接受该密钥并写入已知列表

#### Scenario: 首次信任并记住

- **WHEN** 策略为首次信任并记住
- **THEN** 密钥写入独立的锁定文件，不污染系统级的已知主机列表

#### Scenario: 完全关闭

- **WHEN** 策略为完全关闭
- **THEN** 不做主机密钥校验，且不使用已知主机列表

### Requirement: 连接永不等待交互输入

系统 MUST 构造不会请求交互输入的连接参数，MUST NOT 发起可能等待口令的调用。

#### Scenario: 密钥认证

- **WHEN** 使用私钥或代理认证
- **THEN** 连接参数显式关闭密码提示与交互

#### Scenario: 需要口令

- **WHEN** 认证需要口令
- **THEN** 通过受控通道提供，不打开终端提示

#### Scenario: 命令执行

- **WHEN** 在远端执行一条命令
- **THEN** 不申请伪终端，也不转发认证代理

### Requirement: 端口即使等于默认值也显式写出

系统 SHALL 在构造连接参数时显式写出端口，即使它等于协议默认值。

#### Scenario: 端口为默认值

- **WHEN** 目标端口等于协议默认端口
- **THEN** 参数里仍然显式带上端口

### Requirement: 多跳链逐跳可配且冲突时报错

系统 SHALL 支持逐跳配置，且逐跳设置与整体设置冲突时报错。

#### Scenario: 配置多跳链

- **WHEN** 配置了跳板链
- **THEN** 最后一跳为目标机，中间各跳按序连接

#### Scenario: 逐跳主机密钥策略与整体冲突

- **WHEN** 某一跳的主机密钥策略与整体策略不能共存
- **THEN** 报错说明冲突，不静默取其一

#### Scenario: 单跳

- **WHEN** 只配置了一跳
- **THEN** 不产生跳板链参数，行为与不带跳板时一致

### Requirement: 能力靠实测而非推断

系统 MUST 通过实际探测获得目标机的能力与工具路径，MUST NOT 依据版本号或平台推断。

#### Scenario: 探测工具是否存在

- **WHEN** 需要知道某个远端工具是否可用
- **THEN** 实际执行探测命令并根据结果判定

#### Scenario: 探测目录是否可写

- **WHEN** 需要知道某处是否可写
- **THEN** 实际尝试创建并清理，据结果判定

### Requirement: 清理失败不推翻已有判定

探测过程中创建临时物后又清理失败时，系统 SHALL 保留已得到的判定并上报残留。

#### Scenario: 创建成功但清理失败

- **WHEN** 探测用的临时文件创建成功而清理失败
- **THEN** 该位置仍判定为可写，同时上报残留路径

### Requirement: 远端输出有上限

系统 SHALL 对远端命令返回的输出设上限，超出则截断并标注。

#### Scenario: 输出超长

- **WHEN** 远端命令输出超过上限
- **THEN** 返回截断后的内容并标注已截断

### Requirement: 连接失败给出可执行的原因

连接失败时，系统 SHALL 把失败归类并给出对应的处理建议。

#### Scenario: 认证失败

- **WHEN** 连接因认证问题失败
- **THEN** 错误里说明是哪一类认证问题及下一步该做什么

#### Scenario: 主机密钥不匹配

- **WHEN** 主机密钥与已记录的不一致
- **THEN** 错误里说明可能的原因，而不是笼统的连接失败

### Requirement: 支持 ssh_config 的受控子集

系统 SHALL 由 `@dp/ssh-config` 解析 `~/.ssh/config`（含 `Include`），按以下映射落进内部配置：`Host` / `HostName` / `Port` / `User` 直映射；`IdentityFile` → privateKey；`ProxyJump` → jump 链；`ProxyCommand` 形如 `ssh -W` / `nc` 的转内部实现，否则报错；`StrictHostKeyChecking` / `UserKnownHostsFile` → 主机密钥策略；`KexAlgorithms` / `Ciphers` → cryptoPolicy。

#### Scenario: 配置文件里有 Include

- **WHEN** `~/.ssh/config` 含 `Include` 指令
- **THEN** 被包含的文件按序解析合并

#### Scenario: ProxyCommand 写了无法内化的命令

- **WHEN** `ProxyCommand` 不是 `ssh -W` / `nc` 这类可内化的形态
- **THEN** 报错说明不支持该写法，不静默忽略

### Requirement: ssh_config 只在 native-ssh 透传

ssh_config 的解析结果 SHALL 只在 native-ssh 驱动下透传；ssh2 驱动下遇到其不支持的指令时 MUST 报错，MUST NOT 静默丢弃。

#### Scenario: ssh2 遇到不支持的指令

- **WHEN** 解析出的 ssh_config 指令在 ssh2 驱动下没有对应实现
- **THEN** 报错列出该指令，用户可改配置或换驱动
