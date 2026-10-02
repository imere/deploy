import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_LEVEL, LOG_LEVELS, isLevelEnabled, levelRank } from './level.js'
import type { LogLevel } from '@dp/ports'

describe('level', () => {
  it('序数严格递增', () => {
    const ranks = LOG_LEVELS.map(levelRank)
    for (let i = 1; i < ranks.length; i++) {
      assert.ok((ranks[i] as number) > (ranks[i - 1] as number), `${LOG_LEVELS[i]} 必须高于 ${LOG_LEVELS[i - 1]}`)
    }
    assert.equal(DEFAULT_LEVEL, 'info')
    assert.equal(LOG_LEVELS.length, 5)
  })

  it('isLevelEnabled：全组合表驱动', () => {
    const rows: ReadonlyArray<readonly [LogLevel, LogLevel, boolean]> = [
      ['error', 'trace', true],
      ['error', 'debug', true],
      ['error', 'info', true],
      ['error', 'warn', true],
      ['error', 'error', true],
      ['warn', 'trace', true],
      ['warn', 'debug', true],
      ['warn', 'info', true],
      ['warn', 'warn', true],
      ['warn', 'error', false],
      ['info', 'trace', true],
      ['info', 'debug', true],
      ['info', 'info', true],
      ['info', 'warn', false],
      ['info', 'error', false],
      ['debug', 'trace', true],
      ['debug', 'debug', true],
      ['debug', 'info', false],
      ['trace', 'trace', true],
      ['trace', 'debug', false],
    ]
    for (const [level, threshold, expected] of rows) {
      assert.equal(isLevelEnabled(level, threshold), expected, `${level} vs ${threshold}`)
    }
  })

  it('未知级别（JS 调用方传脏数据）不输出，也不炸', () => {
    assert.equal(levelRank('nope' as LogLevel), 0)
    assert.equal(isLevelEnabled('trace' as LogLevel, 'nope' as LogLevel), true)
  })
})
