# Source Selection Specification

## Purpose

把用户配置的源目录展开成一份确定的待传文件清单，并在展开阶段暴露源本身的问题。

## Requirements

### Requirement: 源根目录写法非法即报错

系统 MUST 拒绝空串与以路径分隔符结尾的源根目录写法，MUST NOT 在后续阶段才暴露。

#### Scenario: 源根是空串

- **WHEN** 配置里的源根是空串
- **THEN** 报错指出源不能为空，并定位到该配置项

#### Scenario: 源根以分隔符结尾

- **WHEN** 源根以路径分隔符结尾
- **THEN** 报错指出该写法不合法

### Requirement: 源不存在即报错

系统 MUST 在源根不存在或不可读时报错，MUST NOT 当成空源继续。

#### Scenario: 目录不存在

- **WHEN** 源根指向的路径不存在
- **THEN** 报错指出源不存在并给出路径

### Requirement: 失效软链要报出来

系统 MUST 在遇到指向失效目标的软链时报错，MUST NOT 把它当成空目录跳过。

#### Scenario: 源里有坏链

- **WHEN** 展开过程中遇到软链且它指向的目标不存在
- **THEN** 报错指出该软链失效并给出路径

### Requirement: 清单条目是相对路径

系统 SHALL 让展开结果里的每个条目保持相对源根的路径形态，MUST NOT 带上源根的绝对前缀。

#### Scenario: 展开后的条目

- **WHEN** 源展开完成
- **THEN** 每个条目以相对路径给出，供后续的路径校验与传输使用

### Requirement: 过滤规则可以把源排空

系统 SHALL 按包含与排除规则过滤条目，并在过滤结果为空时明确报错而不是部署空内容。

#### Scenario: 规则排除了全部文件

- **WHEN** 过滤之后没有任何条目
- **THEN** 报错指出源为空，并说明可能是构建产物为空或被规则排除

### Requirement: 源根写法歧义靠拒绝而非默认值

系统 SHALL 按下表解释源根写法，歧义写法 MUST 报 `DP.SOURCE.AMBIGUOUS` 并给出两种合法写法的预览差异，MUST NOT 替用户猜一个（rsync 的 `src` 与 `src/` 是老陷阱，让它无法被误写）：

| 写法 | 语义 |
| --- | --- |
| `"./dist"` | 目录本身 → `<dest>/dist/...` |
| `"./dist/**"` | 目录内容 → `<dest>/...`（不含 dist 这层） |
| `"./dist/*"` | 下一层内容（不递归） |
| `"./dist/"` | 不合法：报 `DP.SOURCE.AMBIGUOUS`，提示改用前两种 |
| `"./dist/**/*.js"` | 递归匹配 .js |

#### Scenario: 尾随分隔符的源根

- **WHEN** 源根写成 `"./dist/"`
- **THEN** 报 `DP.SOURCE.AMBIGUOUS`，附 `./dist` 与 `./dist/**` 各自落点的预览

#### Scenario: 两种合法写法的落点差异

- **WHEN** 分别以 `"./dist"` 与 `"./dist/**"` 部署同一目录
- **THEN** 前者目标多出 dist 这一层，后者直接是内容，可从计划预览看出差异
