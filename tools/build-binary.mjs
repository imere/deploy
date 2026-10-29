/**
 * 把命令行打成单文件可执行程序。
 *
 * 为什么不打包成「一个 JS 文件」：本仓默认阻断全部依赖构建脚本，而主流打包器
 * （esbuild 等）恰恰靠 postinstall 去装平台二进制 —— 装不上，且给它开口子与
 * 供应链立场冲突。所以这里反过来做：**不打包**，把编译产物整棵作为资源嵌进
 * 运行时二进制，启动时落到缓存目录再按 ESM 原样加载。代价是首次启动要落一次盘，
 * 换来的产物行为与 `node packages/cli/dist/lib/bin.js` 完全一致 —— 没有第二套
 * 模块解析规则，也就不存在「源码跑得对、打包后跑不对」这种分叉。
 *
 * 用法：node tools/build-binary.mjs [--target <platform>-<arch>]
 * 产物：dist/bin/dp-<platform>-<arch>[.exe]
 */
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inject } from 'postject'

const ROOT = resolve(import.meta.dirname, '..')
const WORK = join(ROOT, 'dist', 'bin-work')
const OUT_DIR = join(ROOT, 'dist', 'bin')

/**
 * 从运行时二进制里读出 SEA 哨兵，而不是写死一个常量。
 * 这个字符串是「此二进制是否已注入」的开关位，不同构建里的字面值并不一致
 * （实测本机的运行时里就不是文档示例里那一个），写死的后果是注入时报
 * 「找不到哨兵」，而真正的错因是猜错了字符串。
 */
function findSeaFuse(exePath) {
  const buf = readFileSync(exePath)
  const at = buf.indexOf('NODE_SEA_FUSE_')
  if (at < 0) throw new Error(`这个运行时二进制不支持单文件产物（没有 SEA 哨兵）：${exePath}`)
  const found = /^NODE_SEA_FUSE_[0-9a-f]+/.exec(buf.subarray(at, at + 128).toString('latin1'))
  if (found === null) throw new Error(`SEA 哨兵形状不对，拒绝猜：${exePath}`)
  return found[0]
}

function argValue(name) {
  const at = process.argv.indexOf(name)
  if (at === -1) return undefined
  const value = process.argv[at + 1]
  // 写了选项名却没给值：用户以为自己指定了平台，按当前平台默默产出就是骗人
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${name} 缺值：要写 ${name} <platform>-<arch>`)
  }
  return value
}

/**
 * 自检：只生成文件不算构建成功，跑不起来就是坏产物。
 *
 * 跑两条而不是一条：`--version` 只证明「注入成功 + 资源能解 + ESM 能加载」，
 * `--help` 才会把全部包都 import 一遍 —— 少一条就漏掉「入口起来了、包加载崩了」。
 */
function selfCheck(exe, VERSION) {
  for (const argv of [['--version'], ['--help']]) {
    const label = argv.join(' ')
    const run = spawnSync(exe, argv, { encoding: 'utf8', timeout: 60_000 })
    if (run.error !== undefined) {
      // 起不了子进程不是产物的错，但也绝不能当成自检通过 —— 那等于把一次没做的
      // 验证记成已验证
      return { ok: false, why: `${label} 起不了子进程：${run.error.message}（未验证）` }
    }
    if (run.status !== 0) {
      return { ok: false, why: `${label} 退出码 ${run.status}，stderr=${run.stderr ?? ''}` }
    }
    const out = (run.stdout ?? '').trim()
    if (out === '') return { ok: false, why: `${label} 没有输出` }
    if (argv[0] === '--version') {
      // 严格相等而不是包含：差一个字符的脏输出也得算失败
      if (out !== VERSION) return { ok: false, why: `--version 输出 ${JSON.stringify(out)}，期望 ${VERSION}` }
      return { ok: true, version: out }
    }
  }
  return { ok: true, version: VERSION }
}

async function collect(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await collect(full)))
    else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) out.push(full)
  }
  return out
}

async function main() {
  const target = argValue('--target') ?? `${process.platform}-${process.arch}`
  if (target !== `${process.platform}-${process.arch}`) {
    // 声称产出别的平台的产物，等于交付一个跑不起来的文件。跨构建要先拿到那台
    // 机器的运行时二进制并校验完整性 —— 交给 CI 矩阵在本平台上各出一次更省事
    throw new Error(
      `只能为当前平台（${process.platform}-${process.arch}）产出，请求的是 ${target}。` +
        '别的平台请在那个平台上跑一次本脚本，或交给 CI 矩阵。',
    )
  }

  const { VERSION } = await import(pathToFileURL(join(ROOT, 'packages/cli/dist/lib/index.js')).href)

  const packages = []
  for (const entry of await readdir(join(ROOT, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(ROOT, 'packages', entry.name)
    const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name
    const files = (await stat(join(dir, 'dist', 'lib')).catch(() => null)) === null
      ? []
      : await collect(join(dir, 'dist', 'lib'))
    if (files.length === 0) continue
    packages.push({ name, dir, files })
  }
  if (packages.length === 0) throw new Error('packages/*/dist/lib 是空的，先跑 pnpm build')

  const entryName = '@dp/cli'
  if (!packages.some((p) => p.name === entryName)) throw new Error(`找不到 ${entryName} 的编译产物`)

  // 资源键直接铺成 node_modules 的形状，落盘后不加任何链接就能被 ESM 解析到
  const assets = {}
  const hash = createHash('sha256')
  for (const pkg of packages) {
    for (const file of pkg.files) {
      const inBuild = relative(join(pkg.dir, 'dist', 'lib'), file).split('\\').join('/')
      const key = `node_modules/${pkg.name}/dist/lib/${inBuild}`
      assets[key] = file
      hash.update(key).update(readFileSync(file))
    }
  }

  const manifest = {
    version: VERSION,
    hash: hash.digest('hex'),
    entry: `node_modules/${entryName}/dist/lib/bin.js`,
    packages: packages.map((p) => p.name),
  }
  assets['dp-manifest.json'] = join(WORK, 'dp-manifest.json')

  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  writeFileSync(assets['dp-manifest.json'], `${JSON.stringify(manifest)}\n`)
  const bootstrap = join(WORK, 'bootstrap.cjs')
  writeFileSync(bootstrap, BOOTSTRAP)
  const configPath = join(WORK, 'sea-config.json')
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        main: bootstrap,
        output: join(WORK, 'sea-prep.blob'),
        // 代码缓存与快照都绑定架构与运行时版本，开了就失去「同一份 blob 到处能注」的性质
        useCodeCache: false,
        useSnapshot: false,
        disableExperimentalSEAWarning: true,
        assets,
      },
      null,
      2,
    )}\n`,
  )

  execFileSync(process.execPath, ['--experimental-sea-config', configPath], { stdio: 'inherit' })

  const exe = join(OUT_DIR, `dp-${target}${process.platform === 'win32' ? '.exe' : ''}`)
  mkdirSync(OUT_DIR, { recursive: true })
  rmSync(exe, { force: true })
  copyFileSync(process.execPath, exe)
  await inject(exe, 'NODE_SEA_BLOB', readFileSync(join(WORK, 'sea-prep.blob')), {
    sentinelFuse: findSeaFuse(exe),
  })

  const check = selfCheck(exe, VERSION)
  if (!check.ok) {
    // 坏产物不能躺在交付目录里等下一次构建把它捡走 —— 改名，现场留在 bin-work
    const bad = `${exe}.unverified`
    rmSync(bad, { force: true })
    renameSync(exe, bad)
    throw new Error(`自检失败：${check.why}。产物已改名 ${bad}，构建现场在 ${WORK}`)
  }
  process.stdout.write(`✓ ${exe}（${(await stat(exe)).size} 字节）--version → ${check.version}\n`)
}

/** 产物里的入口。它在单文件产物内部运行，读资源、落盘、再把真正的入口 import 进来 */
const BOOTSTRAP = `'use strict'
const { isSea, getAssetKeys, getRawAsset } = require('node:sea')
const { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } = require('node:fs')
const { dirname, join } = require('node:path')
const { homedir, tmpdir } = require('node:os')
const { pathToFileURL } = require('node:url')

if (!isSea()) {
  process.stderr.write('这个入口只在单文件产物内部运行；源码模式请直接用 node packages/cli/dist/lib/bin.js\\n')
  process.exit(1)
}

// getRawAsset 给的是 ArrayBuffer，它的 toString 是 "[object ArrayBuffer]" —— 直接
// 拿去 JSON.parse 会炸在一个看不懂的位置上，一律先过 Buffer
const raw = (key) => Buffer.from(getRawAsset(key))
const manifest = JSON.parse(raw('dp-manifest.json').toString('utf8'))
const keys = getAssetKeys().filter((k) => k !== 'dp-manifest.json')

// 只读的家目录不该让整个产物起不来：家目录建不出来就退到临时目录；
// 显式指定了 DP_SEA_CACHE 就不退 —— 指定了还悄悄换地方，等于没指定
function pickBase() {
  const override = process.env.DP_SEA_CACHE
  if (override !== undefined && override !== '') {
    mkdirSync(override, { recursive: true })
    return override
  }
  const home = homedir()
  if (home !== '') {
    try {
      const candidate = join(home, '.cache', 'dp-sea')
      mkdirSync(candidate, { recursive: true })
      return candidate
    } catch {}
  }
  return join(tmpdir(), 'dp-sea')
}

let base
try {
  base = pickBase()
} catch (err) {
  process.stderr.write('解包目录建不出来：' + (err && err.message ? err.message : err) + '\\n')
  process.exit(1)
}

// 内容定死 → 目录可以用内容哈希做键；标记文件在，说明这一版已经完整落过盘
const dir = join(base, manifest.hash.slice(0, 16))
if (!existsSync(join(dir, '.dp-ok'))) {
  const staging = dir + '.partial-' + process.pid
  rmSync(staging, { recursive: true, force: true })
  for (const key of keys) {
    const target = join(staging, key)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, raw(key))
  }
  for (const name of manifest.packages) {
    mkdirSync(join(staging, 'node_modules', name), { recursive: true })
    writeFileSync(
      join(staging, 'node_modules', name, 'package.json'),
      JSON.stringify({
        name: name,
        version: manifest.version,
        type: 'module',
        exports: { '.': { default: './dist/lib/index.js' } },
      }),
    )
  }
  // 校验一遍再换正：只写一半就当成可用，是这类自解压最容易出的假成功
  try {
    for (const key of keys) {
      if (!existsSync(join(staging, key))) {
        process.stderr.write('落盘不完整，放弃：' + key + '\\n')
        process.exit(1)
      }
    }
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dirname(dir), { recursive: true })
    renameSync(staging, dir)
    writeFileSync(join(dir, '.dp-ok'), String(Date.now()))
  } catch (err) {
    // 家目录与临时目录都不可写时走到这里。不接住的话抛的是一串栈，看不出该改什么
    process.stderr.write(
      '解包失败，写不进缓存目录：' + (err && err.message ? err.message : err) +
        '\\n  想换一个位置就设 DP_SEA_CACHE\\n',
    )
    process.exit(1)
  }
}

import(pathToFileURL(join(dir, manifest.entry)).href).catch((err) => {
  process.stderr.write('启动失败：' + (err && err.stack ? err.stack : err) + '\\n')
  process.exit(1)
})
`

await main()
