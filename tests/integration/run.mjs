#!/usr/bin/env node
/**
 * 真机集成测试：起容器靶机，用**构建产物**真跑一遍 dp，断言的是机器上的真实结果。
 *
 * 它补的是单测覆盖不到的那一整层：单测里的 Runner 是自己写的假的，而这里 ssh 是真的、
 * rsync/tar 是真的、nginx -t 是真的、systemctl 是真的。断言一律读机器（读文件、
 * 读 HTTP 响应、读 `systemctl is-active`），不读 dp 自己的报告 ——
 * 报「成功」与「真的成功过」在集成层是两件事。
 *
 * 用法：
 *   node tests/integration/run.mjs            # 全跑
 *   node tests/integration/run.mjs --only nginx
 *   node tests/integration/run.mjs --keep     # 失败时保留容器供排查
 *   DP_IT_BUILD_PROXY=http://… 跑在前面      # 机器无裸外网时喂给构建期 RUN 的代理（配隧道等宿主侧入口）
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configFor, scenarioByName, sshHost } from './scenarios.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const WORK = join(ROOT, '.tmp', 'it')
const IMAGE_TARGET = 'dp-it-target:test'
const IMAGE_CLIENT = 'dp-it-client:test'
const NET = 'dp-it-net'
const CLIENT = 'dp-it-client'
const TARGET = 'dp-it-target'
const TARGET_SYSD = 'dp-it-target-sysd'
// 地址写死而不是问网络要：问出来的地址依赖后端给不给（CI 上就不给），
// 写死之后「连不上」才是真的连不上，而不是「没拿到地址」
const SUBNET = '10.93.0.0/24'
const IP_CLIENT = '10.93.0.2'
const IP_TARGET = '10.93.0.10'
const IP_SYSD = '10.93.0.11'

const args = new Set(process.argv.slice(2))
const only = args.has('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
const keep = args.has('--keep')

// ── 子进程 ──────────────────────────────────────────────────────────────────
/** 铁律 0：每个子进程都有上限，挂住 = 失败 */
function run(cmd, argv, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 90_000
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, argv, {
      cwd: opts.cwd ?? ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(opts.env ?? {}) },
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`${cmd} ${argv.join(' ')} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? -1, stdout, stderr })
    })
  })
}

const pod = (argv, opts) => run('podman', argv, opts)
const execIn = (name, script, opts) => pod(['exec', name, 'sh', '-c', script], opts)
const log = (line) => process.stdout.write(`${line}\n`)

/**
 * 容器名解析出来的地址。**不用容器名当主机名**：名字能不能解析取决于那台机器上装的是
 * netavark 还是 CNI、dns 插件开没开 —— CI 上 podman 4.9.3 就解析不了，报的是
 * `Could not resolve hostname`，而真因是网络后端，不是 ssh。
 */
const hosts = {}

async function resolveHost(name) {
  const r = await pod(['inspect', name], { timeoutMs: 30_000 })
  let nets
  try {
    nets = JSON.parse(r.stdout)[0]?.NetworkSettings?.Networks ?? {}
  } catch {
    throw new Error(`${name} 的 inspect 输出不是 JSON：${r.stdout.slice(0, 300)}`)
  }
  // 先按网络名取，取不到就退回「它连着的那个网络」—— 网络名的键由后端决定，
  // 认死一个键等于把「连到了别的网络上」当成了「没连上」
  const ip = nets[NET]?.IPAddress ?? Object.values(nets).map((n) => n?.IPAddress ?? '').find((v) => v !== '') ?? ''
  if (ip === '') {
    const running = JSON.parse(r.stdout)[0]?.State?.Running === true
    if (!running) {
      // 拿不到地址最常见的一类真因：容器压根没活着。点名 `podman logs`，
      // 别把 inspect 原文甩给人猜
      throw new Error(
        `${name} 已经不在跑（Status: ${JSON.parse(r.stdout)[0]?.State?.Status ?? '未知'}）。` +
          `先 podman logs ${name} 看它的原话；多数是起手就退（比如镜像还是老编排，让 CMD 直接跑 sshd）`,
      )
    }
    throw new Error(
      `拿不到 ${name} 的地址：它连着的网络是 ${Object.keys(nets).join(',') || '（没有）'}，` +
        `inspect 原文 ${r.stdout.slice(0, 400)}`,
    )
  }
  hosts[name] = ip
  return ip
}

// ── 报告 ────────────────────────────────────────────────────────────────────
const results = []

/**
 * 环境不具备。与失败的区别是**有没有结论**：失败是「跑过了、不对」，
 * 跳过是「这台机器上 systemd 根本没起来，跑什么都不能证明什么」。
 * 跳过的场景在末尾照旧列出来并写明原因，不混进通过里。
 */
class Skip extends Error {}

/**
 * 失败时把「dp 眼里这台机器是什么样」也打印出来。
 *
 * 报 `release.root 不可写` 时有两个可能：dp 判断错了，或者这台机器真的写不进去。
 * 只看错误码分不开这两种，而修错的那一个等于白修 —— facts 里的 canWrite 与 probeNotes
 * 是机器自己给的答案，把它和下面的裸 ssh 实测对照，就能定位到是断言错了还是夹具错了。
 */
async function dumpFacts(name) {
  const r = await dp(['facts', '--json', '--config', `/work/${name}.json`, '--host', 'target'])
  if (r.code !== 0) {
    log(`    facts 也失败了：${r.why}`)
    return
  }
  const facts = r.json?.facts ?? r.json
  const canWrite = facts?.capabilities?.canWrite ?? {}
  const rows = Object.entries(canWrite)
    .map(([k, v]) => `${k}=${v ? '可写' : '不可写'}`)
    .join('  ')
  log(`    dp 看到的 canWrite：${rows}`)
  const notes = r.json?.probeNotes ?? []
  if (notes.length > 0) log(`    probeNotes：${notes.join(' | ')}`)
}

/**
 * 把靶机上的发布根整棵树打出来。
 *
 * 「报 0 个文件」有两种可能：真没传过去，或者传过去了但计数错了。
 * 光看 dp 的报告分不开这两种，而修错的那一个等于白修 —— 树是机器自己给的答案。
 */
async function dumpTree(name) {
  const scenario = scenarioByName(name)
  if (scenario === undefined) return
  const r = await execIn(TARGET, `ls -R ${scenario.root} 2>&1 | head -40`)
  log(`    靶机 ${scenario.root} 的实际内容：\n${r.stdout.trim().split('\n').map((l) => `      ${l}`).join('\n')}`)
}

/**
 * 用两条裸 rsync 对照 dp 的那一条：一条不带 `--rsync-path`，一条带上。
 *
 * 分的是「rsync 本身就没传」与「--rsync-path=sudo 这条路上没传」——
 * 两者的报错在 dp 这一层长得一模一样（退出 0、0 个文件），只有分开跑才看得出来。
 */
async function dumpRsync() {
  const ip = hosts[TARGET]
  const rsh =
    'ssh -p 22 -i /root/.ssh/id_ed25519 -o BatchMode=yes ' +
    '-o UserKnownHostsFile=/root/.ssh/known_hosts -o StrictHostKeyChecking=accept-new'
  const fmt = "--itemize-changes --no-human-readable --out-format='%i %n'"
  const sudo = "--rsync-path='sudo -n -u root rsync'"
  // 五组，两两只差一个变量：先分出「要不要 sudo」，再分出「要不要那几个格式化选项」，
  // 最后一组是 dp 真正的那条。-vv 是为了拿到 rsync 自己打印的 `opening connection
  // using:` —— 那一行是「远端到底收到了什么命令」的原文，比任何推断都硬。
  const variants = [
    ['裸', '', 'plain'],
    ['只加 sudo', sudo, 'sudo'],
    ['只加格式化选项', fmt, 'fmt'],
    ['sudo + 关掉 protect-args', `${sudo} --no-protect-args`, 'sudonp'],
    ['dp 同款（sudo + 格式化选项）', `${fmt} ${sudo}`, 'exact'],
  ]
  for (const [label, extra, tag] of variants) {
    const dest = `/srv/static/releases/probe-${tag}`
    const cmd = `rsync -a --stats -vv -e '${rsh}' ${extra} /work/src/static/index.html dp@${ip}:${dest}/ 2>&1`
    const r = await execIn(CLIENT, cmd, { timeoutMs: 60_000 })
    // 不裁剪：sudo 报的 "not found / denied" 与 rsync 报的 "up to date" 都可能就是答案。
    // 只截长度，不按关键字过滤 —— 过滤掉的那行往往正是真因。
    const out = (r.stdout + r.stderr)
      .split('\n')
      .slice(0, 40)
      .map((l) => `      ${l}`)
      .join('\n')
    const landed = await execIn(TARGET, `ls -l ${dest} 2>&1 | tail -3`)
    // 落不到预期位置时必须知道它落哪儿了：报「created 1」却在预期位置找不到，
    // 说明远端把路径解析成了别的地方（家目录下的相对路径是最常见的那种）。
    const where = await execIn(TARGET, `find / -xdev -maxdepth 8 -name 'probe-${tag}' 2>/dev/null | head -5`)
    log(
      `    裸 rsync（${label}）：退出 ${r.code}\n${out}\n` +
        `      落盘：${landed.stdout.trim()}\n      实际位置：${where.stdout.trim() || '（没找到）'}`,
    )
  }
  const vers = await execIn(CLIENT, 'rsync --version | head -1')
  const vremote = await execIn(TARGET, 'rsync --version | head -1; command -v sudo')
  log(`    rsync 版本：客户端 ${vers.stdout.trim()} │ 靶机 ${vremote.stdout.trim().split('\n').join(' │ ')}`)
}

async function scenario(name, fn) {
  if (only !== undefined && only !== name) {
    results.push({ name, state: 'skipped', detail: '未选中' })
    return
  }
  const started = Date.now()
  try {
    await fn()
    results.push({ name, state: 'pass', ms: Date.now() - started })
    log(`  ✔ ${name}（${Date.now() - started}ms）`)
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ name, state: 'skipped', detail: err.message })
      log(`  ⊘ ${name} —— ${err.message}`)
      return
    }
    results.push({ name, state: 'fail', ms: Date.now() - started, detail: String(err?.stack ?? err) })
    log(`  ✖ ${name}\n${String(err?.message ?? err)}`)
    await dumpFacts(name)
    await dumpTree(name)
    if (name === 'static') await dumpRsync()
  }
}

// ── 环境与夹具 ──────────────────────────────────────────────────────────────
function writeFixtures() {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(join(WORK, 'src', 'static'), { recursive: true })
  mkdirSync(join(WORK, 'src', 'nginx'), { recursive: true })
  mkdirSync(join(WORK, 'src', 'app'), { recursive: true })

  writeFileSync(join(WORK, 'src', 'static', 'index.html'), '<h1>static-v1</h1>', 'utf8')
  writeFileSync(join(WORK, 'src', 'nginx', 'index.html'), '<h1>nginx-v1</h1>', 'utf8')
  writeFileSync(join(WORK, 'src', 'app', 'index.html'), '<h1>app-v1</h1>', 'utf8')
  writeFileSync(
    join(WORK, 'src', 'app', 'server.js'),
    [
      "const http = require('node:http')",
      "const fs = require('node:fs')",
      "const port = Number(process.env.PORT ?? process.argv[2] ?? 8080)",
      'const body = fs.readFileSync(process.argv[3] ?? "index.html")',
      "http.createServer((_req, res) => { res.writeHead(200); res.end(body) }).listen(port, () => {",
      "  console.log('listening on ' + port)",
      '})',
      '',
    ].join('\n'),
    'utf8',
  )
  return WORK
}

async function putScenarioConfig(name, targetHost) {
  const scenario = scenarioByName(name)
  if (scenario === undefined) throw new Error(`没有 ${name} 这个场景`)
  const value = configFor(scenario, sshHost(targetHost))
  const file = join(WORK, `${name}.json`)
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  await pod(['cp', file, `${CLIENT}:/work/${name}.json`])
}

/** 在客户端里跑 dp。只认退出码与 JSON，不认 stdout 里的客套话 */
async function dp(argv) {
  // 一律 debug：传输那条 argv 只在 debug 打，而「报了 0 个文件」这种失败
  // 的真因就在那条命令里。日志走 stderr，不影响 stdout 上的 JSON。
  const r = await execIn(
    CLIENT,
    `node /opt/dp/packages/cli/build/bin.js ${[...argv, '--log-level=debug'].join(' ')}`,
    { timeoutMs: 180_000 },
  )
  let json
  try {
    json = JSON.parse(r.stdout)
  } catch {
    json = undefined
  }
  return {
    code: r.code,
    json,
    stdout: r.stdout,
    stderr: r.stderr,
    // 失败时两个流都要看：结构化报告在 stdout，日志行在 stderr，
    // 只看一个会出现「知道失败了，但不知道为什么」。
    // 日志不只看 error：传输选了哪条路（`apply.transport`）是 info，
    // 而「报 0 个文件」这种失败，原因往往就在那一行里（argv 在 warn 里）。
    get why() {
      const pretty = r.stdout.trim()
      const logs = r.stderr
        .split('\n')
        .filter(
          (l) =>
            l.includes('"level"') &&
            (l.includes('apply.') ||
              l.includes('"level":"error"') ||
              l.includes('"level":"warn"')),
        )
        .slice(-8)
        .join('\n')
      return [pretty, logs].filter((s) => s !== '').join('\n') || `退出 ${r.code}，两个流都是空的`
    },
  }
}

async function waitForSsh(name, host) {
  const deadline = Date.now() + 90_000
  for (;;) {
    const r = await execIn(
      CLIENT,
      `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts ` +
        `-i /root/.ssh/id_ed25519 dp@${host} 'echo ok'`,
      { timeoutMs: 30_000 },
    )
    if (r.code === 0 && r.stdout.trim() === 'ok') return
    if (Date.now() > deadline) {
      // 只看 ssh 的原话会漏掉真因（容器已经 exited / sshd 起不来），把容器自己的日志一并带出来
      const logs = await pod(['logs', '--tail', '30', name], { timeoutMs: 30_000 })
      throw new Error(
        `${name} 的 sshd 一直没就绪：${r.stderr.trim()}\n容器日志：${(logs.stdout + logs.stderr).trim()}`,
      )
    }
    await new Promise((r2) => setTimeout(r2, 1000))
  }
}

/**
 * 以 dp 的身份、走 ssh 实测一遍「这几个目录到底写不写得进去」。
 *
 * 与 dp 自己的探测并列打印：两边不一致时，错的那个一眼可见 ——
 * 都说不可写是夹具的问题，只有 dp 说不可写才是 dp 的问题。
 */
async function preflightWrite(host) {
  for (const dir of ['/srv', '/srv/static', '/srv/nginx', '/srv/proc']) {
    await execIn(TARGET, `mkdir -p ${dir} && chown dp:dp ${dir}`)
  }
  const script =
    `ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts ` +
    `-i /root/.ssh/id_ed25519 dp@${host} ` +
    // sudo 那一路要先自证：dp 的 rsync 全程跑在 --rsync-path=sudo 下，
    // 而「sudo 根本不能用」与「sudo 能用但 rsync 那侧没传」长得一模一样
    `'id -un; sudo -n -u root id -un 2>&1; ls -ld /srv /srv/static; for d in /srv /srv/static; do ` +
    `if touch "$d/.dp-pre-$$" 2>/dev/null; then rm -f "$d/.dp-pre-$$"; echo "$d writable"; ` +
    `else echo "$d NOT writable"; fi; done'`
  const r = await execIn(CLIENT, script, { timeoutMs: 30_000 })
  log(`  裸 ssh 实测（dp 身份）：${(r.stdout + r.stderr).trim().split('\n').join(' │ ')}`)
}

/** 允许某场景所需的目录先存在，避免「第一次部署就要提权建根」这种额外变量 */
async function seedDir(name, dir, owner = 'dp') {
  // mkdir 是以 root 跑的，chown 之后还要**以 dp 的身份再验一次**可写：
  // 目录存在且属主对，跟「dp 真的写得进去」是两回事（父目录逐层校验就是这么来的）
  const r = await execIn(name, `mkdir -p ${dir} && chown ${owner}:${owner} ${dir} && su ${owner} -c 'test -w ${dir}'`)
  if (r.code !== 0) throw new Error(`${name} 上 ${dir} 对 ${owner} 不可写：${(r.stdout + r.stderr).trim()}`)
}

async function swapSource(src, text) {
  writeFileSync(join(WORK, 'src', src, 'index.html'), text, 'utf8')
  // 先删再拷：往一个已存在的目录里 cp 会把源目录塞成它的子目录（/work/src/src）
  await execIn(CLIENT, 'rm -rf /work/src')
  await pod(['cp', join(WORK, 'src'), `${CLIENT}:/work/src`])
}

// ── 场景 ────────────────────────────────────────────────────────────────────
async function scenarioStatic() {
  await seedDir(TARGET, '/srv/static')
  await putScenarioConfig('static', hosts[TARGET])
  // 源在**客户端**里：它空了的话 dp 报的是 SOURCE.EMPTY，而真因在夹具不在 dp —— 先自查一眼
  const srcLs = await execIn(CLIENT, 'ls -1 /work/src/static')
  assert.notEqual(srcLs.stdout.trim(), '', '客户端里的源目录是空的，先修夹具')

  const first = await dp(['apply', '--json', '--config', '/work/static.json'])
  assert.equal(first.code, 0, `apply 退出 ${first.code}：${first.why}`)
  assert.equal(
    (await execIn(TARGET, 'cat /srv/static/current/index.html')).stdout.trim(),
    '<h1>static-v1</h1>',
    '第一次部署后 current 指向的版本内容不对',
  )

  // verify 要在部署成功后给出「healthy」三件套：退出 0、ok、指到当前版本。
  // releaseId 记下来，回滚后再 verify 时必须回到同一个 —— 内容断言管「文件对不对」，
  // 这个管「current 的版本号对不对」，二者对不上说明状态层在漂。
  const checked = await dp(['verify', '--json', '--config', '/work/static.json'])
  assert.equal(checked.code, 0, `verify 退出 ${checked.code}：${checked.why}`)
  assert.equal(checked.json?.ok, true, 'verify 报调用了 healthy 却没在 JSON 里给出 ok')
  const verifiedRelease = checked.json?.releaseId
  assert.ok(
    typeof verifiedRelease === 'string' && verifiedRelease.length > 0,
    `verify 没报出 releaseId：${JSON.stringify(verifiedRelease)}`,
  )

  await swapSource('static', '<h1>static-v2</h1>')
  const second = await dp(['apply', '--json', '--config', '/work/static.json'])
  assert.equal(second.code, 0, `第二次 apply：${second.why}`)
  assert.equal(
    (await execIn(TARGET, 'cat /srv/static/current/index.html')).stdout.trim(),
    '<h1>static-v2</h1>',
  )
  const releases = (await execIn(TARGET, 'ls /srv/static/releases'))
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
  assert.ok(releases.length >= 2, `版本目录应有 2 个，实际 ${releases.join(',')}`)

  const back = await dp(['rollback', '--json', '--config', '/work/static.json'])
  assert.equal(back.code, 0, `rollback：${back.why}`)
  assert.equal(
    (await execIn(TARGET, 'cat /srv/static/current/index.html')).stdout.trim(),
    '<h1>static-v1</h1>',
    '回滚后内容不是上一版',
  )

  const rechecked = await dp(['verify', '--json', '--config', '/work/static.json'])
  assert.equal(rechecked.code, 0, `回滚后 verify：${rechecked.why}`)
  assert.equal(rechecked.json?.ok, true)
  assert.equal(
    rechecked.json?.releaseId,
    verifiedRelease,
    `回滚后 verify 指到的版本和首次部署记下的不一致：${String(rechecked.json?.releaseId)} ≠ ${String(verifiedRelease)}`,
  )

  const status = await dp(['status', '--json', '--config', '/work/static.json'])
  assert.equal(status.code, 0)
  assert.equal(status.json?.ok, true)
}

async function scenarioNginx() {
  await seedDir(TARGET, '/srv/nginx')
  await execIn(TARGET, 'nginx -t && nginx')
  await putScenarioConfig('nginx', hosts[TARGET])

  const first = await dp(['apply', '--json', '--config', '/work/nginx.json'])
  assert.equal(first.code, 0, `nginx apply：${first.why}`)
  const conf = await execIn(TARGET, 'cat /etc/nginx/conf.d/web.conf')
  assert.match(conf.stdout, /# managed by dp/, 'conf 缺管理标记')
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET]}:8080/index.html`)).stdout.trim(),
    '<h1>nginx-v1</h1>',
    'nginx 没在提供第一个版本',
  )

  await swapSource('nginx', '<h1>nginx-v2</h1>')
  const second = await dp(['apply', '--json', '--config', '/work/nginx.json'])
  assert.equal(second.code, 0, `nginx 第二次 apply：${second.why}`)
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET]}:8080/index.html`)).stdout.trim(),
    '<h1>nginx-v2</h1>',
  )
  const reloadOk = await execIn(TARGET, 'nginx -t')
  assert.equal(reloadOk.code, 0, `reload 之后 nginx -t 不过：${reloadOk.stderr}`)

  const back = await dp(['rollback', '--json', '--config', '/work/nginx.json'])
  assert.equal(back.code, 0, `nginx rollback：${back.why}`)
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET]}:8080/index.html`)).stdout.trim(),
    '<h1>nginx-v1</h1>',
    'nginx 回滚后还在提供新版本',
  )
}

async function scenarioProcess() {
  await seedDir(TARGET, '/srv/proc')
  await putScenarioConfig('process', hosts[TARGET])

  const first = await dp(['apply', '--json', '--config', '/work/process.json'])
  assert.equal(first.code, 0, `process apply：${first.why}`)
  const pid1 = (await execIn(TARGET, 'cat /srv/proc/.dp/app.pid')).stdout.trim()
  assert.match(pid1, /^\d+$/, 'pidfile 里不是 pid')
  assert.equal(
    (await execIn(TARGET, `kill -0 ${pid1} && echo alive`)).stdout.trim(),
    'alive',
    'pidfile 里的 pid 已经不在了',
  )
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET]}:8082/`)).stdout.trim(),
    '<h1>app-v1</h1>',
  )

  await swapSource('app', '<h1>app-v2</h1>')
  const second = await dp(['apply', '--json', '--config', '/work/process.json'])
  assert.equal(second.code, 0, `process 第二次 apply：${second.why}`)
  const pid2 = (await execIn(TARGET, 'cat /srv/proc/.dp/app.pid')).stdout.trim()
  assert.notEqual(pid2, pid1, '第二版还是旧 pid —— 旧进程根本没停')
  assert.equal(
    (await execIn(TARGET, `kill -0 ${pid1} 2>/dev/null && echo alive || echo gone`)).stdout.trim(),
    'gone',
    '上一版进程没被停掉',
  )
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET]}:8082/`)).stdout.trim(),
    '<h1>app-v2</h1>',
  )

  const back = await dp(['rollback', '--json', '--config', '/work/process.json'])
  assert.equal(back.code, 0, `process rollback：${back.why}`)
  const pid3 = (await execIn(TARGET, 'cat /srv/proc/.dp/app.pid')).stdout.trim()
  assert.notEqual(pid3, pid2, '回滚没起新进程')
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET]}:8082/`)).stdout.trim(),
    '<h1>app-v1</h1>',
    '回滚后还在提供新版本',
  )
}

async function scenarioSystemd() {
  if (systemdReady !== true) throw new Skip('这台容器里的 systemd 没起来，跑什么都不能证明什么')
  await seedDir(TARGET_SYSD, '/srv/sysd')
  await putScenarioConfig('systemd', hosts[TARGET_SYSD])

  const first = await dp(['apply', '--json', '--config', '/work/systemd.json'])
  assert.equal(first.code, 0, `systemd apply：${first.why}`)
  assert.equal(
    (await execIn(TARGET_SYSD, 'systemctl is-active dp-it-app.service')).stdout.trim(),
    'active',
    'unit 不是 active',
  )
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET_SYSD]}:8083/`)).stdout.trim(),
    '<h1>app-v1</h1>',
  )

  await swapSource('app', '<h1>app-v2</h1>')
  const second = await dp(['apply', '--json', '--config', '/work/systemd.json'])
  assert.equal(second.code, 0, `systemd 第二次 apply：${second.why}`)
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET_SYSD]}:8083/`)).stdout.trim(),
    '<h1>app-v2</h1>',
  )
  const enabled = await execIn(TARGET_SYSD, 'systemctl is-enabled dp-it-app.service 2>&1 || true')
  assert.match(enabled.stdout, /enabled|static/, `unit 没被 enable：${enabled.stdout}`)

  const back = await dp(['rollback', '--json', '--config', '/work/systemd.json'])
  assert.equal(back.code, 0, `systemd rollback：${back.why}`)
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET_SYSD]}:8083/`)).stdout.trim(),
    '<h1>app-v1</h1>',
    '回滚后 unit 还在跑新版本',
  )
}

// ── 编排 ────────────────────────────────────────────────────────────────────
/** systemd 靶机上 systemd 是否真的可用。先探，不猜 —— 铁律 1 */
let systemdReady = false

async function ensureImages() {
  if (existsSync(join(ROOT, 'package.json')) === false) throw new Error('不在仓库根')
  for (const [tag, file] of [
    [IMAGE_TARGET, 'Containerfile.target'],
    [IMAGE_CLIENT, 'Containerfile.client'],
  ]) {
    const has = await pod(['image', 'exists', tag])
    // 复用要答一个问题：这份镜像还代表当前这个 Containerfile 吗？
    // 只看「tag 存在」的话，本机上任何一次编排语义变化（比如 CMD 从跑 sshd 改成
    // sleep infinity）都会让旧镜像按老形状起容器，然后死得莫名其妙 ——
    // 所以镜像创建时间早于 Containerfile 的修改时间就强制重建
    let stale = false
    if (has.code === 0) {
      const meta = await pod(
        ['image', 'inspect', tag, '--format', '{{.Created}}'],
        { timeoutMs: 30_000 },
      )
      const created = Date.parse(meta.stdout.trim())
      stale = Number.isNaN(created) || created < statSync(join(HERE, file)).mtimeMs
    }
    if (has.code === 0 && !stale) {
      log(`  镜像 ${tag} 已存在，复用`)
      continue
    }
    if (stale) log(`  镜像 ${tag} 比它的 Containerfile 旧，重建（旧形状起出来的容器会按老编排死得没头绪）`)
    const built = await pod(['build', ...buildNetArgs(), '-t', tag, '-f', join(HERE, file), HERE], { timeoutMs: 600_000 })
    if (built.code !== 0) throw new Error(`构建 ${tag} 失败：${built.stderr.slice(-800)}`)
  }
}

/**
 * 构建期网络：podman 机器会把宿主侧代理原样注进 RUN 环境，宿主代理一停，
 * apt 就按死代理反复重试（Containerfile 里清 ENV 压不过这层注入）。
 * 设 `DP_IT_BUILD_PROXY=http://…` 显式喂代理并切 host 网络（RUN 走 pasta 默认连网时
 * 够不到机器 loopback 的隧道口）；不设就显式清空，即 Containerfile 声明的「走直连」。
 */
function buildNetArgs() {
  const proxy = process.env.DP_IT_BUILD_PROXY
  if (proxy !== undefined && proxy !== '') {
    return [
      '--network', 'host',
      '--build-arg', `http_proxy=${proxy}`, '--build-arg', `https_proxy=${proxy}`,
      '--build-arg', `HTTP_PROXY=${proxy}`, '--build-arg', `HTTPS_PROXY=${proxy}`,
      '--build-arg', 'no_proxy=localhost,127.0.0.1', '--build-arg', 'NO_PROXY=localhost,127.0.0.1',
    ]
  }
  return [
    '--build-arg', 'http_proxy=', '--build-arg', 'https_proxy=',
    '--build-arg', 'HTTP_PROXY=', '--build-arg', 'HTTPS_PROXY=',
    '--build-arg', 'no_proxy=*', '--build-arg', 'NO_PROXY=*',
  ]
}

/** 集成的容器只与 dp-it-net 内部对话，不需要任何外网，把机器注进来的代理环境一并摘掉 */
const noProxyEnv = ['-e', 'http_proxy=', '-e', 'https_proxy=', '-e', 'HTTP_PROXY=', '-e', 'HTTPS_PROXY=']

/** 容器是否还活着。退出码只能说明启动时那一下，活没活着得问状态 */
async function isRunning(name) {
  const r = await pod(['inspect', name], { timeoutMs: 30_000 })
  try {
    return JSON.parse(r.stdout)[0]?.State?.Running === true
  } catch {
    return false
  }
}

async function putKey(name) {
  await pod(['cp', join(WORK, 'key.pub'), `${name}:/home/dp/.ssh/authorized_keys`])
  await execIn(name, 'chown dp:dp /home/dp/.ssh/authorized_keys && chmod 600 /home/dp/.ssh/authorized_keys')
}

/**
 * systemd 那台单独起：systemctl 要求 1 号进程是自己，塞进普通靶机里它只会报
 * "System has not been booted with systemd"。
 *
 * 起不来**不判失败**：容器里的 systemd 能不能跑取决于那台机器的 cgroup 与 seccomp
 * 放不放行（CI 上就不放行），那是环境结论，不是 dp 的结论。重试一次特权模式，
 * 还是不行就把 systemd 场景标成跳过并写明原因。
 */
async function startSystemdTarget() {
  const base = [
    'run', '-d', ...noProxyEnv, '--name', TARGET_SYSD, '--network', `${NET}:ip=${IP_SYSD}`,
    '--systemd=always', '--cgroupns=private',
    // /run/lock 少了这一条，systemd 会在起来之前就因为 mkdir 失败退出，而日志里什么都不留
    '--tmpfs', '/run', '--tmpfs', '/run/lock', '--tmpfs', '/tmp',
  ]
  const whyOf = async () => {
    const st = await pod(['inspect', '--format', '{{.State.ExitCode}} | {{.State.Error}}', TARGET_SYSD], { timeoutMs: 30_000 })
    const logs = (await pod(['logs', '--tail', '20', TARGET_SYSD], { timeoutMs: 30_000 })).stdout.trim()
    // 三个来源都取：日志常常是空的（systemd 还没来得及写就退了），
    // 而 State.Error 里那句才是容器运行时给出的真因
    return [st.stdout.trim(), logs].filter((s) => s !== '' && s !== '|').join(' / ') || '直接退出，没有留下任何输出'
  }

  // 三种起法逐个试。能不能跑 systemd 取决于那台机器的 cgroup / seccomp 放不放行，
  // 那是环境结论而不是 dp 的结论 —— 所以试完都不行就跳过并写明原因，不判失败。
  const variants = [
    [[], '非特权'],
    [['--privileged'], '特权'],
    [['--privileged', '--cgroupns=host', '-v', '/sys/fs/cgroup:/sys/fs/cgroup:rw'], '特权+挂 cgroup'],
  ]
  const failures = []
  let up = false
  for (const [extra, label] of variants) {
    const r = await pod([...base, ...extra, IMAGE_TARGET, '/sbin/init'])
    if (r.code === 0 && (await isRunning(TARGET_SYSD)) === true) {
      up = true
      break
    }
    // 退出之后日志常常是空的，等一下再取，别把「还没来得及写」当成「没有输出」
    await new Promise((s) => setTimeout(s, 2000))
    failures.push(`${label}：${await whyOf()}`)
    await pod(['rm', '-f', TARGET_SYSD])
  }
  if (up === false) {
    log(`  ⚠ systemd 靶机起不来（${failures.join('；')}），systemd 场景跳过`)
    return
  }

  // 起来到进 running 之间有一段：第一次问几乎必然是 starting，问一次就判死等于把启动慢当成了不支持
  let sysdUp = { stdout: '' }
  for (let i = 0; i < 30; i += 1) {
    sysdUp = await execIn(TARGET_SYSD, 'systemctl is-system-running 2>&1 || true', { timeoutMs: 30_000 })
    if (/running|degraded/.test(sysdUp.stdout)) break
    await new Promise((s) => setTimeout(s, 2000))
  }
  if (/running|degraded/.test(sysdUp.stdout) === false) {
    log(`  ⚠ systemd 起来了但没进 running（${sysdUp.stdout.trim()}），systemd 场景跳过`)
    return
  }
  await resolveHost(TARGET_SYSD)
  await putKey(TARGET_SYSD)
  await execIn(TARGET_SYSD, 'systemctl enable --now ssh 2>&1 || systemctl enable --now sshd 2>&1 || true')
  await waitForSsh(TARGET_SYSD, hosts[TARGET_SYSD])
  systemdReady = true
}

async function startContainers() {
  const rm = await pod(['rm', '-f', CLIENT, TARGET, TARGET_SYSD])
  void rm
  // 先删再建：留着上一轮的网络，它的子网未必还是这一个，写死的地址就会落到网段外
  await pod(['network', 'rm', '-f', NET])
  const net = await pod(['network', 'create', '--subnet', SUBNET, NET])
  if (net.code !== 0) throw new Error(`建网络失败：${net.stderr}`)

  const client = await pod(['run', '-d', ...noProxyEnv, '--name', CLIENT, '--network', `${NET}:ip=${IP_CLIENT}`, IMAGE_CLIENT])
  if (client.code !== 0) throw new Error(`起客户端失败：${client.stderr}`)

  const target = await pod(['run', '-d', ...noProxyEnv, '--name', TARGET, '--network', `${NET}:ip=${IP_TARGET}`, IMAGE_TARGET])
  if (target.code !== 0) throw new Error(`起靶机失败：${target.stderr}`)

  await pod(['exec', CLIENT, 'sh', '-c', 'ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/id_ed25519'])
  await podCp(`${CLIENT}:/root/.ssh/id_ed25519.pub`, join(WORK, 'key.pub'))
  await resolveHost(TARGET)
  await putKey(TARGET)
  // sshd 不交给 CMD：让 1 号进程去跑它，起不来的后果是容器直接退出，只剩一句
  // 「exited」而看不出为什么。这里显式起并接住它的原话
  const sshd = await execIn(TARGET, 'mkdir -p /run/sshd && /usr/sbin/sshd -e 2>&1')
  if (sshd.code !== 0) throw new Error(`靶机的 sshd 起不来：${sshd.stdout.trim() || sshd.stderr.trim()}`)
  await waitForSsh(TARGET, hosts[TARGET])
  await preflightWrite(hosts[TARGET])

  await startSystemdTarget()

  await execIn(CLIENT, 'mkdir -p /opt/dp /work')
  await podCp(stagePackages(), `${CLIENT}:/opt/dp/`)
  await podCp(join(WORK, 'src'), `${CLIENT}:/work/src`)
  // workspace 包在仓库里靠 pnpm 链进 node_modules，进容器后那份链接没有意义 ——
  // 这里按同样形状补一份，跑的就是产物，与 CI 上 `pnpm install` 之后的形态一致
  const links = await execIn(
    CLIENT,
    'mkdir -p /opt/dp/node_modules/@dp ' +
      '&& for d in /opt/dp/packages/*/; do n=$(basename "$d"); ln -sfn "/opt/dp/packages/$n" "/opt/dp/node_modules/@dp/$n"; done',
  )
  if (links.code !== 0) {
    throw new Error(`容器里补 @dp 链接失败：${(links.stderr || links.stdout).trim()}`)
  }
  const selfcheck = await execIn(CLIENT, 'node /opt/dp/packages/cli/build/bin.js --version')
  if (selfcheck.code !== 0) {
    throw new Error(`产物在容器里跑不起来：${selfcheck.stderr}（先跑 pnpm build）`)
  }
  log(`  客户端里的 dp：${selfcheck.stdout.trim()}`)
}

/**
 * 只把**运行时需要的形状**打进容器：每个 workspace 包的 package.json + build/。
 * 整棵 packages/ 直接 cp 会把宿主侧的 node_modules 一并扫进去 —— Windows 上那是手工
 * junction，podman 的 tar 头直接报 unknown file mode，整条 cp 失败；测试产物（*.test.js、
 * fixtures）对跑部署没有意义，带上只会让传输量与排查时的噪声一起膨胀。
 */
function stagePackages() {
  const stage = join(WORK, 'cp', 'packages')
  rmSync(join(WORK, 'cp'), { recursive: true, force: true })
  const srcRoot = join(ROOT, 'packages')
  for (const name of readdirSync(srcRoot).sort()) {
    if (name === 'testkit') continue // 测试公共件，不在部署链里，进容器只是多余噪声
    const from = join(srcRoot, name)
    if (statSync(from).isDirectory() === false) continue
    if (existsSync(join(from, 'build')) === false) {
      throw new Error(`${name}/build 不存在 —— 先 pnpm build 再跑集成`)
    }
    const dst = join(stage, name)
    mkdirSync(dst, { recursive: true })
    cpSync(join(from, 'package.json'), join(dst, 'package.json'))
    cpSync(join(from, 'build'), join(dst, 'build'), { recursive: true })
  }
  return stage
}

/** 每条 `podman cp` 都在动容器文件系统，退出码不查会把失败传给几步之后毫不相关的报错 */
async function podCp(source, dest) {
  const r = await pod(['cp', source, dest])
  if (r.code !== 0) throw new Error(`容器拷贝失败 ${source} → ${dest}：${(r.stderr || r.stdout).trim()}`)
}

async function main() {
  const ver = await pod(['version', '--format', '{{.Version}}'], { timeoutMs: 60_000 })
  if (ver.code !== 0) {
    log('podman 不可用（本机没起容器运行时）。本机跑不了就交给 CI，不要假装跑过。')
    process.exit(4)
  }
  log(`podman ${ver.stdout.trim()}`)

  writeFixtures()
  await ensureImages()
  try {
    await startContainers()
    log('场景：')
    await scenario('static', scenarioStatic)
    await scenario('nginx', scenarioNginx)
    await scenario('process', scenarioProcess)
    await scenario('systemd', scenarioSystemd)
  } finally {
    if (!keep) await pod(['rm', '-f', CLIENT, TARGET, TARGET_SYSD], { timeoutMs: 60_000 })
  }

  const failed = results.filter((r) => r.state === 'fail')
  log('')
  for (const r of results) log(`${r.state === 'pass' ? '✔' : r.state === 'fail' ? '✖' : '⊘'} ${r.name}${r.detail ? ` —— ${r.detail}` : ''}`)
  if (failed.length > 0) {
    log(`\n${failed.length} 个场景失败。容器${keep ? '已保留' : '已清理'}。`)
    process.exit(1)
  }
  log(`\n全部 ${results.filter((r) => r.state === 'pass').length} 个场景通过。`)
}

await main()
