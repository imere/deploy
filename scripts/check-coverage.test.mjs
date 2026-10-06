/**
 * 覆盖率门禁的测试。
 *
 * 门禁脚本自己判错，比没有门禁更危险（它会把人推向「改对的代码」），所以这里断言的
 * 全部是行为：哪些产物算缺口、门槛怎么判、退出码怎么给 —— 而不是内部实现。
 *
 * 端到端那两例靠「把脚本复制到一个临时根目录」来造出一棵假的仓库树：脚本的根是从
 * `import.meta.url` 推出来的，换个位置就换了个根，于是可以在不动真实 `packages/**`
 * 的前提下，让真实的 CLI 对一份人造 lcov 与人造产物跑出真实退出码。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  UsageError,
  classifyArtifacts,
  evaluateCoverage,
  hasExecutableStatements,
  parseArgs,
  parseLcov,
  pkgOf,
} from './check-coverage.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const scriptPath = join(repoRoot, 'scripts', 'check-coverage.mjs')
const tmpBase = join(repoRoot, '.tmp')

/** 类型擦除后的空产物：只有空导出标记与一行 sourceMappingURL。 */
const EMPTY_ARTIFACT = 'export {};\n//# sourceMappingURL=types.js.map\n'
/** 同一个包另一种编译形态：多了指令序言，空格与分号也不统一。 */
const EMPTY_ARTIFACT_WITH_STRICT = '"use strict";\nexport {}\n//# sourceMappingURL=types.js.map\n'

const reader = (map) => (p) => {
  if (!(p in map)) throw new Error(`fixture 里没有这个产物：${p}`)
  return map[p]
}

// ---------------------------------------------------------------- 产物分类

test('空产物（export {} + sourcemap）归为纯类型，不进 noRecord', () => {
  const files = {
    'packages/core/build/types.js': EMPTY_ARTIFACT,
    'packages/core/build/logic.js': 'export const a = 1;\n',
  }
  const r = classifyArtifacts(Object.keys(files), {
    readText: reader(files),
    hasRecord: () => true,
  })
  assert.deepEqual(r.noRecord, [])
  assert.deepEqual(r.typeOnly, ['packages/core/build/types.js'])
})

test('判「有执行体」只认盘上产物本身：只有注释、空文件、纯指令序言都不算', () => {
  assert.equal(hasExecutableStatements(EMPTY_ARTIFACT), false)
  assert.equal(hasExecutableStatements(EMPTY_ARTIFACT_WITH_STRICT), false)
  assert.equal(hasExecutableStatements(''), false)
  assert.equal(hasExecutableStatements('\n\n  \n'), false)
  assert.equal(hasExecutableStatements('/** 只有注释 */\n//# sourceMappingURL=x.js.map\n'), false)
  assert.equal(hasExecutableStatements('﻿export {};\n'), false)
})

test('有执行体的产物一律算有：空导出标记之外的一切都要能识出来', () => {
  for (const code of [
    'export const a = 1;\n',
    'export {};\nexport { x } from "./y.js";\n',
    'import "./side-effect.js";\n',
    'import {} from "./still-loads.js";\n',
    '"use strict";\nObject.defineProperty(exports, "__esModule", { value: true });\n',
    'export {};\nconst s = "export {};";\n',
    '#!/usr/bin/env node\nexport {};\n',
    'export {};\nconst t = `a${b}c`;\n',
    'export {};\n/* 没闭合',
    'export {};\nconst s = "没闭合',
  ]) {
    assert.equal(hasExecutableStatements(code), true, `应判为有可执行行：${JSON.stringify(code)}`)
  }
})

test('有可执行行的产物不在 lcov 里，仍然进 noRecord', () => {
  const files = {
    'packages/core/build/logic.js': 'export const a = 1;\n',
    'packages/core/build/types.js': EMPTY_ARTIFACT,
    'packages/core/build/recorded.js': 'export const c = 3;\n',
  }
  const r = classifyArtifacts(Object.keys(files), {
    readText: reader(files),
    hasRecord: (p) => p === 'packages/core/build/recorded.js',
  })
  assert.deepEqual(r.noRecord, ['packages/core/build/logic.js'])
  assert.deepEqual(r.typeOnly, ['packages/core/build/types.js'])
})

test('读不出内容的产物按「有可执行行」处理，倾向当缺口', () => {
  const r = classifyArtifacts(['packages/core/build/gone.js'], {
    readText: () => {
      throw new Error('EACCES')
    },
    hasRecord: () => false,
  })
  assert.deepEqual(r.noRecord, ['packages/core/build/gone.js'])
  assert.deepEqual(r.typeOnly, [])
})

// ---------------------------------------------------------------- lcov 与门槛判定

const lcovOf = (entries) =>
  entries
    .map(
      (e) =>
        `SF:${e.file}\nDA:${e.lines.map((n, i) => `${n},${e.hit.includes(n) ? 1 : 0}`).join('\n')}\n` +
        `LF:${e.lines.length}\nLH:${e.lines.filter((n) => e.hit.includes(n)).length}\nend_of_record`,
    )
    .join('\n') + '\n'

test('lcov 解析：取 SF/LF/LH/DA，反斜杠路径归一，末尾缺 end_of_record 不丢最后一条', () => {
  const text = 'SF:packages\\core\\build\\a.js\nDA:1,0\nDA:2,1\nLF:2\nLH:1\nend_of_record\nSF:packages/core/build/b.js\nLF:1\nLH:1'
  const recs = parseLcov(text)
  assert.equal(recs.length, 2)
  assert.equal(recs[0].file, 'packages/core/build/a.js')
  assert.deepEqual(recs[0].missed, [1])
  assert.equal(recs[0].lf, 2)
  assert.equal(recs[0].lh, 1)
  assert.equal(recs[1].file, 'packages/core/build/b.js')
  assert.equal(pkgOf('packages/core/build/a.js'), 'core')
  assert.equal(pkgOf('scripts/check-coverage.mjs'), null)
})

test('受门禁包有 noRecord 时判失败；没有 noRecord 时才按覆盖率判', () => {
  const onDisk = ['packages/core/build/logic.js', 'packages/core/build/types.js']
  const artifacts = {
    'packages/core/build/logic.js': 'export const a = 1;\n',
    'packages/core/build/types.js': EMPTY_ARTIFACT,
  }
  const full = evaluateCoverage({
    lcovText: lcovOf([{ file: 'packages/core/build/logic.js', lines: [1, 2], hit: [1, 2] }]),
    onDisk,
    readText: reader(artifacts),
    thresholds: { core: 100 },
    gated: { core: 100 },
  })
  assert.equal(full.rows[0].verdict, '达标')
  assert.equal(full.failed.length, 0)
  assert.deepEqual(full.typeOnly, ['packages/core/build/types.js'])

  // 有执行体但 lcov 无记录：即使行覆盖率满分也判失败
  const orphan = evaluateCoverage({
    lcovText: lcovOf([{ file: 'packages/core/build/logic.js', lines: [1, 2], hit: [1, 2] }]),
    onDisk: [...onDisk, 'packages/core/build/orphan.js'],
    readText: reader({ ...artifacts, 'packages/core/build/orphan.js': 'export const b = 2;\n' }),
    thresholds: { core: 100 },
    gated: { core: 100 },
  })
  assert.equal(orphan.rows[0].pct, 100)
  assert.equal(orphan.rows[0].pass, false)
  assert.match(orphan.rows[0].verdict, /1 个产物在 lcov 里无记录/)
  assert.deepEqual(orphan.noRecord, ['packages/core/build/orphan.js'])

  // 覆盖率不够同样判失败，且理由与「无记录」可区分
  const partial = evaluateCoverage({
    lcovText: lcovOf([{ file: 'packages/core/build/logic.js', lines: [1, 2], hit: [1] }]),
    onDisk,
    readText: reader(artifacts),
    thresholds: { core: 100 },
    gated: { core: 100 },
  })
  assert.equal(partial.rows[0].pass, false)
  assert.match(partial.rows[0].verdict, /差 1 行/)
  assert.deepEqual(partial.noRecord, [])
})

test('门槛里写了不存在的包名也要出现在表里，且不被算成通过', () => {
  const r = evaluateCoverage({
    lcovText: lcovOf([]),
    onDisk: [],
    readText: () => '',
    thresholds: { nosuch: 100 },
    gated: { nosuch: 100 },
  })
  assert.deepEqual(
    r.rows.map((x) => x.name),
    ['nosuch'],
  )
  assert.equal(r.rows[0].pass, false)
  assert.equal(r.rows[0].verdict, '未达标（无可执行行记录）')
})

// ---------------------------------------------------------------- 参数

test('--threshold 解析：空格与等号两种写法都收，包名进入门槛表', () => {
  const a = parseArgs(['--threshold', 'core=100', '--json'])
  assert.equal(a.asJson, true)
  assert.equal(a.thresholds.core, 100)
  const b = parseArgs(['--threshold=core=99.5'])
  assert.equal(b.thresholds.core, 99.5)
  assert.equal(b.asJson, false)
  // 未指定时保留内置门槛
  assert.equal(parseArgs([]).thresholds.schema, 100)
})

test('--threshold 的值不会被当成游离参数', () => {
  assert.doesNotThrow(() => parseArgs(['--threshold', 'log=50']))
  assert.doesNotThrow(() => parseArgs(['--json', '--threshold', 'log=50']))
  // 值本身就是下一个选项时，缺值仍要报错而不是把选项名当包名
  assert.throws(() => parseArgs(['--threshold', '--json']), UsageError)
})

test('非法门槛与未知参数都抛 UsageError，理由各归各', () => {
  for (const argv of [
    ['--threshold', 'core'],
    ['--threshold', 'core=abc'],
    ['--threshold', 'core=101'],
    ['--threshold=core=100.1'],
    ['--threshold'],
  ]) {
    assert.throws(() => parseArgs(argv), UsageError, `应拒绝：${argv.join(' ')}`)
  }
  assert.throws(() => parseArgs(['--nope']), (err) => err instanceof UsageError && /未知参数/.test(err.text))
  // 门槛先于未知参数：同一个 argv 不给两个理由
  assert.throws(
    () => parseArgs(['--nope', '--threshold', 'core=101']),
    (err) => /门槛无法解析/.test(err.text),
  )
})

// ---------------------------------------------------------------- 端到端

/**
 * 回收临时根。带 try/catch 是因为沙箱里的 fs 代理可能拒绝对一棵大树做递归删除 ——
 * 拒了就留在 `.tmp/` 下（已 gitignore），而每次跑用的目录名都不同，残留不会串进下一次。
 */
const dispose = (dir) => {
  try {
    dispose(dir)
  } catch {
    /* 留着即可：唯一目录名保证下次跑看不到它 */
  }
}

/**
 * 端到端用例在派生不了子进程的环境里整体跳过，而不是判失败。
 *
 * 有些 Windows 沙箱里 `spawnSync` 连 `process.execPath` 都起不来（实测 EBUSY，
 * 与派谁无关）。那是环境不可用，不是门禁行为错了 —— 报成断言失败会把环境问题
 * 伪装成脚本缺陷，改成静默通过又等于这条用例从此不生效。跳过并写明原因，
 * 是唯一既不假红也不假绿的处理。
 */
const SPAWN_UNAVAILABLE = Symbol('spawn-unavailable')

function etest(name, fn) {
  test(name, (t) => {
    try {
      return fn(t)
    } catch (err) {
      if (err && err[SPAWN_UNAVAILABLE]) {
        t.skip(`本环境派生不了子进程（${err.message}），端到端用例跳过`)
        return
      }
      throw err
    }
  })
}

/** 跑一次真实 CLI；派生失败时抛出带 SPAWN_UNAVAILABLE 标记的错误交给 etest 跳过。 */
function spawnCli(script, argv = []) {
  const r = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8' })
  if (r.error) {
    const err = new Error(r.error.code ?? r.error.message)
    err[SPAWN_UNAVAILABLE] = true
    throw err
  }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

/** 造一棵假仓库：复制脚本到临时根，写入 lcov 与产物，然后跑真实的 CLI。 */
function runCli({ lcov, artifacts }) {
  const dir = mkdtempSync(join(tmpBase, 'check-coverage-'))
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'build', 'coverage'), { recursive: true })
    writeFileSync(join(dir, 'build', 'coverage', 'lcov.info'), lcov)
    for (const [rel, text] of Object.entries(artifacts)) {
      const abs = join(dir, ...rel.split('/'))
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, text)
    }
    const script = join(dir, 'scripts', 'check-coverage.mjs')
    copyFileSync(scriptPath, script)
    const run = (...argv) => spawnCli(script, argv)
    return { run, dir }
  } catch (err) {
    dispose(dir)
    throw err
  }
}

/** 三个受门禁的包各带一份被全覆盖的 logic.js：门槛 100% 本该全过，调用方只加自己要验的产物。 */
const GATED_PKGS = ['schema', 'core', 'template']

function fixtureInputs(extra = {}) {
  const artifacts = {}
  const entries = []
  for (const p of GATED_PKGS) {
    artifacts[`packages/${p}/build/logic.js`] = 'export const a = 1;\n'
    entries.push({ file: `packages/${p}/build/logic.js`, lines: [1], hit: [1] })
  }
  return { lcov: lcovOf(entries), artifacts: { ...artifacts, ...extra } }
}

etest('端到端：受门禁包里只有纯类型产物时，退出 0 且 missingRecords 为空', () => {
  mkdirSync(tmpBase, { recursive: true })
  const { run, dir } = runCli(
    fixtureInputs({
      'packages/core/build/types.js': EMPTY_ARTIFACT,
      'packages/schema/build/types.js': EMPTY_ARTIFACT_WITH_STRICT,
    }),
  )
  try {
    const r = run('--json')
    assert.equal(r.code, 0, r.stderr)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.lcov.missingRecords, [])
    assert.deepEqual(out.lcov.typeOnlyArtifacts, [
      'packages/core/build/types.js',
      'packages/schema/build/types.js',
    ])
    assert.equal(out.summary.failed, 0)
    assert.equal(out.summary.passed, 3)

    const text = run()
    assert.equal(text.code, 0)
    assert.match(text.stdout, /纯类型产物 2 个/)
    assert.doesNotMatch(text.stdout, /lcov 缺记录的盘上产物/)
    assert.match(text.stdout, /结论：通过/)
  } finally {
    dispose(dir)
  }
})

etest('端到端：受门禁包里有执行体却无记录时，退出 1 且该文件进 missingRecords', () => {
  mkdirSync(tmpBase, { recursive: true })
  const { run, dir } = runCli(
    fixtureInputs({
      'packages/core/build/types.js': EMPTY_ARTIFACT,
      'packages/core/build/orphan.js': 'export const b = 2;\n',
    }),
  )
  try {
    const r = run('--json')
    assert.equal(r.code, 1)
    const out = JSON.parse(r.stdout)
    assert.deepEqual(out.lcov.missingRecords, ['packages/core/build/orphan.js'])
    assert.deepEqual(out.lcov.typeOnlyArtifacts, ['packages/core/build/types.js'])
    assert.equal(out.summary.failed, 1)
    assert.equal(out.summary.passed, 2)
    assert.equal(out.exitCode, 1)
    assert.equal(out.packages.find((p) => p.name === 'core').verdict, '未达标（1 个产物在 lcov 里无记录）')

    const text = run()
    assert.equal(text.code, 1)
    assert.match(text.stdout, /orphan\.js\s+无记录/)
    assert.match(text.stdout, /结论：未通过（core）/)
    // 纯类型产物仍然要被列出来，不能因为不判缺口就静默丢掉
    assert.match(text.stdout, /纯类型产物 1 个/)
  } finally {
    dispose(dir)
  }
})

etest('端到端：参数用错走退出码 2，与门禁的 0/1 分开', () => {
  mkdirSync(tmpBase, { recursive: true })
  const { run, dir } = runCli(fixtureInputs())
  try {
    const unknown = run('--nope')
    assert.equal(unknown.code, 2)
    assert.match(unknown.stderr, /未知参数：--nope/)

    const bad = run('--threshold', 'core=101')
    assert.equal(bad.code, 2)
    assert.match(bad.stderr, /门槛无法解析/)

    // 门槛真的生效（空格写法），且退出码仍是门禁自己的 0/1
    const ok = run('--json', '--threshold', 'core=50')
    assert.equal(ok.code, 0, ok.stderr)
    assert.equal(JSON.parse(ok.stdout).packages.find((p) => p.name === 'core').threshold, 50)
  } finally {
    dispose(dir)
  }
})

etest('端到端：--threshold=包名=数值 的等号写法也认，且不被当成游离参数', () => {
  mkdirSync(tmpBase, { recursive: true })
  const { run, dir } = runCli(fixtureInputs())
  try {
    const r = run('--json', '--threshold=core=50')
    assert.equal(r.code, 0, r.stderr)
    assert.equal(JSON.parse(r.stdout).packages.find((p) => p.name === 'core').threshold, 50)
  } finally {
    dispose(dir)
  }
})

etest('端到端：读不到 lcov 走退出码 1，且不给覆盖率编数字', () => {
  mkdirSync(tmpBase, { recursive: true })
  const dir = mkdtempSync(join(tmpBase, 'check-coverage-'))
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    mkdirSync(join(dir, 'packages'), { recursive: true })
    const script = join(dir, 'scripts', 'check-coverage.mjs')
    copyFileSync(scriptPath, script)
    const r = spawnCli(script)
    assert.equal(r.code, 1)
    assert.match(r.stderr, /读不到 build\/coverage\/lcov\.info/)
  } finally {
    dispose(dir)
  }
})
