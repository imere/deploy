import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'
import { detectCandidates, resolveTargetKind } from './detect.js'

// 输入全部靠构造数组：本文件不建目录、不读盘（AGENTS.md 铁律 1，零 IO）

const kinds = (entries: readonly string[], packageScripts?: readonly string[]): string[] =>
  detectCandidates({ entries, ...(packageScripts !== undefined ? { packageScripts } : {}) }).map((c) => c.kind)

function one(entries: readonly string[]): { kind: string; implemented: boolean; evidence: readonly string[] } {
  const found = detectCandidates({ entries })
  assert.equal(found.length, 1, `期望恰好 1 个候选，实际 ${found.length}：${found.map((c) => c.kind).join(',')}`)
  const only = found[0]
  assert.ok(only !== undefined)
  return only
}

function err(fn: () => unknown): DpError {
  try {
    fn()
  } catch (e) {
    assert.ok(e instanceof DpError, `期望 DpError，实际 ${String(e)}`)
    return e
  }
  throw new Error('期望抛错，但没有')
}

// ------------------------------------------------------------
// 证据表：每一行单独命中（docs/config.md §8）
// ------------------------------------------------------------

test('证据表：compose 的四种写法都指向 docker（已实现）', () => {
  for (const name of [
    'docker-compose.yml',
    'compose.yaml',
    'docker-compose.prod.yml',
    'docker-compose.prod.yaml',
    'compose.yml',
  ]) {
    const c = one([name])
    assert.equal(c.kind, 'docker')
    assert.equal(c.implemented, true, name)
    assert.deepEqual(c.evidence, [name])
  }
})

test('证据表：docker-compose..yml 不是合法变体名（* 部分必须非空）', () => {
  assert.deepEqual(kinds(['docker-compose..yml']), [])
})

test('证据表：只有 Dockerfile → docker 但未实现', () => {
  const c = one(['Dockerfile'])
  assert.equal(c.kind, 'docker')
  assert.equal(c.implemented, false)
})

test('证据表：nginx.conf / conf.d 下的 .conf / *.nginx.conf 都指向 nginx', () => {
  for (const name of ['nginx.conf', 'conf.d/api.conf', 'etc/nginx/conf.d/api.conf', 'site.nginx.conf']) {
    const c = one([name])
    assert.equal(c.kind, 'nginx', name)
    assert.equal(c.implemented, true, name)
  }
})

test('证据表：conf.d 自身不算证据（它是目录名，不是 .conf 文件）', () => {
  assert.deepEqual(kinds(['conf.d']), [])
  // 但它下面的 .conf 算
  assert.deepEqual(kinds(['conf.d/api.conf']), ['nginx'])
})

test('证据表：Caddyfile / *.service / ecosystem.config.js / Chart.yaml', () => {
  assert.deepEqual(kinds(['Caddyfile']), ['caddy'])
  assert.deepEqual(kinds(['deploy/app.service']), ['systemd'])
  assert.deepEqual(kinds(['ecosystem.config.js']), ['pm2'])
  assert.deepEqual(kinds(['charts/web/Chart.yaml']), ['k8s'])
})

test('证据表：未实现的候选一样报得出来，implemented=false', () => {
  const found = detectCandidates({ entries: ['Caddyfile'] })
  const only = one(['Caddyfile'])
  assert.equal(found.length, 1)
  assert.equal(only.implemented, false)
  assert.equal(only.kind, 'caddy')
  assert.ok(only.evidence.length > 0, '未实现的候选也必须有证据')
})

test('证据表：.deploy/scripts/* 与 scripts.deploy 都指向 delegate', () => {
  assert.deepEqual(kinds(['.deploy/scripts/ship.sh']), ['delegate'])
  assert.deepEqual(kinds(['bin/thing'], ['build', 'deploy']), ['delegate'])
  // 目录本身不算：scripts 之后还得有一段
  assert.deepEqual(kinds(['.deploy/scripts']), [])
})

test('证据表：index.html → static（已实现）', () => {
  const c = one(['assets/index.html'])
  assert.equal(c.kind, 'static')
  assert.equal(c.implemented, true)
})

test('证据表：packageScripts 里没有 deploy 时不产出 delegate', () => {
  assert.deepEqual(kinds(['package.json'], ['build', 'test']), [])
})

// ------------------------------------------------------------
// 跨平台分隔符
// ------------------------------------------------------------

test('跨平台：conf.d 路径在两种分隔符下结论完全一致', () => {
  const posix = resolveTargetKind({ entries: ['etc/nginx/conf.d/api.conf', 'assets/app.js'] }, 'auto')
  const windows = resolveTargetKind({ entries: ['etc\\nginx\\conf.d\\api.conf', 'assets\\app.js'] }, 'auto')
  assert.equal(posix.kind, 'nginx')
  assert.deepEqual(posix, windows, '两种分隔符下产出必须逐字相同')
})

test('跨平台：同名的普通 .conf 不算 nginx 证据（两种分隔符下都不算）', () => {
  assert.deepEqual(kinds(['a/b.conf', 'assets/app.js']), [])
  assert.deepEqual(kinds(['a\\b.conf', 'assets\\app.js']), [])
})

test('跨平台：conf.d 与 .deploy/scripts 在反斜杠下同样命中', () => {
  assert.deepEqual(kinds(['etc\\nginx\\conf.d\\api.conf']), ['nginx'])
  assert.deepEqual(kinds(['.deploy\\scripts\\ship.sh']), ['delegate'])
})

// ------------------------------------------------------------
// 仲裁
// ------------------------------------------------------------

test('0 命中：报错并列出它看到了哪些文件名，不假装 static', () => {
  const e = err(() => resolveTargetKind({ entries: ['README.md', 'src/main.ts', 'lib/util.ts'] }, 'auto'))
  assert.equal(e.path, 'target.type')
  const hint = e.hint ?? ''
  for (const f of ['README.md', 'src/main.ts', 'lib/util.ts']) {
    assert.ok(hint.includes(f), `hint 应列出 ${f}，实际：${hint}`)
  }
  assert.match(hint, /target\.type/)
  assert.doesNotMatch(e.message, /static/)
})

test('0 命中：超过 10 个文件时截断并给出总数', () => {
  const entries = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`)
  const e = err(() => resolveTargetKind({ entries }, 'auto'))
  assert.match(e.hint ?? '', /共 14 个/)
  assert.match(e.hint ?? '', /f9\.ts/)
  assert.doesNotMatch(e.hint ?? '', /f10\.ts/)
})

test('0 命中：源清单为空时说清楚是空的', () => {
  const e = err(() => resolveTargetKind({ entries: [] }, 'auto'))
  assert.match(e.hint ?? '', /源清单为空/)
})

test('1 命中：直接用它，reason 是能指导下一步的一行', () => {
  const r = resolveTargetKind({ entries: ['docker-compose.yml'] }, 'auto')
  assert.equal(r.kind, 'docker')
  assert.deepEqual(r.evidence, ['docker-compose.yml'])
  assert.deepEqual(r.rejected, [])
  assert.match(r.reason, /检测到 docker-compose\.yml → target\.type=docker（可用 target\.type 覆盖）/)
})

test('1 命中但未实现：报错说清「看到了什么、还缺什么」，不静默降级成 static', () => {
  const e = err(() => resolveTargetKind({ entries: ['Dockerfile'] }, 'auto'))
  assert.match(e.message, /Dockerfile/)
  assert.match(e.message, /还没实现 docker/)
  const hint = e.hint ?? ''
  for (const k of ['static', 'nginx', 'docker']) assert.ok(hint.includes(k), `hint 应列出已实现的 ${k}`)
  assert.doesNotMatch(e.message, /static/)
})

test('Dockerfile + compose：只有一个 docker 候选，且是已实现的那个', () => {
  const found = detectCandidates({ entries: ['Dockerfile', 'docker-compose.yml', 'index.html'] })
  const docker = found.filter((c) => c.kind === 'docker')
  assert.equal(docker.length, 1, '不能因为有 Dockerfile 就多出一个 single-image 候选')
  const only = docker[0]
  assert.ok(only !== undefined)
  assert.equal(only.implemented, true)
  assert.equal(only.confidence, 90)
  assert.deepEqual(only.evidence, ['Dockerfile', 'docker-compose.yml'])
})

test('多命中 + pick=fail：报错列出全部候选与证据，并给出排除办法', () => {
  const e = err(() =>
    resolveTargetKind({ entries: ['docker-compose.yml', 'nginx.conf', 'index.html'] }, 'fail'),
  )
  const text = `${e.message} ${e.hint ?? ''}`
  for (const k of ['docker', 'nginx', 'static']) assert.ok(text.includes(k), `应列出候选 ${k}`)
  assert.ok(text.includes('docker-compose.yml'), '应给出证据')
  assert.match(e.hint ?? '', /exclude/)
})

test('多命中 + pick=auto：不同分取最高，并带上被舍弃的候选', () => {
  const r = resolveTargetKind({ entries: ['index.html', 'nginx.conf', 'docker-compose.yml'] }, 'auto')
  assert.equal(r.kind, 'docker')
  assert.deepEqual(r.rejected.map((c) => c.kind).sort(), ['nginx', 'static'])
  assert.match(r.reason, /docker-compose\.yml/)
})

test('同分 → 报错（auto 下不靠顺序暗选）', () => {
  // .service 与 ecosystem.config.js 刻意同档：两个「自带进程监管配置」的信号强度相同
  const e = err(() => resolveTargetKind({ entries: ['app.service', 'ecosystem.config.js'] }, 'auto'))
  assert.match(e.message, /证据强度相同/)
  assert.match(e.message, /systemd 与 pm2/)
  assert.ok((e.hint ?? '').includes('target.type'))
})

test('同分报错与数组顺序无关：反序输入报同一个错', () => {
  const a = err(() => resolveTargetKind({ entries: ['app.service', 'ecosystem.config.js'] }, 'auto'))
  const b = err(() => resolveTargetKind({ entries: ['ecosystem.config.js', 'app.service'] }, 'auto'))
  assert.equal(a.message, b.message)
})

test('已实现 + 未实现同时命中：auto 选已实现的，未实现的进 rejected', () => {
  const r = resolveTargetKind({ entries: ['docker-compose.yml', 'Caddyfile'] }, 'auto')
  assert.equal(r.kind, 'docker', '一个 Caddyfile 不该让 compose 项目报「不支持」')
  assert.deepEqual(r.rejected.map((c) => c.kind), ['caddy'])
  const caddy = r.rejected[0]
  assert.ok(caddy !== undefined, 'caddy 应作为被舍弃的候选出现')
  assert.equal(caddy.implemented, false)
  assert.deepEqual(caddy.evidence, ['Caddyfile'])
})

test('未实现的候选参与仲裁但不静默降级：全未实现时报错', () => {
  const e = err(() => resolveTargetKind({ entries: ['Caddyfile', 'Chart.yaml', 'app.service'] }, 'auto'))
  assert.match(e.message, /都还没实现/)
  const hint = e.hint ?? ''
  for (const k of ['caddy', 'k8s', 'systemd']) assert.ok(hint.includes(k) || (e.message).includes(k))
  for (const k of ['static', 'nginx', 'docker']) assert.ok(hint.includes(k), `hint 应列出已实现的 ${k}`)
})

test('未实现的高分候选不否决已实现候选：Dockerfile + index.html → static', () => {
  const r = resolveTargetKind({ entries: ['Dockerfile', 'index.html'] }, 'auto')
  assert.equal(r.kind, 'static')
  assert.deepEqual(r.rejected.map((c) => c.kind), ['docker'])
})

test('每个候选的证据都非空（空证据的候选不许存在）', () => {
  const found = detectCandidates({ entries: ['a', 'b'], packageScripts: ['deploy'] })
  for (const c of found) {
    assert.ok(c.evidence.length > 0, `${c.kind} 证据为空`)
  }
})

test('证据去重且有序：同一文件重复出现不会把证据列表撑长', () => {
  const c = one(['docker-compose.yml', 'docker-compose.yml', 'Dockerfile'])
  assert.deepEqual(c.evidence, ['Dockerfile', 'docker-compose.yml'])
})
