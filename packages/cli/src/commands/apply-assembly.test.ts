/**
 * 装配层里两处「形状对不上就出事」的翻译。
 *
 * 两条都是真机踩出来的：
 *  - `sourceBaseFor` 少退一层目录 → rsync 报 23、0 个文件，上层只能说「source 里没有文件」；
 *  - `withParentDirs` 漏掉版本目录本身 → 第一次 writeFile 必然 ENOENT。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { SourceSpec } from '@dp/runner-local'
import type { SourceEntry } from '@dp/ports'
import { sourceBaseFor, withParentDirs } from './apply-assembly.js'

const file = (relativePath: string): SourceEntry => ({
  kind: 'file',
  relativePath,
  read: () => Promise.resolve(new Uint8Array()),
})

describe('sourceBaseFor', () => {
  it('self：条目带源目录自己的名字，基目录要退到它的父目录', () => {
    const spec: SourceSpec = { root: '/work/dist', mode: 'self' }
    // listSourceEntries 在 self 下给的是 `dist/index.html`，拼在 root 上就成了
    // /work/dist/dist/index.html —— 真机上表现为 rsync exit 23
    assert.equal(sourceBaseFor(spec), '/work')
  })

  it('contents：条目就是相对 root 的，基目录就是 root', () => {
    const spec: SourceSpec = { root: '/work/dist', mode: 'contents' }
    assert.equal(sourceBaseFor(spec), '/work/dist')
  })

  it('单文件源：self 下基目录是它所在目录（条目是文件名本身）', () => {
    const spec: SourceSpec = { root: '/work/dist/index.html', mode: 'self' }
    assert.equal(sourceBaseFor(spec), '/work/dist')
  })

  it('结果里的分隔符一律是正斜杠：拼出来的串要进 rsync / scp 的远端 argv', () => {
    // join 用的是当前平台的分隔符，这条断言在两侧都成立（POSIX 上本来就是 /）
    const spec: SourceSpec = { root: join('work', 'dist'), mode: 'contents' }
    assert.equal(sourceBaseFor(spec), 'work/dist')
  })
})

describe('withParentDirs', () => {
  it('补上缺失的中间层，且浅的排在前（deploy 逐条写，不保证父子顺序）', () => {
    const out = withParentDirs([file('assets/js/app.js')])
    assert.deepEqual(
      out.map((e) => e.relativePath),
      ['', 'assets', 'assets/js', 'assets/js/app.js'],
    )
    assert.deepEqual(
      out.filter((e) => e.kind === 'dir').map((e) => e.relativePath),
      ['', 'assets', 'assets/js'],
    )
  })

  it('最顺手的写法（单段路径）也要补出版本目录本身，否则第一次 writeFile 就 ENOENT', () => {
    const out = withParentDirs([file('index.html')])
    assert.deepEqual(
      out.map((e) => e.relativePath),
      ['', 'index.html'],
    )
  })

  it('清单里已经有的父目录不重复补', () => {
    const entries = [{ kind: 'dir' as const, relativePath: 'assets' }, file('assets/app.js')]
    assert.deepEqual(
      withParentDirs(entries).map((e) => e.relativePath),
      ['', 'assets', 'assets/app.js'],
    )
  })

  it('空清单也要留下版本目录本身：空版本会被上层拒绝，但目录得先存在', () => {
    assert.deepEqual(withParentDirs([]).map((e) => e.relativePath), [''])
  })
})
