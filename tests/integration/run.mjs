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
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** 每个场景一份配置。ssh 用户是普通用户 dp，写系统目录全靠 become */
function config(project, extra) {
  return {
    hosts: {
      target: {
        ssh: `dp@${extra.targetHost}:22`,
        auth: { type: 'key', identityFile: '/root/.ssh/id_ed25519' },
        become: { type: 'sudo', user: 'root', method: 'nopasswd' },
        transport: { strategy: 'auto' },
      },
    },
    projects: {
      [project]: {
        host: 'target',
        source: { root: `/work/src/${extra.src}` },
        release: { root: extra.root, keep: 3 },
        target: extra.target,
      },
    },
  }
}

async function putConfig(name, value) {
  const file = join(WORK, `${name}.json`)
  writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  await pod(['cp', file, `${CLIENT}:/work/${name}.json`])
}

/** 在客户端里跑 dp。只认退出码与 JSON，不认 stdout 里的客套话 */
async function dp(argv) {
  const r = await execIn(CLIENT, `node /opt/dp/packages/cli/build/bin.js ${argv.join(' ')}`, {
    timeoutMs: 180_000,
  })
  let json
  try {
    json = JSON.parse(r.stdout)
  } catch {
    json = undefined
  }
  return { code: r.code, json, stdout: r.stdout, stderr: r.stderr }
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

/** 允许某场景所需的目录先存在，避免「第一次部署就要提权建根」这种额外变量 */
async function seedDir(name, dir, owner = 'dp') {
  await execIn(name, `mkdir -p ${dir} && chown ${owner}:${owner} ${dir}`)
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
  await putConfig('static', config('static-site', {
    targetHost: hosts[TARGET],
    src: 'static',
    root: '/srv/static',
    target: { type: 'static' },
  }))

  const first = await dp(['apply', '--json', '--config', '/work/static.json'])
  assert.equal(first.code, 0, `apply 退出 ${first.code}：${first.stderr}`)
  assert.equal(
    (await execIn(TARGET, 'cat /srv/static/current/index.html')).stdout.trim(),
    '<h1>static-v1</h1>',
    '第一次部署后 current 指向的版本内容不对',
  )

  await swapSource('static', '<h1>static-v2</h1>')
  const second = await dp(['apply', '--json', '--config', '/work/static.json'])
  assert.equal(second.code, 0, `第二次 apply：${second.stderr}`)
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
  assert.equal(back.code, 0, `rollback：${back.stderr}`)
  assert.equal(
    (await execIn(TARGET, 'cat /srv/static/current/index.html')).stdout.trim(),
    '<h1>static-v1</h1>',
    '回滚后内容不是上一版',
  )

  const status = await dp(['status', '--json', '--config', '/work/static.json'])
  assert.equal(status.code, 0)
  assert.equal(status.json?.ok, true)
}

async function scenarioNginx() {
  await seedDir(TARGET, '/srv/nginx')
  await execIn(TARGET, 'nginx -t && nginx')
  await putConfig('nginx', config('web', {
    targetHost: hosts[TARGET],
    src: 'nginx',
    root: '/srv/nginx',
    target: {
      type: 'nginx',
      nginx: {
        server: {
          serverName: ['target'],
          listen: [8080],
          root: '${release.current}',
          index: ['index.html'],
        },
      },
    },
  }))

  const first = await dp(['apply', '--json', '--config', '/work/nginx.json'])
  assert.equal(first.code, 0, `nginx apply：${first.stderr}`)
  const conf = await execIn(TARGET, 'cat /etc/nginx/conf.d/web.conf')
  assert.match(conf.stdout, /# managed by dp/, 'conf 缺管理标记')
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET]}:8080/index.html`)).stdout.trim(),
    '<h1>nginx-v1</h1>',
    'nginx 没在提供第一个版本',
  )

  await swapSource('nginx', '<h1>nginx-v2</h1>')
  const second = await dp(['apply', '--json', '--config', '/work/nginx.json'])
  assert.equal(second.code, 0, `nginx 第二次 apply：${second.stderr}`)
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET]}:8080/index.html`)).stdout.trim(),
    '<h1>nginx-v2</h1>',
  )
  const reloadOk = await execIn(TARGET, 'nginx -t')
  assert.equal(reloadOk.code, 0, `reload 之后 nginx -t 不过：${reloadOk.stderr}`)

  const back = await dp(['rollback', '--json', '--config', '/work/nginx.json'])
  assert.equal(back.code, 0, `nginx rollback：${back.stderr}`)
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET]}:8080/index.html`)).stdout.trim(),
    '<h1>nginx-v1</h1>',
    'nginx 回滚后还在提供新版本',
  )
}

async function scenarioProcess() {
  await seedDir(TARGET, '/srv/proc')
  await putConfig('process', config('app', {
    targetHost: hosts[TARGET],
    src: 'app',
    root: '/srv/proc',
    target: {
      type: 'process',
      process: {
        command: '/usr/local/bin/node',
        args: ['${release.current}/server.js', '8082', '${release.current}/index.html'],
        workingDirectory: '${release.current}',
        pidFile: '.dp/app.pid',
        stdoutLog: '.dp/app.log',
      },
    },
  }))

  const first = await dp(['apply', '--json', '--config', '/work/process.json'])
  assert.equal(first.code, 0, `process apply：${first.stderr}`)
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
  assert.equal(second.code, 0, `process 第二次 apply：${second.stderr}`)
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
  assert.equal(back.code, 0, `process rollback：${back.stderr}`)
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
  await putConfig('systemd', config('sysd', {
    targetHost: hosts[TARGET_SYSD],
    src: 'app',
    root: '/srv/sysd',
    target: {
      type: 'systemd',
      systemd: {
        unit: 'dp-it-app.service',
        description: 'integration fixture',
        execStart: '/usr/local/bin/node ${release.current}/server.js',
        workingDirectory: '${release.current}',
        environment: { PORT: '8083' },
        user: 'dp',
        scope: 'system',
      },
    },
  }))

  const first = await dp(['apply', '--json', '--config', '/work/systemd.json'])
  assert.equal(first.code, 0, `systemd apply：${first.stderr}`)
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
  assert.equal(second.code, 0, `systemd 第二次 apply：${second.stderr}`)
  assert.equal(
    (await execIn(CLIENT, `curl -sS -m 10 http://${hosts[TARGET_SYSD]}:8083/`)).stdout.trim(),
    '<h1>app-v2</h1>',
  )
  const enabled = await execIn(TARGET_SYSD, 'systemctl is-enabled dp-it-app.service 2>&1 || true')
  assert.match(enabled.stdout, /enabled|static/, `unit 没被 enable：${enabled.stdout}`)

  const back = await dp(['rollback', '--json', '--config', '/work/systemd.json'])
  assert.equal(back.code, 0, `systemd rollback：${back.stderr}`)
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
    if (has.code === 0) {
      log(`  镜像 ${tag} 已存在，复用`)
      continue
    }
    const built = await pod(['build', '-t', tag, '-f', join(HERE, file), HERE], { timeoutMs: 600_000 })
    if (built.code !== 0) throw new Error(`构建 ${tag} 失败：${built.stderr.slice(-800)}`)
  }
}

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
    'run', '-d', '--name', TARGET_SYSD, '--network', `${NET}:ip=${IP_SYSD}`,
    '--systemd=always', '--tmpfs', '/run', '--tmpfs', '/tmp',
  ]
  let r = await pod([...base, IMAGE_TARGET, '/sbin/init'])
  if (r.code !== 0 || (await isRunning(TARGET_SYSD)) === false) {
    const why = (await pod(['logs', '--tail', '10', TARGET_SYSD])).stdout.trim()
    await pod(['rm', '-f', TARGET_SYSD])
    r = await pod([...base, '--privileged', IMAGE_TARGET, '/sbin/init'])
    if (r.code !== 0 || (await isRunning(TARGET_SYSD)) === false) {
      log(`  ⚠ systemd 靶机起不来（第一次：${why || '直接退出'}），systemd 场景跳过`)
      return
    }
  }

  const sysdUp = await execIn(TARGET_SYSD, 'systemctl is-system-running 2>&1 || true', { timeoutMs: 60_000 })
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

  const client = await pod(['run', '-d', '--name', CLIENT, '--network', `${NET}:ip=${IP_CLIENT}`, IMAGE_CLIENT])
  if (client.code !== 0) throw new Error(`起客户端失败：${client.stderr}`)

  const target = await pod(['run', '-d', '--name', TARGET, '--network', `${NET}:ip=${IP_TARGET}`, IMAGE_TARGET])
  if (target.code !== 0) throw new Error(`起靶机失败：${target.stderr}`)

  await pod(['exec', CLIENT, 'sh', '-c', 'ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/id_ed25519'])
  await pod(['cp', `${CLIENT}:/root/.ssh/id_ed25519.pub`, join(WORK, 'key.pub')])
  await resolveHost(TARGET)
  await putKey(TARGET)
  // sshd 不交给 CMD：让 1 号进程去跑它，起不来的后果是容器直接退出，只剩一句
  // 「exited」而看不出为什么。这里显式起并接住它的原话
  const sshd = await execIn(TARGET, 'mkdir -p /run/sshd && /usr/sbin/sshd -e 2>&1')
  if (sshd.code !== 0) throw new Error(`靶机的 sshd 起不来：${sshd.stdout.trim() || sshd.stderr.trim()}`)
  await waitForSsh(TARGET, hosts[TARGET])

  await startSystemdTarget()

  await execIn(CLIENT, 'mkdir -p /opt/dp /work')
  await pod(['cp', join(ROOT, 'packages'), `${CLIENT}:/opt/dp/packages`])
  await pod(['cp', join(WORK, 'src'), `${CLIENT}:/work/src`])
  // workspace 包在仓库里靠 pnpm 链进 node_modules，进容器后那份链接没有意义 ——
  // 这里按同样形状补一份，跑的就是产物，与 CI 上 `pnpm install` 之后的形态一致
  await execIn(
    CLIENT,
    'mkdir -p /opt/dp/node_modules/@dp ' +
      '&& for d in /opt/dp/packages/*/; do n=$(basename "$d"); ln -sfn "/opt/dp/packages/$n" "/opt/dp/node_modules/@dp/$n"; done',
  )
  const selfcheck = await execIn(CLIENT, 'node /opt/dp/packages/cli/build/bin.js --version')
  if (selfcheck.code !== 0) {
    throw new Error(`产物在容器里跑不起来：${selfcheck.stderr}（先跑 pnpm build）`)
  }
  log(`  客户端里的 dp：${selfcheck.stdout.trim()}`)
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
