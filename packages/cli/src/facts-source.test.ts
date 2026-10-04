import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseSshTarget, nearestExistingDir, releaseRootCandidates } from './facts-source.js'

describe('facts-source · 发布根候选按平台分流（纯）', () => {
  const home = process.platform === 'win32' ? 'C:/Users/u' : '/home/u'

  it('win32 上不出现 /srv、/opt 这类 POSIX 候选', () => {
    const got = releaseRootCandidates('web', home, {}, 'win32')
    assert.ok(got.length > 0)
    for (const p of got) {
      assert.ok(
        !/^[A-Za-z]:?[\\/]?(srv|opt|var|usr)[\\/]/i.test(p) && !p.startsWith('/srv'),
        `win32 不该出现 POSIX 候选：${p}`,
      )
    }
  })

  it('linux 上不出现 %ProgramData% 这类 Windows 候选', () => {
    const got = releaseRootCandidates('web', home, {}, 'linux')
    for (const p of got) {
      assert.ok(!p.includes('ProgramData') && !p.includes('LOCALAPPDATA'), `linux 不该出现 Windows 候选：${p}`)
    }
    assert.ok(
      got.some((p) => p.startsWith('/srv/') || p.startsWith('/opt/') || p.includes('/apps/')),
      `linux 候选应该有 POSIX 路径，实际 ${got.join(' | ')}`,
    )
  })

  it('同一平台下三种布局的候选都被展开且去重', () => {
    const got = releaseRootCandidates('web', home, {}, 'linux')
    assert.equal(new Set(got).size, got.length, '候选不该有重复')
    // system / hybrid / user 至少各有一个，否则某一种布局会永远选不到发布根
    assert.ok(got.some((p) => p.startsWith('/opt/')), `缺 system 类候选：${got.join(' | ')}`)
    assert.ok(got.some((p) => p.includes('/apps/')), `缺 user 类候选：${got.join(' | ')}`)
  })

  it('unknown 平台回退到 ~/apps，不会返回空', () => {
    const got = releaseRootCandidates('web', home, {}, 'unknown')
    assert.ok(got.length > 0, 'unknown 平台也要有候选，否则 plan 必然失败')
  })
})

describe('facts-source · 纯解析', () => {
  it('parseSshTarget：user@host:port', () => {
    assert.deepEqual(parseSshTarget('deploy@10.0.0.5:2222', 'p'), {
      user: 'deploy',
      host: '10.0.0.5',
      port: 2222,
    })
  })

  it('parseSshTarget：不写端口就不猜 22（交给驱动）', () => {
    assert.deepEqual(parseSshTarget('deploy@10.0.0.5', 'p'), { user: 'deploy', host: '10.0.0.5' })
  })

  it('parseSshTarget：端口越界 / 非数字 → 明确报错', () => {
    for (const bad of ['h:0', 'h:70000', 'h:abc']) {
      assert.throws(() => parseSshTarget(bad, 'p'), { code: 'DP.CONFIG.INVALID' }, `应该拒绝 ${bad}`)
    }
  })

  it('nearestExistingDir：一路冒到已存在的祖先，最差停在自己身上', () => {
    const root = process.platform === 'win32' ? 'C:/' : '/'
    assert.equal(nearestExistingDir(root), root, '根自身存在时就是它')
    // 一个几乎肯定不存在的深路径：不能无限循环，必须收敛到某个已存在的祖先
    const deep = `${root}no-such-dir-${Date.now()}/a/b/c`
    const got = nearestExistingDir(deep)
    assert.notEqual(got, deep)
    assert.ok(got.length < deep.length)
  })
})
