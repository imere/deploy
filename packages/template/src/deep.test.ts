/**
 * renderDeep：结构化配置渲染。
 *
 * 关注三件事：只动字符串叶子、返回新对象、循环引用不成环也不爆栈。
 * 最后一条不是洁癖 —— 调用方从 JS 侧传进来的对象图可能已经带环，
 * 让它栈溢出会把「配置有问题」变成一个看不出原因的报告。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { releaseVars, renderDeep, renderString } from './render.js'
import type { RenderContext } from './context.js'

const ctx: RenderContext = {
  project: 'web',
  env: 'prod',
  envVars: { PORT: '8080' },
  git: { sha: 'cafe1234' },
  release: { id: '20240102-0315', current: '/srv/web/current' },
  now: new Date('2024-01-02T03:15:00.000Z'),
}

describe('renderDeep', () => {
  it('渲染嵌套对象与数组里的字符串叶子', () => {
    const input = {
      name: '${project}',
      server: { listen: 80, host: 'api.${env}.local' },
      upstreams: [{ url: 'http://127.0.0.1:${env.PORT}' }, { url: 'http://127.0.0.1:${env.PORT}/ws' }],
    }
    const out = renderDeep(input, ctx)
    assert.deepEqual(out, {
      name: 'web',
      server: { listen: 80, host: 'api.prod.local' },
      upstreams: [{ url: 'http://127.0.0.1:8080' }, { url: 'http://127.0.0.1:8080/ws' }],
    })
  })

  it('非字符串叶子原样返回（数字、布尔、null、undefined）', () => {
    const input = { n: 1, b: true, nil: null, u: undefined, keep: '${project}' }
    const out = renderDeep(input, ctx)
    assert.equal(out.n, 1)
    assert.equal(out.b, true)
    assert.equal(out.nil, null)
    assert.equal(out.u, undefined)
    assert.equal(out.keep, 'web')
  })

  it('认不出的形状原样返回，不被 Object.entries 摊成 {}', () => {
    // Date / Map / RegExp 经 Object.entries 摊出来是空对象 —— 等于静默销毁调用方
    // 的数据，而故障要等到"配置里那个日期没了"才暴露，那时现场已被覆盖。
    const d = new Date('2026-01-01T00:00:00.000Z')
    const m = new Map([['a', '${project}']])
    const r = /x/
    const out = renderDeep({ d, m, r, keep: '${project}' }, ctx)
    assert.equal(out.d, d, 'Date 应原样返回')
    assert.equal(out.m, m, 'Map 应原样返回')
    assert.equal(out.r, r, 'RegExp 应原样返回')
    assert.equal(out.keep, 'web')
  })

  it('类实例同样原样返回', () => {
    class Cfg {
      readonly name = '${project}'
    }
    const inst = new Cfg()
    const out = renderDeep({ inst }, ctx)
    assert.equal(out.inst, inst)
  })

  it('不改原对象，返回新对象', () => {
    const input = { a: '${project}', nested: { b: '${env}' } }
    const out = renderDeep(input, ctx)
    assert.notEqual(out, input)
    assert.notEqual(out.nested, input.nested)
    assert.equal(input.a, '${project}')
    assert.equal(input.nested.b, '${env}')
  })

  it('循环引用不爆栈，已访问过的返回原引用', () => {
    interface Node {
      name: string
      self?: Node
    }
    const node: Node = { name: '${project}' }
    node.self = node
    const out = renderDeep(node, ctx)
    assert.equal(out.name, 'web')
    // 再次访问同一节点直接给回原引用，因此环保持闭合而不是无限展开
    assert.equal(out.self, node)
  })

  it('数组里的循环引用同样安全', () => {
    const arr: unknown[] = ['${project}']
    arr.push(arr)
    const out = renderDeep(arr, ctx) as unknown[]
    assert.equal(out[0], 'web')
    assert.equal(out[1], arr)
  })

  it('叶子报错时整个渲染失败（不产出半成品配置）', () => {
    assert.throws(
      () => renderDeep({ ok: '${project}', bad: '${nope}' }, ctx),
      (err: unknown) => err instanceof DpError && err.code === 'DP.TPL.UNKNOWN_VAR',
    )
  })

  it('usage 传到每个字符串叶子', () => {
    const input = { root: '${env.DIR}' }
    const bad: RenderContext = { ...ctx, envVars: { DIR: '/srv\nweb' } }
    assert.throws(
      () => renderDeep(input, bad, { usage: 'path' }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.TPL.UNSAFE_VALUE',
    )
  })
})

describe('releaseVars', () => {
  const targetCtx = { host: 'web1', root: '/srv/web', releaseId: '20240102-0315', keep: 5 }

  it('release.current 指向 <root>/current 软链，不是具体版本目录', () => {
    const vars = releaseVars(targetCtx)
    assert.equal(vars['release.current'], '/srv/web/current')
    // 指向具体版本目录的话，每次部署都得重写 conf 再 reload
    assert.notEqual(vars['release.current'], '/srv/web/releases/20240102-0315')
    assert.equal(vars['release.id'], '20240102-0315')
  })

  it('路径一律用 /，尾斜杠不产生 //', () => {
    assert.equal(releaseVars({ ...targetCtx, root: '/srv/web/' })['release.current'], '/srv/web/current')
  })

  it('结果能直接当 extra 喂回渲染', () => {
    // 返回值是「带点的键名」，形状上就是 extra 而不是 release：
    // release 只有 id / current 两个固定字段，装不下点号键。
    const out = renderString('root ${release.current};', { ...ctx, extra: releaseVars(targetCtx) })
    assert.equal(out, 'root /srv/web/current;')
    assert.equal(renderString('id=${release.id}', { ...ctx, extra: releaseVars(targetCtx) }), 'id=20240102-0315')
  })
})
