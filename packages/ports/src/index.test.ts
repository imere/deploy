/**
 * ports 是契约层：它不实现任何行为，所以这里的测试也不是行为测试，
 * 而是**防这一层自己漂移**的两类断言。
 *
 *  ① 共享常量：它们的全部价值就是「全仓只有一份」，所以必须钉住字面值。
 *     改默认值应当是一次有意识的、会让测试变红的动作；否则「顺手改个数字」
 *     的代价是 plan 说一套、prune 做另一套，而两边都不报错。
 *  ② 错误码表：`docs/failures.md` 与 `DP_ERROR_CODES` 是同一份知识的两个副本。
 *     只加进数组、没登记进文档 = 出错了查不到处置办法（这个坑已经栽过四次）；
 *     所以这里把「每个码都在册」做成自动断言，不再靠人 grep。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  CURRENT_LINK_NAME,
  DP_ERROR_CODES,
  INCOMING_SUFFIX,
  POSIX_WRITE_CANDIDATES,
  RELEASES_DIR_NAME,
} from './index.js'

/** build/index.test.js → 仓库根/docs/failures.md */
const FAILURES_DOC = new URL('../../../docs/failures.md', import.meta.url)

/**
 * 文档里登记的是**族**（`DP.CONN.*`、`DP.TIMEOUT.*`）—— 那是设计期先写下的分类骨架。
 * 代码抛的是具体码（`DP.TIMEOUT.EXEC`）。族覆盖族下的具体码，这是有意的，不算缺失。
 */
function coveredBy(codes: ReadonlySet<string>, code: string): boolean {
  if (codes.has(code)) return true
  const seg = code.split('.')
  for (let i = seg.length - 1; i > 0; i--) {
    if (codes.has(`${seg.slice(0, i).join('.')}.*`)) return true
  }
  return false
}

/**
 * 只解析「故障分类表」那一节。
 *
 * 不全文扫：文档里还有别的表格（默认值表、救援能力表等），它们的第一列同样是
 * 反引号，全文扫会把 `trialTimeout`、`preflight.md` 这类东西当成错误码。
 * 按标题定位而不是按行号 —— 行号会漂，标题不会（漂了就是文档结构变了，该改测试）。
 */
function failureTable(): string {
  const lines = readFileSync(FAILURES_DOC, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith('#') && l.includes('故障分类表'))
  assert.notEqual(start, -1, 'docs/failures.md 里找不到「故障分类表」这一节')
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]?.startsWith('#') === true) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

/**
 * 表里第一列是错误码。
 *
 * 一格可能登记两个等价名（`CONFIG_INVALID` / `DP.CONFIG.INVALID`），所以取**整格**
 * 再从中挑反引号内容 —— 只匹配第一个反引号对的话，第二个名字会被当成没登记。
 */
function codesInDocs(): Set<string> {
  const found = new Set<string>()
  for (const m of failureTable().matchAll(/^\|\s*([^|]+)\|/gm)) {
    for (const t of (m[1] ?? '').matchAll(/`([^`]+)`/g)) {
      found.add((t[1] ?? '').trim())
    }
  }
  return found
}

/**
 * 文档里**设计期预留**的码：护栏层的 `DP.GUARD.*`、预检的 `DP.DISK.*`、
 * 以及 `DP.CONN.*` 这类通配族。
 *
 * 它们允许存在 —— 分类骨架先于实现写下来是有意的 —— 但**不许变多**：
 * 再加一个抛不出来的码，等于给人一条永远查不到现场的排查线索。
 * 真正的收敛方向是把它们逐个实现（然后从这里摘掉），或从表里删掉。
 */
const KNOWN_ORPHANS = [
  'DP.CONN.*',
  'DP.AUTH.*',
  'DP.TIMEOUT.*',
  'DP.DISK.INSUFFICIENT',
  'DP.DISK.INODE_EXHAUSTED',
  'DP.DISK.NOT_WRITABLE',
  'DP.DISK.FULL_RUNTIME',
  'DP.PERM.*',
  'DP.LSM.SELINUX_*',
  'DP.PORT.OCCUPIED',
  'DP.FILE.LOCKED',
  'DP.LOCK.HELD',
  'DP.STATE.INCONSISTENT',
  'DP.TRANSFER.INTERRUPTED',
  'DP.TRANSFER.CHECKSUM_MISMATCH',
  'DP.VERIFY.HEALTH_TIMEOUT',
  'DP.RESOURCE.OOM_KILLED',
  'DP.GUARD.TRIAL_EXPIRED',
]

describe('共享常量', () => {
  it('发布目录三个名字钉住字面值', () => {
    assert.equal(RELEASES_DIR_NAME, 'releases')
    assert.equal(CURRENT_LINK_NAME, 'current')
    assert.equal(INCOMING_SUFFIX, '.incoming')
  })

  it('可写性候选表含 nginx 的 confd —— 之前两份表不一致，同一份配置在远端能推出 confd、本机推不出来', () => {
    assert.equal(POSIX_WRITE_CANDIDATES.includes('/etc/nginx/conf.d'), true)
  })

  it('候选表按「越像正经部署位置越靠前」排序，/tmp 之类不该出现在这里', () => {
    assert.equal(POSIX_WRITE_CANDIDATES[0], '/srv')
    assert.equal(POSIX_WRITE_CANDIDATES.includes('/tmp'), false)
  })
})

describe('错误码登记表', () => {
  it('每个能抛出的码都在 docs/failures.md 里有处置办法', () => {
    const documented = codesInDocs()
    const missing = DP_ERROR_CODES.filter((c) => !coveredBy(documented, c))
    assert.deepEqual(
      missing,
      [],
      `这些码能抛出来但文档里查不到处置办法，逐个登记进 docs/failures.md：${missing.join(', ')}`,
    )
  })

  it('文档里登记的码不会越堆越多（只许减少，不许增加）', () => {
    const orphans = [...codesInDocs()].filter(
      (c) => !(DP_ERROR_CODES as readonly string[]).includes(c),
    )
    const unexpected = orphans.filter((c) => !KNOWN_ORPHANS.includes(c))
    assert.deepEqual(
      unexpected,
      [],
      `文档里出现了既未实现也不在预留清单里的错误码（要么实现它，要么从文档里删掉）：${unexpected.join(', ')}`,
    )
  })

  it('预留清单里不该有已经实现了的码 —— 实现了就从清单里摘掉，否则这条闸形同虚设', () => {
    const stale = KNOWN_ORPHANS.filter((c) => (DP_ERROR_CODES as readonly string[]).includes(c))
    assert.deepEqual(stale, [], `这些码已经能抛了，不该再算预留：${stale.join(', ')}`)
  })

  it('码不重复 —— 数组里出现两次说明加码时手滑', () => {
    assert.equal(new Set(DP_ERROR_CODES).size, DP_ERROR_CODES.length)
  })
})
