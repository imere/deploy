/**
 * 写权限探测的行为测试 —— 跑在真实文件系统上。
 *
 * 盯的是三条不能含糊的边界：
 *  - 判定只看**建文件有没有成功**。删不掉不改变结论 —— 拿清理结果改写判定，会把
 *    明明可写的目录报成不可写，症状是这台机器上所有候选目录同时被判死。
 *  - 清理必须成功。残留留在别人的目录里是 dp 欠下的债，攒起来会反噬成上面的症状。
 *  - 清理失败必须**留痕**。静默过一次，事后没有任何线索指得到真正的原因。
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'
import { probeLocalFacts, probeWritable } from './index.js'

let sandbox = ''

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'dp-probe-'))
})

after(async () => {
  await fs.rm(sandbox, { recursive: true, force: true })
})

async function freshDir(name: string): Promise<string> {
  const dir = join(sandbox, name)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** 必定失败的删除动作。用它断言「删不掉」这条路径 —— 真机器上要靠权限异常才碰得到 */
async function failingRemove(path: string): Promise<never> {
  throw Object.assign(new Error(`EPERM: simulated remove failure on ${path}`), { code: 'EPERM' })
}

async function listProbes(dir: string): Promise<readonly string[]> {
  return (await fs.readdir(dir)).filter((n) => n.startsWith('.dp-w-'))
}

describe('probeWritable · 判定与清理', () => {
  it('建完就删干净，不留探测垃圾', async () => {
    const dir = await freshDir('clean')
    const result = await probeWritable([dir])
    assert.equal(result.canWrite[dir], true)
    assert.deepEqual(result.leftovers, [], '删不掉必须被记成 leftover，不许吞掉')
    assert.deepEqual(await listProbes(dir), [], '探测文件必须当场删掉')
  })

  it('删除失败不污染判定：仍判可写，但 leftover 记着这条路径', async () => {
    const dir = await freshDir('undeletable')
    const result = await probeWritable([dir], { remove: failingRemove })

    // 文件真的建出来了 —— 这就是可写的实证，删不掉没有资格改写它
    assert.equal(result.canWrite[dir], true, '删不掉不能把可写改判成不可写')
    assert.equal(result.leftovers.length, 1, '删不掉的那条路径必须被交出去')
    const leftover = result.leftovers[0] as string
    const rel = relative(dir, leftover)
    assert.ok(!rel.includes('..') && !isAbsolute(rel), 'leftover 必须是探测目录下的完整路径')
    assert.ok(basename(rel).startsWith('.dp-w-'), 'leftover 指向的就是探测文件本身')

    // 留痕之外还必须说得清是哪个文件真的没删掉
    const left = await listProbes(dir)
    assert.equal(left.length, 1, '注入的删除函数没干活，文件应当还在')
    assert.equal(left[0], rel, 'leftover 指向的必须就是留在盘上的那个文件')
  })

  it('第一次删失败会重试一次；重试成功就当没发生过', async () => {
    const dir = await freshDir('retry')
    let calls = 0
    const result = await probeWritable([dir], {
      remove: async (path) => {
        calls += 1
        if (calls === 1) throw new Error('transient EBUSY')
        await fs.rm(path, { force: true })
      },
    })
    assert.equal(calls, 2, '瞬时占用应当被重试一次')
    assert.equal(result.canWrite[dir], true)
    assert.deepEqual(result.leftovers, [], '重试成功不算 leftover')
    assert.deepEqual(await listProbes(dir), [], '重试成功就得真的删掉')
  })

  it('真不可写仍判不可写，且不留 leftover', async () => {
    const missing = join(sandbox, 'definitely-missing')
    const parent = await freshDir('not-a-dir')
    const asFile = join(parent, 'i-am-a-file')
    await fs.writeFile(asFile, 'x')

    const result = await probeWritable([missing, asFile])
    assert.equal(result.canWrite[missing], false, '不存在的目录建不出文件，必须如实否定')
    assert.equal(result.canWrite[asFile], false, '父级是文件时建不出文件，必须如实否定')
    assert.deepEqual(result.leftovers, [], '没建出来就没有东西要回收，不许记 leftover')
  })

  it('只读目录判不可写（POSIX 权限位真能挡住建文件）', async (t) => {
    if (process.platform === 'win32') {
      // Windows 上目录的只读属性不阻止写入，拿它断言「不可写」是错的断言而不是宽松断言
      t.skip('只读目录属性在 Windows 上不构成写屏障')
      return
    }
    const dir = await freshDir('readonly')
    await fs.chmod(dir, 0o500)
    try {
      const result = await probeWritable([dir])
      assert.equal(result.canWrite[dir], false)
      assert.deepEqual(result.leftovers, [])
    } finally {
      await fs.chmod(dir, 0o700)
    }
  })
})

describe('probeLocalFacts · 未回收的痕迹要走到调用方', () => {
  it('facts.capabilities.probeLeftovers 带着没删掉的探测文件', async () => {
    const dir = await freshDir('facts-leftover')
    const facts = await probeLocalFacts({
      writeProbePaths: [dir],
      tools: [],
      removeProbeFile: failingRemove,
    })

    const leftovers = facts.capabilities.probeLeftovers
    assert.ok(leftovers !== undefined, '清理失败时 facts 必须带着这个键出去，否则等于没说')
    assert.equal(leftovers.length, 1)
    assert.ok((leftovers[0] as string).startsWith(dir))
    // 判定本身不受影响：这条目录在 facts 里仍是可写的
    assert.equal(facts.capabilities.canWrite[dir], true)
  })

  it('全部回收干净时不放这个键 —— 「没这个键」才表示真的干净', async () => {
    const dir = await freshDir('facts-clean')
    const facts = await probeLocalFacts({ writeProbePaths: [dir], tools: [] })
    assert.equal(facts.capabilities.probeLeftovers, undefined)
    assert.equal(facts.capabilities.canWrite[dir], true)
    assert.deepEqual(await listProbes(dir), [])
  })
})
