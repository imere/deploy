/**
 * schema 的 nginx 段单测。
 *
 * 关注三件 schema 真正该管的事：**默认值**、**联合形态**、**类型层看不出来的非法值**。
 * 语义判定（upstream 末尾斜杠、listen 修饰符、locations 空数组）刻意不在这里测 ——
 * 那些属于 @dp/target-nginx，在 schema 再写一遍就是两套规则各自漂移。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError } from '@dp/ports'
import { DEFAULT_KEEP, defineBecome, defineDocker, defineHost, defineNginx, defineProcess, defineSystemd, defineTarget, becomeSchema, dockerSchema, nginxSchema, releaseSchema, targetSchema, type DockerInput, type NginxInput, type ProcessInput, type SystemdInput } from './config.js'

function codeOf(fn: () => unknown): { code: string; message: string; path?: string; hint?: string } {
  try {
    fn()
  } catch (err) {
    if (err instanceof DpError) {
      // message 一并带出来：联合形态的报错把「实际是 X」放在 message 里，
      // hint 只说「两种写法都可以」—— 只返回 code/hint 时那半句谁也没断言过，
      // 于是把类型名的判据翻掉，整条 message 换掉也照样绿
      return { code: err.code, message: err.message, ...(err.path !== undefined ? { path: err.path } : {}), ...(err.hint !== undefined ? { hint: err.hint } : {}) }
    }
    throw err
  }
  assert.fail('应当抛错')
}

/**
 * 故意写错的输入走这里，而不是 `defineNginx({...} as unknown as ...)`。
 *
 * 非法输入本来就无法用类型表达，而 `Schema.parse(input: unknown, path)` 的签名
 * 正是为此存在：断言用的是**配置加载器实际走的那条路**（config-file 调的也是
 * schema.parse），比在测试里另造一个 cast 入口更接近生产。
 */
function parseRaw(value: unknown): unknown {
  return nginxSchema.parse(value, 'nginx')
}

const BASE: NginxInput = { server: { root: '/srv/app/current' } }

describe('nginx · 省略可选项', () => {
  it('不产生 filename / force / reload 这几个键', () => {
    const parsed = defineNginx(BASE)
    assert.deepEqual(Object.keys(parsed), ['server'])
    // 「键不存在」与「键存在但 undefined」在这里是同一件事：默认行为归 @dp/target-nginx 管
    assert.equal('filename' in parsed, false)
    assert.equal('force' in parsed, false)
    assert.equal('reload' in parsed, false)
  })

  it('写了就保留原值（不做任何改写）', () => {
    const parsed = defineNginx({ ...BASE, filename: '${project}.conf', force: true, reload: ['nginx', '-s', 'reload'] })
    assert.equal(parsed.filename, '${project}.conf')
    assert.equal(parsed.force, true)
    assert.deepEqual(parsed.reload, ['nginx', '-s', 'reload'])
  })
})

describe('nginx · server 的联合形态', () => {
  it('单块对象原样通过', () => {
    const parsed = defineNginx({ server: { serverName: ['a.example.com'], listen: [80, '443 ssl'] } })
    // 逐字段断言做不到：Array.isArray 收不掉 readonly T[] 分支，TS 不给窄化。
    // 整体比对反而更强 —— 它同时证明了「只保留写过的键」
    assert.deepEqual(parsed.server, { serverName: ['a.example.com'], listen: [80, '443 ssl'] })
  })

  it('多块数组逐块解析', () => {
    const parsed = defineNginx({
      server: [
        { serverName: ['a.example.com'], root: '/srv/a/current' },
        { serverName: ['b.example.com'], listen: [8080], locations: [{ path: '/', root: '/srv/b' }] },
      ],
    })
    assert.ok(Array.isArray(parsed.server))
    assert.equal(parsed.server.length, 2)
    assert.deepEqual(parsed.server[1], {
      serverName: ['b.example.com'],
      listen: [8080],
      locations: [{ path: '/', root: '/srv/b' }],
    })
  })

  it('数字与字符串的 listen 都接受，混合也接受', () => {
    const parsed = defineNginx({ server: { listen: [80, '443 ssl', 'unix:/tmp/s.sock'] } })
    assert.deepEqual(parsed.server, { listen: [80, '443 ssl', 'unix:/tmp/s.sock'] })
  })

  it('空数组是合法输入（语义判定归渲染层）', () => {
    // 刻意不在这里拒：渲染层已经带着 hint 拒它（DP.NGX.CONF_INVALID），
    // schema 再拒一次就是两套规则，症状是两边提示不一致
    const parsed = defineNginx({ server: { locations: [] } })
    assert.deepEqual(parsed.server, { locations: [] })
  })

  it('数字（既不是对象也不是数组）→ 说清两种期望形态', () => {
    const r = codeOf(() => parseRaw({ ...BASE, server: 8080 }))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.match(String(r.hint), /单个 server 块对象/)
    assert.match(String(r.hint), /server 块数组/)
    assert.equal(r.path, 'nginx.server')
    // hint 已经说过两种写法，但「实际是 number」只在 message 里。
    // 不钉这半句，把类型名函数的判据翻成「非 null 一律 null」测试照样全绿
    assert.match(r.message, /期望 单个 server 块对象 或 server 块数组/)
    assert.match(r.message, /实际是 number/)
  })

  it('null 既不是 server 块也不是数组 → 报 null 而不是 object', () => {
    // 必须单独钉 null：typeof null === 'object'，只有 object / string / array 这几条
    // 断言时，把「input === null」翻成「!==」会让非 null 输入全报 null，
    // 那条翻转恰好被上一条抓住 —— 但 null 自己被报成 object 这半边仍无人看守
    const r = codeOf(() => parseRaw({ ...BASE, server: null }))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'nginx.server')
    assert.match(String(r.hint), /两种写法都可以/)
    assert.match(r.message, /实际是 null/)
  })

  it('listen 的联合：元素既不是数字也不是字符串 → 报 array，而不是摊开后的 object', () => {
    // 数组摊开是 {}，只看 typeof 分不出「用户写了个数组」与「用户写了个对象」：
    // 前者改一个字符就能修好，后者往往是一整层结构搞错了
    const r = codeOf(() => parseRaw({ ...BASE, server: { listen: [['80']] } }))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'nginx.server.listen[0]')
    assert.match(r.message, /期望 数字端口 或 带修饰符的字符串/)
    assert.match(r.message, /实际是 array/)
  })
})

describe('nginx · reload', () => {
  it('false 通过（由外部机制重载）', () => {
    const parsed = defineNginx({ ...BASE, reload: false })
    assert.equal(parsed.reload, false)
  })

  it('argv 里的空串被拒 —— 类型层看不出来，但空参数会让远端 execve 直接失败', () => {
    const r = codeOf(() => defineNginx({ ...BASE, reload: ['nginx', '', 'reload'] }))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'nginx.reload[1]')
    assert.match(String(r.hint), /execve/)
  })

  it('首元素空串同样被拒', () => {
    assert.equal(codeOf(() => defineNginx({ ...BASE, reload: [''] })).code, 'DP.CONFIG.INVALID')
  })

  it('既不是数组也不是 false → 说清两种写法', () => {
    const r = codeOf(() => parseRaw({ ...BASE, reload: 'nginx -s reload' }))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.match(String(r.hint), /argv 数组/)
    assert.match(String(r.hint), /false/)
    assert.match(r.message, /期望 argv 数组 或 false/)
    assert.match(r.message, /实际是 string/)
  })

  it('给一个普通对象 → 报 object，不猜它是不是某种可迭代形状', () => {
    const r = codeOf(() => parseRaw({ ...BASE, reload: { argv: ['nginx', '-s', 'reload'] } }))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'nginx.reload')
    assert.match(r.message, /实际是 object/)
  })
})

describe('nginx · 未知字段被拒', () => {
  it('server 里的未知键报出可用字段', () => {
    const r = codeOf(() => parseRaw({ server: { root: '/srv', upstream: 'http://x' } }))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'nginx.server.upstream')
    assert.match(String(r.hint), /serverName/)
  })

  it('顶层未知键同样被拒（confd 不在这里，写了就是错配置）', () => {
    const r = codeOf(() => parseRaw({ ...BASE, confd: '/etc/nginx/conf.d' }))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'nginx.confd')
  })

  it('嵌套层的未知键定位到具体路径', () => {
    const r = codeOf(() =>
      parseRaw({ server: { locations: [{ path: '/', root: '/srv', rewrites: [] }] } }),
    )
    assert.equal(r.path, 'nginx.server.locations[0].rewrites')
  })
})

describe('targetSchema 里的 nginx', () => {
  it('opt() 后省略不产生该键（零回归的前提）', () => {
    const target = defineTarget({ type: 'static' })
    assert.equal('nginx' in target, false)
  })

  it('配了就能取到，且 confd 与 nginx 同级', () => {
    const target = defineTarget({ type: ['nginx'], confd: '/etc/nginx/conf.d', nginx: BASE })
    assert.deepEqual(target.nginx, { server: { root: '/srv/app/current' } })
    assert.equal(target.confd, '/etc/nginx/conf.d')
  })

  it('json schema 里 server 必填（漏了它渲染不出任何东西）', () => {
    assert.deepEqual(nginxSchema.toJsonSchema().required, ['server'])
  })

  it('json schema 里 server 是联合（导出给编辑器的那份不能撒谎）', () => {
    const server = nginxSchema.toJsonSchema().properties?.['server']
    assert.ok(server?.anyOf !== undefined, '单块 / 多块必须导出成 anyOf')
  })
})

// ------------------------------------------------------------
// docker 段
// ------------------------------------------------------------

const DOCKER_BASE: DockerInput = { compose: { files: ['docker-compose.yml'], projectName: 'api' } }
const SYSTEMD_BASE: SystemdInput = { unitDir: '/etc/systemd/system', execStart: '/srv/app/current/start.sh' }
const PROCESS_BASE: ProcessInput = { command: 'node' }

describe('docker · 默认值', () => {
  it('mode / pull / wait 有默认值，省略时补齐', () => {
    const parsed = defineDocker(DOCKER_BASE)
    assert.equal(parsed.mode, 'remote-cli')
    assert.equal(parsed.compose.pull, true)
    assert.equal(parsed.compose.wait, true)
  })

  it('opt() 的键省略时不产生该键（默认行为归 @dp/target-docker 管）', () => {
    const parsed = defineDocker(DOCKER_BASE)
    assert.equal('envFile' in parsed.compose, false)
    assert.equal('healthcheck' in parsed, false)
  })

  it('写了就原样保留（不做任何改写）', () => {
    const parsed = defineDocker({
      ...DOCKER_BASE,
      compose: { ...DOCKER_BASE.compose, envFile: '.env.prod', pull: false, wait: false },
      healthcheck: { services: ['api'], expectStates: ['running'] },
    })
    assert.equal(parsed.compose.pull, false)
    assert.equal(parsed.compose.wait, false)
    assert.deepEqual(parsed.healthcheck, { services: ['api'], expectStates: ['running'] })
  })
})

describe('docker · compose.files', () => {
  it('必填：缺了报「缺少必填字段」并指到具体那一层', () => {
    const r = codeOf(() => dockerSchema.parse({ compose: { projectName: 'api' } }, 'docker'))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'docker.compose.files')
  })

  it('projectName 必填', () => {
    const r = codeOf(() => dockerSchema.parse({ compose: { files: ['c.yml'] } }, 'docker'))
    assert.equal(r.path, 'docker.compose.projectName')
  })

  it('空串被拒，path 指到具体下标 —— 空路径拼进 -f 后面，报错与部署毫无关系', () => {
    const r = codeOf(() => defineDocker({ compose: { files: ['ok.yml', ''], projectName: 'api' } }))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'docker.compose.files[1]')
    assert.match(String(r.hint), /no such file or directory/)
  })

  it('首元素空串同样被拒', () => {
    assert.equal(codeOf(() => defineDocker({ compose: { files: [''], projectName: 'api' } })).code, 'DP.CONFIG.INVALID')
  })

  it('**空数组不在这里拒** —— 那是 DP.DOCKER.COMPOSE_FILES_EMPTY，hint 里有「不带 -f 会去找当前工作目录」的解释', () => {
    // 少一条语义判定就是少一个错误码的归属地。两处都拒会让用户先撞到哪条变得看运气
    const parsed = defineDocker({ compose: { files: [], projectName: 'api' } })
    assert.deepEqual(parsed.compose.files, [])
  })
})

describe('docker · 语义判定不在这层', () => {
  it('绝对路径 / .. / 反斜杠 / 重复文件 / 非法 projectName 一律放过（归 @dp/target-docker）', () => {
    // 逐条列出来是为了钉住纪律：这里放过 = 那里必须接住。若哪天这里开始拒，
    // 对应的那条 compose.ts 测试会开始「两处都拒」，用户撞到哪个全看配置形状
    const parsed = defineDocker({
      compose: { files: ['/etc/compose.yml', '../escape.yml', 'a\\b.yml', 'dup.yml', 'dup.yml'], projectName: 'API' },
    })
    assert.equal(parsed.compose.files.length, 5)
    assert.equal(parsed.compose.projectName, 'API')
  })

  it('files 里出现非字符串元素在加载期就报（类型对不上不许留到部署时）', () => {
    const r = codeOf(() => dockerSchema.parse({ compose: { files: ['ok.yml', 42], projectName: 'api' } }, 'docker'))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'docker.compose.files[1]')
  })
})

describe('docker · 未知字段被拒', () => {
  it('顶层未知键报出可用字段（发布根不是这里的字段）', () => {
    const r = codeOf(() => dockerSchema.parse({ ...DOCKER_BASE, root: '/srv/api' }, 'docker'))
    assert.equal(r.code, 'DP.CONFIG.INVALID')
    assert.equal(r.path, 'docker.root')
    // 报的是**顶层**可用字段。projectName 嵌在 compose 里，不出现在这一层
    assert.match(String(r.hint), /compose/)
  })

  it('compose 里的未知键定位到具体路径', () => {
    const r = codeOf(() => dockerSchema.parse({ compose: { ...DOCKER_BASE.compose, network: 'x' } }, 'docker'))
    assert.equal(r.path, 'docker.compose.network')
  })
})

describe('target.type 与 nginx / docker 段必须一致', () => {
  const NGINX_BASE: NginxInput = { server: { root: '/srv/app/current' } }

  it('点名 nginx 却没有 nginx 段 → 拒绝（否则会静默按 static 部署）', () => {
    assert.throws(
      () => defineTarget({ type: 'nginx' }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.equal(err.path, 'target.nginx')
        return true
      },
    )
  })

  it('点名 docker 却没有 docker 段 → 同上', () => {
    assert.throws(
      () => defineTarget({ type: ['docker', 'static'] }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
    )
  })

  it('给了 nginx 段却写 type: nginx 之外的名字 → 拒绝（段决定跑什么，type 不能是另一个说法）', () => {
    assert.throws(
      () => defineTarget({ type: 'docker', nginx: NGINX_BASE, docker: DOCKER_BASE }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.path, 'target.type')
        return true
      },
    )
  })

  it('type 是必填：只给段不写类型要报错（不给它就没法判断一致性）', () => {
    assert.throws(
      () => targetSchema.parse({ docker: DOCKER_BASE }, 'target'),
      (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
    )
  })

  it('type: auto 展开成缺省链，此时有段不判不一致 —— 段才是执行器的判据', () => {
    const target = defineTarget({ type: 'auto', docker: DOCKER_BASE })
    assert.equal(target.docker?.compose.projectName, 'api')
  })

  it('systemd / process 有执行器，写出来就接受（段决定跑什么，不是靠探测猜）', () => {
    assert.deepEqual(defineTarget({ type: 'systemd', systemd: SYSTEMD_BASE }).systemd?.unitDir, '/etc/systemd/system')
    assert.equal(defineTarget({ type: 'process', process: PROCESS_BASE }).process?.command, 'node')
  })

  it('点名 systemd / process 却没有对应段 → 拒绝（没有段就没有可执行的东西）', () => {
    for (const kind of ['systemd', 'process'] as const) {
      assert.throws(
        () => defineTarget({ type: kind }),
        (err: unknown) => {
          assert.ok(err instanceof DpError)
          assert.equal(err.code, 'DP.CONFIG.INVALID')
          assert.equal(err.path, `target.${kind}`)
          return true
        },
        `${kind} 缺段该被拒`,
      )
    }
  })

  it('显式写了 type 却给了链外的段 → 拒绝（段才是执行器的判据，type 不能是另一个说法）', () => {
    assert.throws(
      () =>
        defineTarget({
          type: 'nginx',
          nginx: { server: { root: '/srv/app/current' } },
          process: PROCESS_BASE,
        }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.equal(err.path, 'target.type')
        return true
      },
    )
  })
})

describe('targetSchema 里的 docker', () => {
  it('opt() 后省略不产生该键（零回归的前提）', () => {
    const target = defineTarget({ type: 'static' })
    assert.equal('docker' in target, false)
  })

  it('配了就能取到', () => {
    const target = defineTarget({ type: ['static', 'docker'], docker: DOCKER_BASE })
    assert.equal(target.docker?.compose.projectName, 'api')
  })

  it('json schema 里 compose 与 mode 都在 required（withDefault 的输入可省、输出必填），mode 带默认值', () => {
    const json = dockerSchema.toJsonSchema()
    assert.deepEqual(json.required, ['mode', 'compose'])
    assert.equal(json.properties?.['mode']?.default, 'remote-cli')
  })
})

describe('targetSchema 里的 systemd', () => {
  it('unitDir 可省：省下来才轮得到「实测可写性推导」那一级', () => {
    const unit = defineSystemd({ execStart: '/srv/app/current/start.sh' })
    assert.equal(unit.unitDir, undefined)
  })

  it('unitDir 写了就必须是以 / 开头的绝对路径', () => {
    for (const bad of ['etc/systemd/system', '../systemd']) {
      assert.throws(
        () =>
          defineSystemd({
            execStart: '/srv/app/current/start.sh',
            unitDir: bad,
          }),
        (err: unknown) => {
          assert.ok(err instanceof DpError)
          assert.equal(err.code, 'DP.CONFIG.INVALID')
          assert.equal(err.path, 'systemd.unitDir')
          return true
        },
        `应拒绝 ${bad}`,
      )
    }
  })

  it('restart 缺省 on-failure，scope 缺省 system', () => {
    const unit = defineSystemd(SYSTEMD_BASE)
    assert.equal(unit.restart, 'on-failure')
    assert.equal(unit.scope, 'system')
  })

  it('restart 只收 systemd 自己认的字面值，不起别名', () => {
    assert.throws(
      () => defineSystemd({ ...SYSTEMD_BASE, restart: 'always-on' as 'always' }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
    )
  })
})

describe('targetSchema 里的 process', () => {
  it('command 必填：没有启动命令就没有可执行的东西', () => {
    assert.throws(
      () => defineProcess({} as ProcessInput),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.equal(err.path, 'process.command')
        return true
      },
    )
  })

  it('停止信号与优雅期有默认值，且不给 SIGKILL 开口子', () => {
    const proc = defineProcess(PROCESS_BASE)
    assert.equal(proc.stopSignal, 'SIGTERM')
    assert.equal(proc.stopTimeoutMs, 10_000)
    assert.throws(
      () => defineProcess({ ...PROCESS_BASE, stopSignal: 'SIGKILL' as 'SIGTERM' }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
    )
  })
})

describe('DEFAULT_KEEP', () => {
  it('钉住字面值 5 —— 改默认值必须是一次有意识的、会让这条变红的动作', () => {
    assert.equal(DEFAULT_KEEP, 5)
  })

  it('release 段整个省略时，归一化结果就是它（其余各处从这里取，不再各写一份 5）', () => {
    assert.equal(releaseSchema.parse({}, 'release').keep, DEFAULT_KEEP)
  })

  it('switchStrategy 缺省 auto，且不收没有实现的值', () => {
    assert.equal(releaseSchema.parse({}, 'release').switchStrategy, 'auto')
    // rename 会把 releases/<id> 移出 releases/，prune 与 rollback 随即失去目标
    assert.throws(() => releaseSchema.parse({ switchStrategy: 'rename' }, 'release'), {
      path: 'release.switchStrategy',
    })
  })
})

describe('hops：多跳配置入口', () => {
  it('合法多跳通过', () => {
    const host = defineHost({ hops: [{ ssh: 'ops@jump.example.com' }, { ssh: 'deploy@10.0.0.7:2222' }] })
    assert.equal(host.hops?.length, 2)
  })

  it('hops 与 ssh 互斥：同时给要报错，path 指到 hosts.*.ssh', () => {
    assert.throws(
      () => defineHost({ ssh: 'deploy@10.0.0.7', hops: [{ ssh: 'ops@jump.example.com' }] }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.equal(err.path, 'host.ssh')
        assert.match(err.hint ?? '', /二选一|只能选一个/)
        return true
      },
    )
  })

  it('坏连接串报错，path 指向具体那一跳', () => {
    assert.throws(
      () => defineHost({ hops: [{ ssh: 'ops@jump.example.com' }, { ssh: 'deploy@' }] }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.path, 'host.hops[1].ssh')
        return true
      },
    )
  })

  it('端口越界报错', () => {
    assert.throws(() => defineHost({ hops: [{ ssh: 'ops@jump.example.com', port: 70000 }] }), {
      path: 'host.hops[0].port',
    })
  })

  it('knownHosts 必须是合法枚举值', () => {
    assert.throws(() => defineHost({ hops: [{ ssh: 'ops@jump.example.com', knownHosts: 'nope' as never }] }), {
      path: 'host.hops[0].knownHosts',
    })
  })

  it('空数组 hops 按「没给」处理：与 ssh 共存不报错', () => {
    const host = defineHost({ ssh: 'deploy@10.0.0.7', hops: [] })
    assert.equal(host.ssh, 'deploy@10.0.0.7')
  })

  it('只给 ssh（单跳）行为不变', () => {
    assert.equal(defineHost({ ssh: 'deploy@10.0.0.7:2222' }).ssh, 'deploy@10.0.0.7:2222')
  })
})

describe('become · custom 的命令模板', () => {
  it('type 缺省是 none，且不带 template 键', () => {
    const parsed = defineBecome({})
    assert.equal(parsed.type, 'none')
    assert.equal('template' in parsed, false)
  })

  it('custom 带合法模板原样通过', () => {
    const parsed = defineBecome({ type: 'custom', template: 'dzdo -u root ${cmd}' })
    assert.deepEqual(parsed, { type: 'custom', template: 'dzdo -u root ${cmd}', method: 'auto', preserveEnv: false })
  })

  it('custom 不给 template 报错并指向 template', () => {
    const e = codeOf(() => defineBecome({ type: 'custom' }))
    assert.equal(e.code, 'DP.CONFIG.INVALID')
    assert.equal(e.path, 'become.template')
    assert.match(e.message, /必须写 template/)
  })

  it('模板缺 ${cmd} 占位报错：没有占位会把被提权的命令整条丢掉', () => {
    const e = codeOf(() => defineBecome({ type: 'custom', template: 'dzdo -u root' }))
    assert.equal(e.path, 'become.template')
    assert.match(e.message, /\$\{cmd\}/)
  })

  it('空白模板按没给处理', () => {
    const e = codeOf(() => defineBecome({ type: 'custom', template: '   ' }))
    assert.equal(e.path, 'become.template')
  })

  it('非 custom 写了 template 报错，不静默忽略', () => {
    const e = codeOf(() => defineBecome({ type: 'sudo', template: 'dzdo ${cmd}' }))
    assert.equal(e.path, 'become.template')
    assert.match(e.message, /不生效/)
  })

  it('非法输入走 schema.parse 那条路（配置加载器的实际入口）', () => {
    assert.throws(() => becomeSchema.parse({ type: 'custom' }, 'hosts.prod.become'), { path: 'hosts.prod.become.template' })
  })
})
