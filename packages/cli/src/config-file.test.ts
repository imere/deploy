import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DpError } from '@dp/ports'
import {
  CONFIG_FILENAMES,
  findConfigUpwards,
  loadConfig,
  loadConfigFile,
  loaderKindFor,
  resolveConfigPath,
  validateConfig,
} from './config-file.js'

/** 临时目录必须清干净 —— 测试不许在系统里留垃圾（铁律 4 的延伸） */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'dp-cli-cfg-'))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

const VALID = {
  hosts: { local: { local: true } },
  projects: { web: { source: { root: './dist' } } },
}

describe('config-file · 扩展名分流（纯）', () => {
  it('.json 走 JSON.parse，其余走动态 import', () => {
    assert.equal(loaderKindFor('a.json'), 'json')
    assert.equal(loaderKindFor('a.ts'), 'module')
    assert.equal(loaderKindFor('a.js'), 'module')
    assert.equal(loaderKindFor('a.mjs'), 'module')
  })
})

describe('config-file · 优先级判定（纯函数，不碰文件系统）', () => {
  const cwd = '/work'

  it('-c 最高，且不与自动发现冲突时报明确来源', () => {
    const r = resolveConfigPath({ cwd, explicit: 'a.json' })
    // 用 resolve 而不是写死 POSIX 字符串：Windows 上 '/work' 会被解析到当前盘符
    assert.equal(r?.path, resolve(cwd, 'a.json'))
    assert.equal(r?.source, 'explicit')
  })

  it('-c 与自动发现指向同一个文件不算冲突', () => {
    const r = resolveConfigPath({ cwd, explicit: 'a.json', discovered: join('/work', 'a.json') })
    assert.equal(r?.source, 'explicit')
  })

  it('-c 与自动发现指向不同文件 → 明确报错（不静默选一个）', () => {
    const err = caughtThrows(
      () => resolveConfigPath({ cwd, explicit: 'a.json', discovered: '/other/b.json' }),
    ) as DpError
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.path, '--config')
    assert.match(err.hint ?? '', /两者都处理掉/)
  })

  it('没有 -c 时 DP_CONFIG 优先于自动发现', () => {
    const r = resolveConfigPath({ cwd, envValue: 'env.json', discovered: '/work/b.json' })
    assert.equal(r?.source, 'env')
  })

  it('都没有时用自动发现', () => {
    assert.equal(resolveConfigPath({ cwd, discovered: '/work/b.json' })?.source, 'discovered')
  })

  it('一个都没有 → undefined，交给上层报「找不到」', () => {
    assert.equal(resolveConfigPath({ cwd }), undefined)
  })

  it('Windows 下大小写不同的同一个路径不算冲突', () => {
    const same = process.platform === 'win32' ? 'C:/Work/A.json' : '/work/a.json'
    const other = process.platform === 'win32' ? 'c:\\work\\a.json' : '/work/a.json'
    const r = resolveConfigPath({ cwd: same, explicit: other, discovered: other })
    assert.equal(r?.source, 'explicit')
  })
})

describe('config-file · 自动发现向上冒泡', () => {
  it('从子目录向上找到 git 根里的配置', async () => {
    await withTempDir(async (dir) => {
      await fs.mkdir(join(dir, '.git'))
      await fs.mkdir(join(dir, 'a', 'b'), { recursive: true })
      await fs.writeFile(join(dir, CONFIG_FILENAMES[2] as string), JSON.stringify(VALID), 'utf8')
      assert.equal(findConfigUpwards(join(dir, 'a', 'b')), join(dir, CONFIG_FILENAMES[2] as string))
      // 到 git 根就停：根以上不再找
      assert.equal(findConfigUpwards(join(dir, '..')), undefined)
    })
  })

  it('ts 优先于 js 优先于 json', async () => {
    await withTempDir(async (dir) => {
      for (const name of CONFIG_FILENAMES) await fs.writeFile(join(dir, name), '{}', 'utf8')
      assert.equal(findConfigUpwards(dir), join(dir, 'deploy.config.ts'))
    })
  })
})

describe('config-file · 加载', () => {
  it('.json 正常加载', async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, 'deploy.config.json')
      await fs.writeFile(p, JSON.stringify(VALID), 'utf8')
      assert.deepEqual(await loadConfigFile(p), VALID)
    })
  })

  it('.json 语法错 → 明确错误 + 建议', async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, 'bad.json')
      await fs.writeFile(p, '{ "a": 1, }', 'utf8')
      const err = (await caughtRejects(loadConfigFile(p))) as DpError
      assert.equal(err.code, 'DP.CONFIG.INVALID')
      assert.match(err.hint ?? '', /deploy\.config\.ts/)
    })
  })

  it('.mjs 走动态 import 且取 default', async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, 'cfg.mjs')
      await fs.writeFile(p, 'export default { a: 1 }', 'utf8')
      assert.deepEqual(await loadConfigFile(p), { a: 1 })
    })
  })

  it('.mjs 加载失败 → 明确错误，且带上 Node 的话', async () => {
    await withTempDir(async (dir) => {
      const p = join(dir, 'broken.mjs')
      await fs.writeFile(p, 'throw new Error("故意炸")', 'utf8')
      const err = (await caughtRejects(loadConfigFile(p))) as DpError
      assert.match(err.hint ?? '', /故意炸/)
    })
  })
})

describe('config-file · 校验', () => {
  it('合法配置通过', () => {
    assert.ok(validateConfig(VALID, 'x.json').projects['web'])
  })

  it('必填字段缺失 → 带 path 的 DpError', () => {
    const err = caughtThrows(() => validateConfig({ hosts: {} }, 'x.json')) as DpError
    assert.equal(err.code, 'DP.CONFIG.INVALID')
    assert.equal(err.path, 'config.projects')
  })

  it('字段类型错 → path 指到具体字段', () => {
    const err = caughtThrows(() => validateConfig({ projects: { web: { source: { root: 1 } } } }, 'x.json')) as DpError
    assert.equal(err.path, 'config.projects.web.source.root')
  })

  it('未知字段被拒（拼错要立刻发现）', () => {
    caughtThrows(() => validateConfig({ projects: { web: { source: { root: './d' } } }, typo: 1 }, 'x.json'))
  })

  it('尾斜杠这种歧义写法在 schema 层就被拒', () => {
    const err = caughtThrows(() => validateConfig({ projects: { web: { source: { root: './dist/' } } } }, 'x.json')) as DpError
    assert.match(err.hint ?? '', /歧义|\*\*/)
  })

  it('校验失败时 hint 指向 dp schema', () => {
    const err = caughtThrows(() => validateConfig({}, 'x.json')) as DpError
    assert.match(err.hint ?? '', /dp schema/)
  })
})

describe('config-file · release.root 归一化', () => {
  it('相对路径按 cwd 解析成绝对路径（探测的 key 与查询的 key 必须一致）', async () => {
    await withTempDir(async (dir) => {
      const cfg = {
        hosts: { local: { local: true } },
        projects: { web: { source: { root: './dist' }, release: { root: './srv' } } },
      }
      await fs.writeFile(join(dir, 'deploy.config.json'), JSON.stringify(cfg), 'utf8')
      const loaded = await loadConfig({ cwd: dir, env: {} })
      const root = loaded.config.projects['web']?.release?.root
      assert.equal(root, join(dir, 'srv'), '相对 release.root 必须是绝对路径')
    })
  })

  it('绝对路径原样保留', async () => {
    await withTempDir(async (dir) => {
      const abs = join(dir, 'abs-srv')
      const cfg = {
        hosts: { local: { local: true } },
        projects: { web: { source: { root: './dist' }, release: { root: abs } } },
      }
      await fs.writeFile(join(dir, 'deploy.config.json'), JSON.stringify(cfg), 'utf8')
      const loaded = await loadConfig({ cwd: dir, env: {} })
      assert.equal(loaded.config.projects['web']?.release?.root, abs)
    })
  })

  it('没写 release.root 时不凭空造一个', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(join(dir, 'deploy.config.json'), JSON.stringify(VALID), 'utf8')
      const loaded = await loadConfig({ cwd: dir, env: {} })
      assert.equal(loaded.config.projects['web']?.release?.root, undefined)
    })
  })
})

describe('config-file · 端到端发现（真实 IO）', () => {
  it('自动发现 + 校验成功', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(join(dir, 'deploy.config.json'), JSON.stringify(VALID), 'utf8')
      const loaded = await loadConfig({ cwd: dir, env: {} })
      assert.equal(loaded.source, 'discovered')
      assert.deepEqual(Object.keys(loaded.config.projects), ['web'])
    })
  })

  it('-c 指到不存在的文件 → 明确报错，hint 说清路径怎么来的', async () => {
    await withTempDir(async (dir) => {
      const err = (await caughtRejects(loadConfig({ cwd: dir, explicit: 'nope.json', env: {} }))) as DpError
      assert.equal(err.path, '--config')
      assert.match(err.hint ?? '', /nope\.json/)
      assert.match(err.hint ?? '', /cwd=/)
    })
  })

  it('DP_CONFIG 指向不存在的文件 → 明确报错，hint 指向环境变量', async () => {
    await withTempDir(async (dir) => {
      const err = (await caughtRejects(loadConfig({ cwd: dir, env: { DP_CONFIG: 'gone.json' } }))) as DpError
      assert.equal(err.path, 'DP_CONFIG')
    })
  })

  it('一个配置都找不到 → 三种来源都写进 hint', async () => {
    await withTempDir(async (dir) => {
      const err = (await caughtRejects(loadConfig({ cwd: dir, env: {} }))) as DpError
      assert.match(err.hint ?? '', /--config/)
      assert.match(err.hint ?? '', /DP_CONFIG/)
      assert.match(err.hint ?? '', /deploy\.config\.ts/)
    })
  })

  it('-c 与自动发现冲突 → 报错而不是静默选一个', async () => {
    await withTempDir(async (dir) => {
      // 必须有 .git：自动发现到 git 根为止，否则会一路冒到盘符根（tmpdir 在 F: 下）
      await fs.mkdir(join(dir, '.git'))
      await fs.mkdir(join(dir, 'sub'))
      await fs.writeFile(join(dir, 'deploy.config.json'), JSON.stringify(VALID), 'utf8')
      const other = join(dir, 'other.json')
      await fs.writeFile(other, JSON.stringify(VALID), 'utf8')
      const err = (await caughtRejects(loadConfig({ cwd: join(dir, 'sub'), explicit: other, env: {} }))) as DpError
      assert.match(err.hint ?? '', /两者都处理掉/)
    })
  })

  it('.mjs 配置能被发现、加载并通过校验', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(join(dir, 'deploy.config.js'), `export default ${JSON.stringify(VALID)}`, 'utf8')
      const loaded = await loadConfig({ cwd: dir, env: {} })
      assert.equal(loaded.source, 'discovered')
      assert.ok(loaded.config.projects['web'])
    })
  })
})

// assert.throws/rejects 在本仓的 @types/node 下返回 void，拿不到错误对象。
// 统一走这两个 helper：类型上直接是 DpError。
function caughtThrows(fn: () => unknown, _ctor?: unknown): DpError {
  try {
    fn()
  } catch (err) {
    return err as DpError
  }
  throw new Error('期望抛错，但没有')
}
async function caughtRejects(p: Promise<unknown>): Promise<DpError> {
  try {
    await p
  } catch (err) {
    return err as DpError
  }
  throw new Error('期望 reject，但没有')
}
