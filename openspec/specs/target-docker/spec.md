# Target Docker Specification

## Purpose

按 docker compose 目标在目标机上起服务：校验配置、拉取镜像、启动并断言服务状态。

## Requirements

### Requirement: 只支持把 compose 文件随版本上传这一种模式

系统 SHALL 只按「compose 文件随版本目录上传、远端执行 compose 命令」这一种模式工作，MUST NOT 把其它模式静默按此模式处理。

#### Scenario: 配置了尚未实现的模式

- **WHEN** 配置里的模式不是受支持的那种
- **THEN** 报错说明该模式尚未实现，并列出已支持的模式

### Requirement: 项目名在计划期就校验

系统 SHALL 在计划期校验 compose 项目名，MUST NOT 把它交给 compose 去报一个不含配置项位置的错误。

#### Scenario: 项目名为空

- **WHEN** 渲染后的项目名为空串
- **THEN** 报错指出它是容器名与网络名的前缀，不能为空

#### Scenario: 项目名以连字符开头

- **WHEN** 项目名以连字符开头
- **THEN** 报错说明它会被当作选项解析，并给出改法

#### Scenario: 项目名含非法字符

- **WHEN** 项目名含字符集之外的字符
- **THEN** 报错指出具体是哪一个字符不合法，并说明允许的字符集

### Requirement: compose 文件路径必须是版本目录内的相对路径

系统 MUST 拒绝绝对路径、含父目录逃逸段、含反斜杠或含空路径段的 compose 文件路径。

#### Scenario: 给了绝对路径

- **WHEN** 路径是绝对路径或带盘符
- **THEN** 报错说明 compose 文件随版本上传，路径必须相对版本目录

#### Scenario: 路径逃出版本目录

- **WHEN** 路径含有父目录段
- **THEN** 报错说明它必须落在版本目录之内

#### Scenario: 路径含反斜杠或空段

- **WHEN** 路径含反斜杠或出现连续分隔符
- **THEN** 报错指出具体形态并给出改法

### Requirement: 安装阶段只核对不搬运

系统 SHALL 在安装阶段只核对所需文件是否已随版本上传，MUST NOT 自己再搬一次文件。

#### Scenario: 所需文件缺失

- **WHEN** 执行前核对发现某个 compose 文件不在
- **THEN** 报错指出该文件缺失，不进入启动阶段

#### Scenario: 配置了环境变量文件

- **WHEN** 配置指定了环境变量文件
- **THEN** 安装阶段额外核对它存在，且报错指向该文件未上传而不是 compose 写法

### Requirement: 拉取镜像可以关闭

系统 SHALL 允许关闭拉取镜像这一步，并在计划里体现它是否被跳过。

#### Scenario: 关闭拉取

- **WHEN** 配置关闭拉取
- **THEN** 计划里没有拉取步骤，直接进入启动

### Requirement: 启动是否等待就绪可配置且代价要说清

系统 SHALL 让等待就绪成为可配置项，并在关闭它时说明验收只剩后续断言一道。

#### Scenario: 关闭等待

- **WHEN** 配置关闭等待就绪
- **THEN** 启动步骤的说明里写明本次不等待就绪

### Requirement: 状态断言基于编排级视图

系统 SHALL 以编排级的状态查询判断服务是否就绪，MUST NOT 用整机容器列表代替。

#### Scenario: 查询服务状态

- **WHEN** 验证阶段需要判断服务状态
- **THEN** 查询的是本项目编排范围内的服务状态

#### Scenario: 期望状态包含健康

- **WHEN** 期望状态里包含健康
- **THEN** 额外对每个受关注服务做一次状态断言

#### Scenario: 只关注部分服务

- **WHEN** 配置指定了关注的服务子集
- **THEN** 断言只覆盖这些服务

### Requirement: 回滚按上一版的编排文件重新起服务

系统 SHALL 让本目标的回滚使用上一版版本目录里的编排文件重新启动，MUST NOT 用当前版本再起一次。

#### Scenario: 没有上一版

- **WHEN** 请求回滚但没有上一版编排文件
- **THEN** 报错说明首次部署无可回退对象，不返回回滚成功，也不自动停止服务

#### Scenario: 回滚后复验

- **WHEN** 按上一版编排文件重新启动完成
- **THEN** 紧接着对该状态做一次复验
