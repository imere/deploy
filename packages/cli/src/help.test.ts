import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  COMMANDS,
  COMMAND_NAMES,
  commandHelp,
  editDistance,
  findCommand,
  notImplementedMessage,
  rootHelp,
  suggestCommand,
  unknownCommandMessage,
} from './help.js'

describe('help · 每个命令都够用（decisions.md §18）', () => {
  it('根帮助含用法、开关表、至少 2 个例子、退出码', () => {
    const text = rootHelp('0.0.0')
    assert.match(text, /用法/)
    assert.match(text, /dp <命令> \[选项\]/)
    assert.match(text, /全局开关/)
    assert.match(text, /退出码/)
    const examples = text.split('例子（可直接复制）')[1]?.split('退出码')[0] ?? ''
    assert.ok(examples.split('\n').filter((l) => l.trim().startsWith('dp ')).length >= 2, '根帮助至少 2 个例子')
  })

  it('每个已实现命令都有：用途 / 用法行 / 开关 / ≥2 例子 / 相关命令', () => {
    for (const doc of COMMANDS.filter((c) => c.implemented)) {
      const text = commandHelp(doc)
      assert.ok(doc.summary.length > 0, `${doc.name} 缺 summary`)
      assert.match(text, /用法/, `${doc.name} 缺用法`)
      // 用 includes 而不是 new RegExp：用法行里有 [ ] ( ) + 等元字符
      assert.ok(text.includes(doc.usage), `${doc.name} 缺用法行`)
      assert.ok(doc.examples.length >= 2, `${doc.name} 例子少于 2 个`)
      assert.match(text, /相关命令/, `${doc.name} 缺相关命令`)
      assert.ok(doc.related.length > 0, `${doc.name} 相关命令为空`)
    }
  })

  it('每条帮助都打印了退出码 —— agent 靠它决定要不要重试', () => {
    for (const doc of COMMANDS) assert.match(commandHelp(doc), /退出码：0=/, doc.name)
  })

  it('例子是可直接复制的命令行，不含占位性的漂亮话', () => {
    for (const doc of COMMANDS) {
      for (const example of doc.examples) {
        assert.match(example, /^dp \w+/, `${doc.name} 的例子不以 dp 开头：${example}`)
        assert.ok(!example.includes('TODO'), `${doc.name} 的例子含 TODO`)
        assert.ok(!example.includes('xxx'), `${doc.name} 的例子含占位符 xxx`)
      }
    }
  })

  it('未实现的命令也给出可执行的下一步，而不是空帮助', () => {
    for (const doc of COMMANDS.filter((c) => !c.implemented)) {
      const text = notImplementedMessage(doc)
      assert.match(text, /后续回合/, doc.name)
      assert.match(text, /dp plan/, `${doc.name} 应指向 plan`)
    }
  })
})

describe('help · 未找到命令', () => {
  it('editDistance 正确', () => {
    assert.equal(editDistance('plan', 'plan'), 0)
    assert.equal(editDistance('plan', 'plans'), 1)
    assert.equal(editDistance('', 'abc'), 3)
  })

  it('相近的命令会被建议出来', () => {
    assert.equal(suggestCommand('plans'), 'plan')
    assert.equal(suggestCommand('plna'), 'plan')
    assert.equal(suggestCommand('fact'), 'facts')
    assert.equal(suggestCommand('scheam'), 'schema')
  })

  it('离得远的不硬凑建议（硬凑比不给更糟）', () => {
    assert.equal(suggestCommand('zzzzzzzzzzzz'), undefined)
  })

  it('未知命令的消息含建议 + 可用命令 + --help', () => {
    const text = unknownCommandMessage('plans')
    assert.match(text, /未知命令：plans/)
    assert.match(text, /dp plan/)
    for (const name of COMMAND_NAMES) assert.ok(text.includes(name), `缺 ${name}`)
    assert.match(text, /dp --help/)
  })

  it('未知命令没有建议时也不崩', () => {
    assert.match(unknownCommandMessage('qqqqqqqqqqqq'), /可用命令/)
  })

  it('findCommand', () => {
    assert.equal(findCommand('plan')?.implemented, true)
    assert.equal(findCommand('nope'), undefined)
  })
})
