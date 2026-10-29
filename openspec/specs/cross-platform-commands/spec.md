# Cross Platform Commands Specification

## Purpose

跨平台命令的生成方式：常见操作以抽象动作表达、按目标平台翻译，引号按目标 shell 生成，并允许用户按平台覆盖。

## Requirements

### Requirement: 常见操作以抽象动作表达

系统 SHALL 用动作名（`ensureDir`、`setMode`、`setOwner`、`symlink`、`remove`、`serviceReload`、`configTest`）表示常见操作，由平台映射表翻译成具体命令，MUST NOT 在计划里直写平台专有命令。

#### Scenario: 同一计划跑在不同平台

- **WHEN** 一份含抽象动作的计划分别落到 linux 与 darwin 目标机
- **THEN** 各自按平台映射表翻译，动作语义一致

#### Scenario: 某动作在目标平台无对应实现

- **WHEN** 平台映射表里某动作没有该平台的条目
- **THEN** 报错说明缺哪条映射，不静默跳过

### Requirement: 引号按目标 shell 生成

远端 shell 可能是 `sh` / `bash` / `zsh` / `powershell` / `cmd`，系统 SHALL 按目标 shell 生成引号与转义，MUST NOT 手工拼命令字符串（安全相关）。

#### Scenario: 参数含目标 shell 的元字符

- **WHEN** 参数值含目标 shell 的引号或元字符
- **THEN** 按该 shell 的规则转义后传递，不改变命令结构

#### Scenario: 目标 shell 类型未知

- **WHEN** 探测不出目标机使用的 shell
- **THEN** 按保守默认生成引号并留痕，不猜一个宽松方言

### Requirement: 用户可按平台覆盖命令

系统 SHALL 支持 `commands.overrides.perPlatform: { linux, darwin, win32 }`，并可按 `osFamily` / `distro` 进一步细化；覆盖命中时以覆盖为准。

#### Scenario: 按 distro 细化覆盖

- **WHEN** 目标机 distro 命中了更细一层的覆盖条目
- **THEN** 采用最细那层的覆盖，而非平台默认映射

#### Scenario: 覆盖内容不合法

- **WHEN** 用户覆盖写出的命令不是合法 argv
- **THEN** 校验期报错，不带着坏命令去执行
