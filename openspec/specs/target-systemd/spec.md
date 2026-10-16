# Target Systemd Specification

## Purpose

按 systemd 目标在目标机上起服务：把结构化配置渲染成 service unit，校验后原子替换生效单元，再重载并断言服务活跃。

## Requirements

### Requirement: unit 文件名必须落在 unit 目录之内

系统 MUST 拒绝含路径分隔符的 unit 名，MUST 只接受 `.service` 结尾的文件名。

#### Scenario: unit 名带路径分隔符

- **WHEN** unit 名含 `/` 或 `\`、或本身是 `.` / `..`
- **THEN** 报错说明它会被拼到 unit 目录之后，带分隔符就能写到目录之外

#### Scenario: unit 名不是 service unit

- **WHEN** unit 名不以 `.service` 结尾
- **THEN** 报错说明本目标只管 service unit，timer / socket / path 各有自己的生命周期语义

#### Scenario: 省略 unit 名

- **WHEN** 配置未给出 unit 名
- **THEN** 按项目名推导出 `<项目名>.service`；渲染上下文里没有项目名时报错而不是编一个名字

### Requirement: unit 的值在渲染期拒绝控制字符

系统 SHALL 在渲染期拒绝含控制字符的值，MUST NOT 把可能多出指令的内容写进 unit。

#### Scenario: 值里含换行

- **WHEN** 任一配置值渲染后含换行或其它控制字符
- **THEN** 报错指向具体配置项，并说明那等于凭空多出几条 unit 指令

#### Scenario: 逃生舱里的一行含换行

- **WHEN** 逐行原样输出的附加行里含控制字符
- **THEN** 报错说明那不是逃生舱而是指令注入口

### Requirement: unit 目录由上层注入且必须是可信绝对路径

系统 SHALL 只接受以 `/` 开头且不含父目录段的 unit 目录，MUST NOT 自己探测或用相对路径凑一个。

#### Scenario: 给了相对路径或含父目录段

- **WHEN** unit 目录不是可信的目标机绝对路径
- **THEN** 报错说明它由上层从布局推导后注入，不是随手填的相对路径

### Requirement: 安装阶段只碰影子目录

系统 SHALL 把候选 unit 写在版本目录下的影子目录里做校验，MUST NOT 在安装阶段改动生效的 unit。

#### Scenario: 影子目录的落点

- **WHEN** 安装阶段需要放候选文件
- **THEN** 放在版本目录下而不是 unit 目录之下（unit 目录会被递归扫描，同名的候选会与生效单元冲突）

#### Scenario: 候选过不了校验

- **WHEN** 候选 unit 通不过校验命令
- **THEN** 报错并带上原话，生效 unit 保持未被改动

### Requirement: 覆盖生效 unit 前先确认归属

系统 SHALL 在覆盖前判断现存 unit 是否由本工具管理，MUST NOT 静默覆盖别人的文件。

#### Scenario: 现存 unit 不带管理标记

- **WHEN** 目标 unit 存在且不带管理标记，也没有显式强制覆盖
- **THEN** 报错给出保住该文件的几种办法，且不建立影子目录

#### Scenario: 显式强制覆盖

- **WHEN** 显式要求强制覆盖不带标记的文件
- **THEN** 仍然先备份再覆盖，并说明备份落在哪

#### Scenario: 目标 unit 不存在

- **WHEN** 目标 unit 不存在
- **THEN** 判定为新建，不做备份

### Requirement: 生效顺序固定为备份、原子替换、重载、重启

系统 SHALL 按备份、写中间文件后改名、重载守护进程、重启单元的顺序生效，MUST NOT 直接写目标文件。

#### Scenario: 替换生效单元

- **WHEN** 写新的 unit 文件
- **THEN** 先写同目录的中间文件再改名，避免进程读到写了一半的文件

#### Scenario: 重载失败

- **WHEN** 重载守护进程失败
- **THEN** 报错说明 unit 已在盘上但尚未被读到，**不**回滚 unit，并指出备份仍在

#### Scenario: 重启失败

- **WHEN** 重启单元失败
- **THEN** 报错说明 unit 已生效只是服务没起来，**不**退回旧 unit，并提示排查服务自身

### Requirement: 验证只回答活跃与否

系统 SHALL 用只回答单元是否活跃的查询做断言，MUST NOT 用会混入大量无关状态行的命令判定。

#### Scenario: 单元不是活跃状态

- **WHEN** 断言时单元不是 active
- **THEN** 报错带上实际状态，并区分单元未找到、启动后又退出、仍在启动中几种情况

### Requirement: 回滚还原上一份 unit

系统 SHALL 让回滚还原上一次备份的 unit 并重新重载与校验，MUST NOT 用当前配置重新渲染一份来充当回滚。

#### Scenario: 没有备份可还原

- **WHEN** 请求回滚但备份不存在
- **THEN** 报错说明首次部署没有可还原对象，**不**返回回滚成功

#### Scenario: 还原后服务不活跃

- **WHEN** 还原并重启后单元仍不是 active
- **THEN** 报错说明回滚动作已完成但上一版本身不可用，由调用方决定是否继续回退

### Requirement: 缺少计划步骤即失败

执行器 SHALL 在执行前核对计划里的步骤是否都被覆盖，MUST NOT 跳过未实现的步骤继续。

#### Scenario: 执行器漏掉某个计划步骤

- **WHEN** 计划里某一步在执行器中没有对应实现
- **THEN** 报错列出漏掉的步骤，不产生部分生效的结果

### Requirement: 干跑不留残留

系统 SHALL 保证干跑结束后目标机上没有本次留下的文件与目录，MUST NOT 把「跑过判定」记成「已生效」。

#### Scenario: 干跑安装

- **WHEN** 以干跑方式执行安装
- **THEN** 只读校验照常执行（它给的结论是真的），写入的候选随后被撤销，该步骤记为未生效

#### Scenario: 建目录时顺带建出的父目录

- **WHEN** 干跑过程中为影子目录递归创建了尚不存在的父级目录
- **THEN** 这些父级目录一并被移除，不留下空目录（目录在而索引不在，会让「这台机器部署过吗」多一层噪音）
