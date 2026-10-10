# Transport Specification

## Purpose

选择并执行把产物从源搬到目标机的方式。能力一律实证，不按平台猜。

## Requirements

### Requirement: 只在实测到工具能力时才认为该方式可用

系统 SHALL 仅依据两端实测到的工具能力判定某种传输方式是否成立，MUST NOT 依据操作系统、平台或版本号推断。

#### Scenario: 两端都有 rsync

- **WHEN** 本地与目标机都实测到 rsync
- **THEN** 协商结果为 rsync-ssh，理由写明「两端都检测到 rsync」

#### Scenario: 只有一端有 rsync

- **WHEN** 只有一端实测到 rsync，而两端都有 tar
- **THEN** 协商结果为 tar-ssh，且理由里指出**具体是哪一端**缺 rsync

#### Scenario: 平台上有但该工具没装

- **WHEN** 某端虽然运行在常见支持该工具的平台上，但实测未发现该工具
- **THEN** 该方式判为不可用，不因平台而放宽

### Requirement: 被拒的每一项都要给出原因

系统 SHALL 为每种被判定不可用的传输方式各给出一条原因，而不是只给最终结论。

#### Scenario: 询问为何没走 rsync

- **WHEN** 协商结果不是 rsync-ssh
- **THEN** 结果里能查到 rsync-ssh 这一项及其被拒原因，且原因指明缺的是哪一端

#### Scenario: 原因要能指导动手

- **WHEN** 某种方式因缺工具被拒
- **THEN** 原因文本区分「本地缺」与「目标机缺」

### Requirement: 降级要留痕

系统 SHALL 在选择非首选方式时给出可见的说明，说明为什么没用成本更低的那种。

#### Scenario: 退到全量打包

- **WHEN** 因缺 rsync 而退到打包传输
- **THEN** 结果里带一条说明，指出这次是全量传输以及退下来的原因

### Requirement: 显式指定不可用时报错而非静默替换

用户显式指定某种传输方式而它不可用时，系统 MUST 报错并终止，MUST NOT 静默换成别的方式。

#### Scenario: 点名 rsync 但没装

- **WHEN** 配置显式指定 rsync-ssh，而实测能力不支持
- **THEN** 在装配期报错退出，不启动任何传输，错误里逐项列出原因

#### Scenario: 未指定时的缺省链

- **WHEN** 用户没有显式指定传输方式
- **THEN** 按成本序依次尝试：rsync-ssh → tar-ssh → sftp → scp

### Requirement: 本地目标不经过传输层

源与目标是同一台机器时，系统 SHALL 直接写文件，MUST NOT 走跨机传输。

#### Scenario: 目标是本地主机

- **WHEN** 目标主机是本地
- **THEN** 传输层一次都不被调用，文件逐条写入

### Requirement: 命令一律以 argv 传递

系统 MUST 以参数数组形式构造所有远端命令，MUST NOT 拼接成字符串交给 shell 执行。

#### Scenario: 路径含空格

- **WHEN** 远端路径或参数含空格
- **THEN** 它作为一个完整参数传递，不被拆成多个

#### Scenario: 命令分隔符出现在参数里

- **WHEN** 参数内容含有命令分隔符或 shell 元字符
- **THEN** 它被中和为普通字符，不改变命令结构

### Requirement: 需要交互的提权在传输层被拒绝

传输过程中若某一步需要交互式输入口令，系统 MUST 明确拒绝并报错，MUST NOT 发起会等待输入的调用。

#### Scenario: 提权需要密码

- **WHEN** 某个传输步骤的提权需要 stdin 或 pty 输入密码
- **THEN** 该次传输被拒绝并报错，不发起可能挂起的调用

### Requirement: 传输失败保留原始失败原因

传输步骤失败时，系统 SHALL 保留并上报底层工具给出的原始失败原因，MUST NOT 用笼统的「传输失败」覆盖它。

#### Scenario: rsync 以非零码退出

- **WHEN** 底层 rsync 以非零退出码结束
- **THEN** 上报的错误里带有该退出码对应的具体原因分类，而不是只说传输未成功

#### Scenario: 通道建立失败

- **WHEN** 在建立连接阶段就失败
- **THEN** 错误标识出失败发生在连接阶段，不被归并成执行阶段失败
