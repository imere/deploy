# Config Schema Specification

## Purpose

配置怎么被校验、不合法时报什么，以及怎么导出给编辑器用的 JSON Schema。

## Requirements

### Requirement: 校验失败要带出配置路径

系统 MUST 在每条校验错误里给出出错字段的完整配置路径。

#### Scenario: 深层字段类型不对

- **WHEN** 某个嵌套字段写成了别的类型
- **THEN** 错误里带有形如 `projects.web.source.root` 的完整路径

#### Scenario: 数组元素出错

- **WHEN** 出错的是数组里的某一项
- **THEN** 路径里带该项下标，能定位到具体那一项

### Requirement: 错误要说明实际是什么类型

系统 SHALL 在错误里说明期望类型与实际拿到的类型，而不是只说「不合法」。

#### Scenario: 字符串写进数字字段

- **WHEN** 数字字段收到带引号的数字
- **THEN** 错误说明期望数字、实际是字符串

#### Scenario: 对象写进数组字段

- **WHEN** 数组字段收到一个对象
- **THEN** 错误说明期望数组、实际是对象，不因对象有下标而当成数组

### Requirement: 可选值在错误里给出

枚举字段校验失败时，系统 SHALL 在错误里列出全部可选值。

#### Scenario: 枚举值不在白名单

- **WHEN** 枚举字段收到白名单之外的值
- **THEN** 错误里带有全部可选值

#### Scenario: 枚举判定严格相等

- **WHEN** 枚举字段收到的值与某个可选值只差尾部空格或大小写
- **THEN** 判定为不合法，不做 trim 或大小写折叠

### Requirement: 不做隐式类型转换

系统 MUST NOT 把字符串转成数字、把真假值字符串转成布尔。

#### Scenario: 带引号的数字

- **WHEN** 数字字段收到 `'8080'`
- **THEN** 判定为不合法，不转成数字 8080

#### Scenario: 布尔字符串

- **WHEN** 布尔字段收到 `'false'`
- **THEN** 判定为不合法，不按真假值转换成 false

### Requirement: 数字必须是有限数

数字字段 MUST 拒绝非有限数。

#### Scenario: 收到 NaN

- **WHEN** 数字字段收到 NaN
- **THEN** 判定为不合法

#### Scenario: 收到 Infinity

- **WHEN** 数字字段收到 Infinity
- **THEN** 判定为不合法

### Requirement: 对象与映射拒绝 null

对象类字段 MUST 拒绝 null，不把它当成空对象。

#### Scenario: 对象字段收到 null

- **WHEN** 对象字段收到 null
- **THEN** 判定为不合法

#### Scenario: 映射字段收到 null

- **WHEN** 键值对映射字段收到 null
- **THEN** 判定为不合法

#### Scenario: 数组不能被当成对象

- **WHEN** 对象字段收到一个数组
- **THEN** 判定为不合法

### Requirement: 偏好链接受单值或列表两种写法

传输方式这类偏好字段 SHALL 同时接受单个值与有序列表两种写法，并统一成列表。

#### Scenario: 写成单个值

- **WHEN** 偏好字段写成单个字符串
- **THEN** 解析为只含一项的列表

#### Scenario: 写成有序列表

- **WHEN** 偏好字段写成列表
- **THEN** 解析结果保持该顺序

#### Scenario: 链内出现不支持的项

- **WHEN** 列表里有不在支持范围内的项
- **THEN** 报错，且路径指出是第几项

#### Scenario: 缺省链不参与校验

- **WHEN** 该字段取缺省值
- **THEN** 不因缺省值未显式写出而报错

### Requirement: 配置里只接受真会生效的字段

系统 SHALL 拒绝没有任何实现消费的配置项，MUST NOT 接受后静默忽略它。

#### Scenario: 点名了没有可执行实现的类型

- **WHEN** 显式指定了某种目标类型，而该类型没有对应的执行实现
- **THEN** 校验期报错并列出可指定的类型，不按其它类型部署

#### Scenario: 类型与它自己的配置段不一致

- **WHEN** 点名的类型没有对应的配置段，或配置段与点名的类型对不上
- **THEN** 校验期报错，指出两者必须一致，不静默按另一种类型执行

### Requirement: 能导出 JSON Schema

系统 SHALL 导出完整配置的 JSON Schema，供编辑器做补全与校验。

#### Scenario: 导出

- **WHEN** 运行 schema 导出命令
- **THEN** 输出一份可被编辑器直接引用的 JSON Schema

#### Scenario: 枚举与错误提示同源

- **WHEN** 某字段是枚举
- **THEN** 导出的 Schema 里该字段的可选值与校验错误里给出的可选值一致

### Requirement: 同一配置多处来源的优先级固定

配置可来自多个来源时，系统 SHALL 按固定优先级合并，且优先级可被查证。

#### Scenario: 同名配置出现在多处

- **WHEN** 同一项在多个来源里都有值
- **THEN** 按既定优先级取其一，结果可预测
