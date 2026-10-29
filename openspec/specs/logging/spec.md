# Logging Specification

## Purpose

结构化日志的输出格式、脱敏规则与字段约定。日志是给人排障和给采集端消费的。

## Requirements

### Requirement: 日志是结构化的

系统 SHALL 以结构化格式输出日志，而不是自由文本。

#### Scenario: 输出一条日志

- **WHEN** 记录一条日志
- **THEN** 输出可被机器解析，字段与值一一对应

#### Scenario: 支持多种序列化格式

- **WHEN** 指定输出格式
- **THEN** 按指定格式序列化；未指定时使用默认格式

### Requirement: 出口统一脱敏

系统 MUST 在日志出口处对疑似凭据的内容做脱敏，MUST NOT 让它们原样落到输出里。

#### Scenario: 键名命中敏感词

- **WHEN** 某个字段的键名包含敏感词片段
- **THEN** 该字段的值被替换为占位符

#### Scenario: 值本身命中敏感模式

- **WHEN** 某个字符串值匹配已知的凭据模式
- **THEN** 该值被替换为占位符，即使键名不含敏感词

#### Scenario: 嵌套结构里的敏感字段

- **WHEN** 敏感字段位于嵌套对象深处
- **THEN** 同样被脱敏

### Requirement: 日志级别可过滤

系统 SHALL 支持按级别过滤日志。

#### Scenario: 设定级别阈值

- **WHEN** 设定了某个级别
- **THEN** 低于该级别的记录不输出

### Requirement: 字段命名对齐通用可观测性约定

系统 SHALL 使用与通用可观测性约定一致的固定字段名，便于采集端直接识别。

#### Scenario: 固定字段

- **WHEN** 输出一条日志
- **THEN** 时间戳、级别、消息等使用约定的固定字段名

### Requirement: 超长内容被截断而不是无限输出

系统 SHALL 对超长字符串与超长数组做截断，并标注发生了截断。

#### Scenario: 超长字符串

- **WHEN** 某个字段的值超过长度上限
- **THEN** 值被截断并带截断标记

#### Scenario: 超长数组

- **WHEN** 某个数组字段元素数超过上限
- **THEN** 只输出前若干个并标注被截断

### Requirement: 日志不引入运行时依赖

日志模块 MUST 在零第三方运行时依赖下工作。

#### Scenario: 独立使用

- **WHEN** 在没有安装任何额外依赖的环境里使用日志
- **THEN** 日志功能完整可用

### Requirement: 日志与命令的结构化输出分流

系统 SHALL 把日志写到与命令结构化结果不同的输出流，避免互相污染。

#### Scenario: 命令以结构化模式运行

- **WHEN** 命令以结构化输出模式运行
- **THEN** 日志不出现在承载结构化结果的那条输出流上

### Requirement: 默认输出是 JSONL 且字段固定

系统 SHALL 以 JSONL（每行一个 JSON 对象）输出日志，字段名固定为 `ts` / `level` / `msg` / `deployId` / `host` / `phase` / `span` / `attempt`。核心不依赖 OTel 包，字段对齐其约定；与 OTel 的桥接交给 `@dp/log-otel`，MUST NOT 把重依赖引进日志核心。

#### Scenario: 采集端逐行消费

- **WHEN** 采集端逐行读取日志流
- **THEN** 每行都是独立可解析的 JSON 对象，含上述固定字段

#### Scenario: 桥接 OTel

- **WHEN** 需要把日志送进 OTel 生态
- **THEN** 由 `@dp/log-otel` 做桥接，核心包不新增依赖

### Requirement: 日志参数可从命令行控制

系统 SHALL 支持 `--log-format=json|pretty|logfmt`、`--log-level` 与 `--log-file`，分别控制序列化格式、级别阈值与落盘位置。

#### Scenario: 指定落盘

- **WHEN** 运行时给定 `--log-file <路径>`
- **THEN** 日志写入该文件，仍遵守格式与级别设置
