/**
 * 远端脚本里「照 POSIX 写会踩坑」的那几条。
 *
 * rename 这条是真机换来的：不带 `-T` 的 `mv` 在目标是「指向目录的软链」时不会替换
 * 软链，而是把源挪进它指着的目录 —— 第二次部署之后 current 还指着上一版，
 * 报告却说成功。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renameScript } from './posix.js'

describe('renameScript', () => {
  it('首选 mv -T：不带 -T 时 mv 会把源挪进软链指着的目录（换向后 current 仍指旧版）', () => {
    const s = renameScript('/srv/a/current.dp-tmp', '/srv/a/current')
    assert.match(s, /mv -T -f -- "\$a" "\$b"/)
  })

  it('有退回分支：不支持 -T 的 mv 走「先摘软链再 mv」', () => {
    const s = renameScript('/srv/a/current.dp-tmp', '/srv/a/current')
    assert.match(s, /rm -f -- "\$b"/)
    assert.match(s, /mv -f -- "\$a" "\$b"/, '退回分支里仍然要有不带 -T 的那次 mv')
  })

  it('退回分支只在「目标是软链或不存在」时才摘 —— 绝不 rm 一个真实目录', () => {
    const s = renameScript('/srv/a/tmp', '/srv/a/current')
    assert.match(s, /\[ -L "\$b" \] \|\| \[ ! -d "\$b" \]/)
    // 真实目录直接失败（退出 5），而不是把源挪进去
    assert.match(s, /exit 5/)
  })

  it('两个路径原样进脚本，各自独立赋值（拼进命令串会被 shell 再解释一次）', () => {
    const s = renameScript('/srv/my app/tmp', '/srv/my app/current')
    assert.match(s, /a='\/srv\/my app\/tmp'/)
    assert.match(s, /b='\/srv\/my app\/current'/)
  })
})
