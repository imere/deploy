import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  assertAllowedFlags,
  CliUsageError,
  isUsageError,
  parseArgs,
  stringFlag,
  hasFlag,
  BOOLEAN_FLAGS,
  VALUE_FLAGS,
  ALL_FLAGS,
} from './args.js'
import { DpError } from '@dp/ports'

describe('args · 形状', () => {
  it('空 argv：没有命令、没有位置参数', () => {
    const p = parseArgs([])
    assert.equal(p.command, undefined)
    assert.deepEqual(p.positional, [])
    assert.deepEqual(p.flags, {})
  })

  it('只有命令', () => {
    assert.equal(parseArgs(['plan']).command, 'plan')
  })

  it('--a b 空格形式', () => {
    const p = parseArgs(['plan', '--config', './a.json'])
    assert.equal(p.flags['config'], './a.json')
  })

  it('--a=b 等号形式', () => {
    assert.equal(parseArgs(['--log-level=debug']).flags['log-level'], 'debug')
  })

  it('等号形式里值含 = 不会被截断', () => {
    assert.equal(parseArgs(['--log-file=a=b.log']).flags['log-file'], 'a=b.log')
  })

  it('布尔开关吃掉，不吃值', () => {
    const p = parseArgs(['--json', '--verbose'])
    assert.equal(p.flags['json'], true)
    assert.equal(p.flags['verbose'], true)
  })

  it('-c <path> 短选项', () => {
    assert.equal(parseArgs(['-c', 'x.json']).flags['config'], 'x.json')
  })

  it('-c=x.json 短选项等号', () => {
    assert.equal(parseArgs(['-c=x.json']).flags['config'], 'x.json')
  })

  it('-h 等价 --help', () => {
    assert.equal(parseArgs(['-h']).flags['help'], true)
    assert.equal(parseArgs(['--help']).flags['help'], true)
  })

  it('-v 等价 --verbose，-q 等价 --quiet', () => {
    assert.equal(parseArgs(['-v']).flags['verbose'], true)
    assert.equal(parseArgs(['-q']).flags['quiet'], true)
  })

  it('位置参数：第一个是命令，其余进 positional', () => {
    const p = parseArgs(['plan', 'web', 'local'])
    assert.equal(p.command, 'plan')
    assert.deepEqual(p.positional, ['web', 'local'])
  })

  it('-- 之后全当位置参数，连 --json 也不解析', () => {
    const p = parseArgs(['plan', '--', '--json', '-c', 'x'])
    assert.equal(p.command, 'plan')
    assert.deepEqual(p.positional, ['--json', '-c', 'x'])
    assert.equal(p.flags['json'], undefined)
  })

  it('裸 -- 不进位置参数', () => {
    assert.deepEqual(parseArgs(['plan', '--']).positional, [])
  })

  it('-1 这类负数不被当成选项', () => {
    assert.equal(parseArgs(['--log-file', '-1.log']).flags['log-file'], '-1.log')
  })

  it('值可以以 - 开头之外的一切形式出现', () => {
    assert.equal(parseArgs(['--config', 'a-b.json']).flags['config'], 'a-b.json')
  })
})

describe('args · 拒绝歧义（铁律 2）', () => {
  it('未知长选项报错，且 hint 指向 --help', () => {
    const err = caughtThrows(() => parseArgs(['--nope'])) as DpError
    assert.equal(err.code, 'CONFIG_INVALID')
    assert.equal(err.path, '--nope')
    assert.match(err.hint ?? '', /--help/)
    assert.ok(isUsageError(err), '必须是 CliUsageError，退出码才映射到 2')
  })

  it('未知短选项报错', () => {
    caughtThrows(() => parseArgs(['-z']), CliUsageError)
  })

  it('值选项缺值报错（末尾）', () => {
    const err = caughtThrows(() => parseArgs(['--config'])) as CliUsageError
    assert.match(err.message, /需要一个值/)
  })

  it('值选项后面紧跟另一个选项 → 视为缺值', () => {
    caughtThrows(() => parseArgs(['--config', '--json']), CliUsageError)
  })

  it('值选项后面紧跟 -- → 视为缺值', () => {
    caughtThrows(() => parseArgs(['--config', '--']), CliUsageError)
  })

  it('--name= 后面空值报错（而不是静默接受空串）', () => {
    caughtThrows(() => parseArgs(['--config=']), CliUsageError)
  })

  it('布尔开关带值报错：--json=1 不会静默生效', () => {
    caughtThrows(() => parseArgs(['--json=1']), CliUsageError)
  })

  it('-h=x 同样报错', () => {
    caughtThrows(() => parseArgs(['-h=x']), CliUsageError)
  })
})

describe('args · 跨命令串用', () => {
  it('assertAllowedFlags 拒绝别的命令的开关', () => {
    const p = parseArgs(['facts', '--all'])
    const err = caughtThrows(() => assertAllowedFlags(p, ['json', 'host'])) as CliUsageError
    assert.match(err.message, /facts 不支持选项 --all/)
    assert.equal(err.path, '--all')
  })

  it('允许的开关不报错', () => {
    assertAllowedFlags(parseArgs(['facts', '--json', '--host', 'local']), ['json', 'host'])
  })
})

describe('args · 读取辅助', () => {
  it('stringFlag 只对字符串值返回，其余 undefined', () => {
    assert.equal(stringFlag({ config: 'a' }, 'config'), 'a')
    assert.equal(stringFlag({ config: true }, 'config'), undefined)
    assert.equal(stringFlag({}, 'config'), undefined)
  })

  it('hasFlag 只认 true', () => {
    assert.equal(hasFlag({ json: true }, 'json'), true)
    assert.equal(hasFlag({ json: 'yes' }, 'json'), false)
  })

  it('开关表自洽：两个集合不相交，且并集就是 ALL_FLAGS', () => {
    for (const b of BOOLEAN_FLAGS) assert.ok(!VALUE_FLAGS.has(b), `${b} 同时在两个表里`)
    assert.deepEqual([...ALL_FLAGS].sort(), [...new Set([...BOOLEAN_FLAGS, ...VALUE_FLAGS])].sort())
  })
})

// assert.throws/rejects 在本仓的 @types/node 下返回 void，拿不到错误对象。
// 统一走这两个 helper：类型上直接是 DpError。
function caughtThrows(fn: () => unknown, _ctor?: unknown): DpError {
  try {
    fn()
  } catch (err) {
    return err as DpError
  }
  throw new Error('期望抛错，但没有')
}
async function caughtRejects(p: Promise<unknown>): Promise<DpError> {
  try {
    await p
  } catch (err) {
    return err as DpError
  }
  throw new Error('期望 reject，但没有')
}
