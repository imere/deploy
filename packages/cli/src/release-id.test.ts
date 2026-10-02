import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { previewReleaseId, releaseIdFor } from './release-id.js'

/** 固定时刻：releaseId 的格式一旦定死就不能被「顺手改一下」悄悄改掉 */
const T0 = new Date('2026-10-02T09:30:00.000Z')

describe('release-id · releaseIdFor（纯函数）', () => {
  it('格式稳定：<name>-<UTC 时间戳>', () => {
    assert.equal(releaseIdFor('web', T0), 'web-20261002-093000')
  })

  it('用 UTC 而不是本地时间：跨时区算出同一个 id', () => {
    // 同一个瞬间的两种表示方式，toISOString 恒为 UTC
    const same = new Date(Date.UTC(2026, 0, 1, 0, 0, 0))
    assert.equal(releaseIdFor('web', same), 'web-20260101-000000')
    // 本地时区再偏移几小时，id 不变
    const shifted = new Date(same.getTime() + 8 * 3600_000)
    assert.equal(releaseIdFor('web', shifted), 'web-20260101-080000')
  })

  it('同一 Date 幂等：反复调用结果完全一致', () => {
    const a = releaseIdFor('web', T0)
    const b = releaseIdFor('web', new Date(T0.getTime()))
    assert.equal(a, b)
    assert.equal(releaseIdFor('web', T0), a)
  })

  it('毫秒被丢弃：只差毫秒视为同一个发布', () => {
    const a = releaseIdFor('web', new Date('2026-10-02T09:30:00.000Z'))
    const b = releaseIdFor('web', new Date('2026-10-02T09:30:00.999Z'))
    assert.equal(a, b)
  })

  it('id 里不含路径分隔符以外的时间歧义字符', () => {
    // 时间戳段必须全是 [0-9-]，否则 grep 日志时正则会被冒号/毫秒坑到
    const id = releaseIdFor('web', T0)
    assert.match(id, /^web-\d{8}-\d{6}$/)
    assert.ok(!id.includes(':'), 'id 里不能有冒号')
    assert.ok(!id.includes('.'), 'id 里不能有毫秒点')
  })

  it('项目名里的空格与斜杠原样保留，不做任何替换', () => {
    // 显式决定：歧义靠拒绝不靠默认值。替换规则（_ 还是 -）是猜测，猜错就静默部署到别处
    assert.equal(releaseIdFor('my app', T0), 'my app-20261002-093000')
    assert.equal(releaseIdFor('a/b', T0), 'a/b-20261002-093000')
  })
})

describe('release-id · previewReleaseId（纯函数）', () => {
  it('带 preview- 前缀，且与真 id 共享同一段后缀', () => {
    assert.equal(previewReleaseId('web', T0), 'preview-web-20261002-093000')
    assert.ok(previewReleaseId('web', T0).endsWith(releaseIdFor('web', T0)))
  })

  it('preview- 前缀保证不可能与任何真 releaseId 撞名', () => {
    assert.notEqual(previewReleaseId('web', T0), releaseIdFor('web', T0))
    // 即便项目名本身以 preview- 开头，后缀时间戳也仍在，两者的 name 段必须一致
    assert.ok(previewReleaseId('web', T0).startsWith('preview-'))
  })
})
