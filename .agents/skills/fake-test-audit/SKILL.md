---
name: fake-test-audit
description: 排查「跑着是绿的、但什么也没验证」的测试 —— 六类静态信号、helper 陷阱、扫描器写法，以及为什么终局只能靠变异验证。当测试全绿却仍出 bug、或要审计测试质量时使用。
---

# 假测试排查

测试数量和覆盖率都不能证明行为被验证。**「全绿」和「有保障」是两件事。**

## 1. 六类静态信号

| 类 | 信号 | 说明 |
|---|---|---|
| A 恒真 | `assert.ok(true)`、比较两边字面同一个表达式 | 永远通过 |
| B 零断言 | 整块没有任何断言 | 注意 helper（见 §2） |
| C 吞异常 | 空 `catch {}` | 抛了也被当成通过 |
| D 跳过 | `.skip` 没写理由 | 不算假，但要知道为什么躺在那 |
| E 弱存在性 | `assert.ok(变量)` | 对象/数组恒 truthy，等于没断言；要断言具体字段 |
| G 忽略参数 | helper 声明 `_x`，调用处却传了值 | **最隐蔽的一类**，见 §3 |

## 2. 先解析 helper，否则全是误报

实测：第一版扫描器报了 **45 条**「零断言」，逐条看下来几乎全是误报 ——
它们调用的是文件内的断言 helper（`caughtThrows(fn)` / `rejects(v)` / `allows(v)`），
helper 内部**有** `assert`（或 sentinel `throw new Error('期望抛错但没有')`）。

修法：扫描时先把文件内定义的函数扫一遍，凡函数体内含 `assert.` 或 sentinel throw 的，
把它的名字收集起来；用例里调用它**就算有断言**。改完 45 条 → 1 条。

反过来说：**helper 本身是不是真断言，才是要审的对象**。一个 helper 有问题，
它下面几十个用例全部一起失效。

## 3. G 类：被忽略的校验参数（真实案例）

```ts
// 看着在断言「抛的是 CliUsageError」
function caughtThrows(fn: () => unknown, _ctor?: unknown): DpError {
  try { fn() } catch (err) { return err as DpError }
  throw new Error('期望抛错，但没有')
}
// 调用处 21 处传了第二个参数
caughtThrows(() => parseArgs(['-z']), CliUsageError)
```

`_ctor` **被完全忽略**。这 21 个用例声称在断言错误类型，实际只断言「抛了任何东西」——
实现改成抛别的错误类型（退出码也跟着变）测试照样全绿。

识别办法：正则找「下划线开头的参数名」（`_x`、`_ctor`），再看调用处有没有给它传值。
下划线命名通常是「我知道这个参数没用」的标记，但**调用方不知道**。

正确写法：

```ts
function caughtThrows(fn: () => unknown, ctor?: Function): DpError {
  try { fn() } catch (err) {
    if (ctor !== undefined) assert.ok(err instanceof ctor, `期望 ${ctor.name}，实际 ${String(err)}`)
    return err as DpError
  }
  throw new Error('期望抛错，但没有')
}
```

同理警惕**只做类型断言不校验运行时**：`const err = f() as SpecificError` ——
cast 不检查任何东西，只是让编译器闭嘴。

## 4. 其他常见假测试形态

- **断言回显输入**：`const plan = makePlan(fixture); assert.deepEqual(plan.input, fixture)`
   —— 等于断言「传进去的又回来了」，被测逻辑一点没验。
- **mock 掉被测主体**：把被测函数替换成 stub，再断言 stub 的返回值。
  正确做法是 mock **依赖**（IO、时钟、外部模块），mock 掉被测函数本身就什么也没测。
- **哨兵测试是合法的**：`assert.fail('需要 X 后手工启用')` 放在 skip 块里，
  防止真机用例被误启用 —— 这不是假测试，别误删。
- **只断言「不抛」**：`fn(x)` 不写断言靠「抛了就失败」—— 有效但弱，
  显式写 `assert.doesNotThrow` 更好读。

### 4.1 两类常见误报，别误杀

- **类型收窄**：`assert.ok(x)` 紧跟 `assert.match(x.field, ...)`。
  这里的 `ok` 是给类型系统看的（`find()` 返回 `T | undefined`，不收窄就访问不了字段），
  真正的断言是后面那句。扫出来当弱存在性 = 误报。
  判据：**同一个变量后面还有针对它字段的断言**，就不算弱。
- **哨兵测试**：`assert.fail('需要 X 后手工启用')` 放在 skip 块里，
  防止真机用例被误启用 —— 见 §4，不是假测试。

## 5. 扫描器怎么写

写一个 `.tmp/find-fake-tests.mjs`：
1. 遍历测试文件，按 `test(` / `it(` 行起、括号配平切块
2. 先扫文件内的 helper 定义，收集「内有 assert 或 sentinel throw」的名字（§2）
3. 块内断言数 = 内联 `assert.` + helper 调用
4. 逐类匹配 §1 的信号

**只报信号，不下结论。** 每类都要人工看一眼，机械判定误报率很高。

## 6. 终局是变异验证

静态扫描只能抓「断言写坏了」，抓不到「断言写对了但夹具区分不出正确与错误的实现」
（这才是假测试的大头）。所以静态扫完必须补一轮 `mutation-verify`：

撤掉修复 → 测试仍绿 = 这条测试形同虚设，重写而不是留着。
