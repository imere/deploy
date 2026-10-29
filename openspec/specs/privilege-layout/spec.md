# Privilege Layout Specification

## Purpose

按目标机实测到的能力推导能用的目录布局与提权方式。不假设拥有最高权限。

## Requirements

### Requirement: 布局由实测能力推导

系统 SHALL 依据实测到的能力决定使用哪种目录布局，MUST NOT 依据用户名或 uid 推断。

#### Scenario: 能写系统级目录

- **WHEN** 实测表明可写入系统级目录
- **THEN** 采用系统级布局

#### Scenario: 只能写用户目录

- **WHEN** 实测表明只能写入用户可写范围
- **THEN** 采用用户级布局，并如实说明限制

### Requirement: 写不进就是写不进

某处实测不可写时，系统 MUST 如实报告，MUST NOT 试图绕过权限限制。

#### Scenario: 系统配置目录不可写

- **WHEN** 目标机的系统配置目录实测不可写
- **THEN** 报出不可写并给出可选路径，不尝试提权硬写

#### Scenario: 低端口绑定失败

- **WHEN** 尝试绑定特权端口而能力不允许
- **THEN** 报出该限制，不假装绑定成功

### Requirement: 发布目录按候选顺序推导

系统 SHALL 按固定候选顺序推导发布根目录，取第一个实测可写的候选。

#### Scenario: 第一个候选可写

- **WHEN** 候选序列中第一个位置实测可写
- **THEN** 采用它作为发布根

#### Scenario: 前几个候选都不可写

- **WHEN** 靠前的候选实测不可写
- **THEN** 依次尝试后续候选，采用第一个可写的

#### Scenario: 全部候选都不可写

- **WHEN** 所有候选实测都不可写
- **THEN** 报错并逐个说明原因，不静默挑一个硬写

### Requirement: 代码与数据分离

各布局下系统 SHALL 把版本内容与运行时数据分开存放。

#### Scenario: 写入运行时数据

- **WHEN** 部署过程中需要写日志或状态
- **THEN** 它们落在与版本目录分离的位置

### Requirement: 跨平台路径差异被显式处理

系统 SHALL 识别并拒绝那些在目标平台上不合法的路径，且这类校验不需要连接目标机即可完成。

#### Scenario: 路径含目标平台非法字符

- **WHEN** 配的路径含有目标平台不允许的字符
- **THEN** 在规划阶段就报错，不带着它去执行

#### Scenario: 路径含盘符或平台特有前缀

- **WHEN** 配的路径带了平台特有的前缀形式
- **THEN** 按目标平台语义校验，报错时说明是哪一条不合法

#### Scenario: 尾随分隔符

- **WHEN** 路径以分隔符结尾
- **THEN** 拼接结果不产生重复分隔符

### Requirement: 提权方式靠实测而非角色名

系统 SHALL 通过实测确定可用的提权方式，MUST NOT 因为用户名为特定值就假定可以提权。

#### Scenario: 免密提权可用

- **WHEN** 实测表明可免密提权
- **THEN** 采用该方式

#### Scenario: 免密提权不可用

- **WHEN** 实测表明提权需要交互输入
- **THEN** 报出该情况并终止，不发起会等待输入的调用

### Requirement: LSM 驱动按实测选择

系统 SHALL 通过 `@dp/lsm` 以 `selinux` / `apparmor` / `none` 三种驱动对接目标机的安全模块，驱动由实测而非平台推断选择。

#### Scenario: 目标机无 LSM

- **WHEN** 目标机实测没有启用任何 LSM
- **THEN** 以 none 驱动工作，不做任何 LSM 修补动作

#### Scenario: SELinux 上下文不对

- **WHEN** 目标机启用 SELinux 且文件上下文不匹配，导致服务（如 nginx）读不了文件
- **THEN** 处置是 `restorecon -R` 修上下文；chmod 0777 不是解法，MUST NOT 用放宽权限冒充修复

#### Scenario: SELinux 非标端口

- **WHEN** 服务要监听 SELinux 未放行的端口
- **THEN** 处置是 `semanage port -a -t http_port_t -p tcp <端口>`；反代出网场景用 `setsebool -P httpd_can_network_connect 1`

#### Scenario: 预检与建议

- **WHEN** 目标机疑似启用 SELinux
- **THEN** 预检执行 `getenforce`、`ls -Z`、`semanage port -l`；`semanage` 缺失时报错附上安装建议

### Requirement: 安全加固基线固定

系统 SHALL 执行以下基线：路径归一化加 allowlist 校验；显式设置 mode（文件 `0640`、目录 `0750`，拒绝 `0777` / `0666`）；临时目录 `0700`；传输完成后做 sha256 校验；主机密钥默认 `strict`，`knownHosts: none` 须显式打开并被 `dp check --security` 列出；凭据不进日志（`SSH_ASKPASS` 助手文件 `0700`、用完即删）。

#### Scenario: 配置请求宽松权限

- **WHEN** 配置把文件或目录权限写成 `0777` / `0666`
- **THEN** 校验拒绝，说明基线不允许

#### Scenario: 关闭主机密钥校验

- **WHEN** 用户显式设置 `knownHosts: none`
- **THEN** 该选择生效，但 `dp check --security` 会把它列为风险项

#### Scenario: 凭据助手用完即删

- **WHEN** 一次需要口令的执行结束
- **THEN** `SSH_ASKPASS` 助手文件被删除，不留含凭据的文件

### Requirement: 校验与写入之间不重新解析路径

系统 SHALL 防 TOCTOU：先 `open` 拿到 fd 再对 fd 校验，MUST NOT 在校验与写入之间重新解析路径。

#### Scenario: 路径在校验后被替换

- **WHEN** 校验通过后、写入前，该路径被符号链接指向别处
- **THEN** 写入仍落在已校验的 fd 上，不被引到别处

### Requirement: 目录链逐级校验属主

系统 SHALL 从根逐级校验 owner 与可写性，判定基准是「owner == 布局推导的所有者」而非 root；预检 MUST 覆盖带外脚本所在的代码域（`DP.SEC.RESCUE_UNSAFE_PATH`）与状态目录（伪造租约锁属于可用性攻击）。

#### Scenario: 状态目录被他人可写

- **WHEN** 预检发现状态目录对布局所有者以外的账号可写
- **THEN** 报错拦下部署——那意味着租约锁可被伪造

#### Scenario: 带外脚本落在危险位置

- **WHEN** 带外脚本所在目录不满足代码域要求
- **THEN** 报 `DP.SEC.RESCUE_UNSAFE_PATH`，不执行该脚本

### Requirement: 被提权执行的代码与可变数据分离且永不 eval

系统 SHALL 保证被 root 定时或提权执行的代码与可变数据不同目录；状态值只作为参数传入并经 allowlist 校验，MUST NOT 进 eval 或等价构造。

#### Scenario: 状态值混进命令串

- **WHEN** 某处想把状态文件里的值拼进待执行字符串
- **THEN** 被拒绝：值只能作为参数传递并过 allowlist
