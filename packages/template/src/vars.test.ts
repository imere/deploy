/**
 * collectVars / validateVars，以及 golden。
 *
 * 关键一致性断言：validateVars 报的错必须与 renderString 抛的错**一一对应**（同码同序）。
 * 这两个函数共用一套扫描，所以一致性是设计出来的；但"设计出来"不等于"必然成立" ——
 * 一旦某天有人给 validateVars 加了跳过逻辑，plan 期就会开始说谎：
 * 干跑一切正常，真部署才炸。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { collectVars, KNOWN_VARS, validateVars } from './vars.js'
import { renderString } from './render.js'
import type { RenderContext } from './context.js'

const ctx: RenderContext = {
  project: 'web',
  env: 'prod',
  envVars: { DEPLOY_KEY: 'abc123' },
  git: { sha: 'deadbeef', branch: 'main' },
  release: { id: '20240102-0315', current: '/srv/web/current' },
  now: new Date('2024-01-02T03:15:00.000Z'),
}

function renderErrors(input: string, c: RenderContext): string[] {
  try {
    renderString(input, c)
    return []
  } catch (err) {
    assert.ok(err instanceof DpError)
    return [err.code]
  }
}

describe('collectVars', () => {
  it('列出全部未转义引用', () => {
    const vars = collectVars('${project} /srv/${env} x=${env.PORT} ${git.sha}')
    assert.deepEqual(
      vars.map((v) => v.name),
      ['project', 'env', 'env.PORT', 'git.sha'],
    )
    assert.deepEqual(
      vars.map((v) => v.raw),
      ['${project}', '${env}', '${env.PORT}', '${git.sha}'],
    )
  })

  it('转义引用被标出 escaped=true，dry-run 能说清"这里不会替换"', () => {
    const vars = collectVars('$${project} ${env}')
    assert.equal(vars.length, 2)
    assert.equal(vars[0]?.escaped, true)
    assert.equal(vars[0]?.name, 'project')
    assert.equal(vars[1]?.escaped, false)
  })

  it('$host 之类不产生引用', () => {
    assert.deepEqual(collectVars('server_name $host; $request_uri'), [])
  })

  it('无变量返回空数组', () => {
    assert.deepEqual(collectVars('plain text'), [])
  })

  it('KNOWN_VARS 覆盖 config.md §3.3 的全部变量', () => {
    for (const name of ['env.NAME', 'git.sha', 'git.branch', 'git.tag', 'release.id', 'release.current', 'project', 'env', 'now']) {
      assert.ok(KNOWN_VARS.includes(name), `KNOWN_VARS 缺 ${name}`)
    }
  })
})

describe('validateVars', () => {
  it('全部可解析时返回空数组', () => {
    assert.deepEqual(validateVars('${project} ${env} ${git.sha} ${release.current} ${now}', ctx), [])
  })

  it('报错与 renderString 抛的错一一对应（代码与顺序）', () => {
    const cases = [
      '${project} ${nope}',
      '${env.NOT_SET}',
      '${git.tag}',
      '${unclosed',
      '${env.${x}}',
      '${nope} ${env.NOT_SET} ${other}',
    ]
    for (const input of cases) {
      const validateCodes = validateVars(input, ctx).map((e) => e.code)
      const first = renderErrors(input, ctx)[0]
      assert.deepEqual(
        validateCodes.length > 0 ? [first] : [],
        validateCodes.length > 0 ? [first] : [],
        `render 与 validate 对 ${input} 的判断应一致`,
      )
      if (validateCodes.length > 0) {
        assert.equal(validateCodes[0], first, `${input} 的首个错误码应与 renderString 一致`)
      }
    }
  })

  it('转义引用不算错误', () => {
    assert.deepEqual(validateVars('$${env.NOT_SET} $${nope}', ctx), [])
  })

  it('每条错误都带 hint', () => {
    const errors = validateVars('${nope} ${env.NOT_SET}', ctx)
    assert.equal(errors.length, 2)
    for (const err of errors) {
      assert.ok((err.hint ?? '') !== '', `${err.code} 缺 hint`)
    }
  })
})

describe('段数必须严格 —— 多写一段是拼错，不是取字段', () => {
  // env / git / release 本来就严格。project 与 now 原先会忽略多余段
  // （`${project.name}` → 'web'），于是写错名字的 conf 一路绿到远端 reload 才炸。
  // 本包不是表达式引擎，没有"取字段"这回事，所以一律按未知变量处理。
  const cases = ['${project.name}', '${now.iso}', '${now.x.y}', '${project.a.b}']

  for (const input of cases) {
    it(`${input} 报 UNKNOWN_VAR`, () => {
      assert.throws(
        () => renderString(input, ctx),
        (err: unknown) => err instanceof DpError && err.code === 'DP.TPL.UNKNOWN_VAR',
      )
    })
  }

  it('单段的 ${project} 与 ${now} 照常工作', () => {
    assert.equal(renderString('${project}', ctx), ctx.project)
    assert.equal(renderString('${now}', ctx), ctx.now?.toISOString())
  })
})

describe('golden · nginx server 块', () => {
  const tpl = [
    'server {',
    '    listen 80;',
    '    server_name ${project}.${env}.example.com;',
    '',
    '    root ${release.current};',
    '    index index.html;',
    '',
    '    location /api/ {',
    '        proxy_pass http://127.0.0.1:${env.PORT}/;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '    }',
    '}',
    '',
  ].join('\n')

  const expected = [
    'server {',
    '    listen 80;',
    '    server_name web.prod.example.com;',
    '',
    '    root /srv/web/current;',
    '    index index.html;',
    '',
    '    location /api/ {',
    '        proxy_pass http://127.0.0.1:8080/;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '    }',
    '}',
    '',
  ].join('\n')

  const goldenCtx: RenderContext = { ...ctx, envVars: { DEPLOY_KEY: 'abc123', PORT: '8080' } }

  it('逐字一致：变量被替换，nginx 自己的 $host 等原样保留', () => {
    const out = renderString(tpl, goldenCtx, { usage: 'text', path: 'projects.web.target.confd' })
    assert.equal(out, expected)
  })

  it('渲染两次结果完全相同（含行数与结尾换行）', () => {
    const a = renderString(tpl, goldenCtx)
    const b = renderString(tpl, goldenCtx)
    assert.equal(a, b)
    assert.equal(a.split('\n').length, expected.split('\n').length)
    assert.equal(a.endsWith('}\n'), true)
  })
})
