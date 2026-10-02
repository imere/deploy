/**
 * 所有权保护。
 *
 * 四种情形都要测：不存在 / 有标记 / 无标记 / 无标记但 force。
 * 只测「会 abort」会让人把标记判得太宽（正文里出现标记字样就认领），
 * 而认领太宽等于对用户文件失去保护，同样是事故。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { assertOverwritable, decideOverwrite, isManaged, MANAGED_MARKER } from './ownership.js'

describe('decideOverwrite', () => {
  it('不存在 → create，且不需要备份（没有可覆盖的东西）', () => {
    const d = decideOverwrite(null)
    assert.equal(d.action, 'create')
    assert.equal(d.backup, false)
  })

  it('带标记 → replace，并备份', () => {
    const d = decideOverwrite(`${MANAGED_MARKER}\nserver {\n}\n`)
    assert.equal(d.action, 'replace')
    // 替换 dp 自己的文件也要备份：它可能是用户手动改过、还没回归配置的那一份
    assert.equal(d.backup, true)
  })

  it('标记在首行之外的注释里也认（用户会在上面加自己的注释）', () => {
    assert.equal(isManaged('# 我自己加的注释\n  # 缩进的也算\n' + MANAGED_MARKER + '\nserver {\n}'), true)
  })

  it('标记在前 5 行之外不算数', () => {
    const far = ['# 1', '# 2', '# 3', '# 4', '# 5', `# 6 ${MANAGED_MARKER}`, 'server {}'].join('\n')
    assert.equal(isManaged(far), false)
    assert.equal(decideOverwrite(far).action, 'abort')
  })

  it('标记不在注释行里不算（正文是 nginx 的有效配置，不是归属凭证）', () => {
    assert.equal(isManaged('add_header X-Note "managed by dp";\n'), false)
    assert.equal(decideOverwrite('add_header X-Note "managed by dp";\n').action, 'abort')
  })

  it('无标记 → abort', () => {
    const d = decideOverwrite('server {\n  listen 80;\n}\n')
    assert.equal(d.action, 'abort')
    assert.equal(d.backup, false)
    assert.match(d.reason, /不带 managed 标记/)
  })

  it('空文件 → abort（空文件不可能是 dp 写的）', () => {
    assert.equal(decideOverwrite('').action, 'abort')
    assert.equal(decideOverwrite('   \n\n').action, 'abort')
  })

  it('无标记但 force → replace，且仍然备份', () => {
    const d = decideOverwrite('server {}', { force: true })
    assert.equal(d.action, 'replace')
    // force 只放开覆盖，不放开「覆盖前先备份」——备份是唯一的后悔药
    assert.equal(d.backup, true)
    assert.match(d.reason, /force/)
  })
})

describe('assertOverwritable', () => {
  it('abort 抛 DP.NGX.NOT_MANAGED，hint 说清怎么保住自己的文件', () => {
    try {
      assertOverwritable('server {}', { path: 'projects.web.target.nginx.filename' })
      throw new Error('期望抛错')
    } catch (err) {
      assert.ok(err instanceof DpError)
      assert.equal(err.code, 'DP.NGX.NOT_MANAGED')
      assert.equal(err.path, 'projects.web.target.nginx.filename')
      assert.match(err.hint ?? '', /force: true/)
      assert.match(err.hint ?? '', /managed by dp/)
      assert.match(err.hint ?? '', /\.dp-backup/)
    }
  })

  it('create / replace 不抛', () => {
    assert.doesNotThrow(() => assertOverwritable(null))
    assert.doesNotThrow(() => assertOverwritable(`${MANAGED_MARKER}\nserver {}`))
    assert.doesNotThrow(() => assertOverwritable('server {}', { force: true }))
  })
})
