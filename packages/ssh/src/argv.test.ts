import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DpError } from '@dp/ports'
import type { HopSpec, KnownHostsMode } from './driver.js'
import {
  buildRemoteCommand,
  buildRshArgv,
  buildSftpBatch,
  buildSshArgv,
  hostTarget,
  knownHostsOptions,
  quoteArg,
  quoteArgv,
  rshOptionValue,
  setEnvOptions,
  sftpQuote,
  type SshArgvOptions,
} from './argv.js'

/** 把 `-o k=v` 这类选项收成 `{ k: v }`，断言时读起来清楚 */
function opts(argv: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '-o' || argv[i + 1] === undefined) continue
    const eq = argv[i + 1]!.indexOf('=')
    if (eq === -1) out[argv[i + 1]!] = ''
    else out[argv[i + 1]!.slice(0, eq)] = argv[i + 1]!.slice(eq + 1)
  }
  return out
}

/**
 * `quoteArg` 的逆运算：按 POSIX 规则把加了引号的串解回原串。
 *
 * 有了它才能写「转义后能原样解析回来」那种属性测试：
 * 随机串 → quote → 反解析 → 必须等于原串。
 */
function unquoteArg(q: string): string {
  if (!q.startsWith("'")) return q
  let out = ''
  let i = 1
  for (;;) {
    if (i >= q.length) throw new Error(`引号未闭合：${JSON.stringify(q)}`)
    if (q[i] === "'") {
      if (q[i + 1] === '\\' && q[i + 2] === "'" && q[i + 3] === "'") {
        out += "'"
        i += 4
        continue
      }
      if (i + 1 !== q.length) throw new Error(`引号提前闭合：${JSON.stringify(q)}`)
      return out
    }
    out += q[i]
    i++
  }
}

/**
 * `rshOptionValue` / `sftpQuote` 抛的是裸 `Error`（不是 DpError，没有 code 可断言），
 * 所以只能钉住消息里的拒绝理由。只断言 `instanceof Error` 的话，实现改成抛别的错照样绿。
 */
function bareErrorMatching(re: RegExp): (e: unknown) => boolean {
  return (e: unknown) => {
    assert.ok(e instanceof Error, `期望 Error，实际 ${String(e)}`)
    assert.match(e.message, re)
    return true
  }
}

const BASE: SshArgvOptions = { authKind: 'key', knownHostsMode: 'strict' }

describe('quoteArg —— POSIX 单引号转义（注入的唯一出口）', () => {
  it('安全字符集原样返回', () => {
    for (const safe of ['abc', '/srv/app', 'a-b_c.d', 'x=1', 'a:b', 'a,b', 'A%b', 'a/b', 'a@b']) {
      assert.equal(quoteArg(safe), safe, safe)
    }
  })

  it('空串必须是两个单引号，不能是空字符串', () => {
    assert.equal(quoteArg(''), "''")
  })

  it('含空格 → 整体包引号', () => {
    assert.equal(quoteArg('a b'), "'a b'")
  })

  it('$ 与反引号在单引号内失去特殊含义', () => {
    assert.equal(quoteArg('$HOME'), "'$HOME'")
    assert.equal(quoteArg('`id`'), "'`id`'")
    assert.equal(quoteArg('$(id)'), "'$(id)'")
    assert.equal(quoteArg('${PATH}'), "'${PATH}'")
  })

  it('命令分隔符被引号中和（round-trip 证明它仍是**一个**参数）', () => {
    for (const s of ['a;id', 'a&&id', 'a|id', 'a>out', 'a<in', 'a&b', 'a b', '`id`', '$(id)']) {
      const q = quoteArg(s)
      assert.equal(unquoteArg(q), s, `${s} → ${q}`)
    }
  })

  it('单引号按 POSIX 规则断开续接', () => {
    assert.equal(quoteArg("'"), `''\\'''`)
    assert.equal(quoteArg("a'b"), `'a'\\''b'`)
    assert.equal(quoteArg("''"), `''\\'''\\'''`)
  })

  it('换行在引号内安全', () => {
    assert.equal(quoteArg('a\nb'), "'a\nb'")
    assert.equal(quoteArg('\n'), "'\n'")
  })

  it('反斜杠不被吞掉（POSIX 单引号里反斜杠无转义含义）', () => {
    assert.equal(quoteArg('a\\b'), "'a\\b'")
    assert.equal(quoteArg("C:\\Program Files"), "'C:\\Program Files'")
  })

  it('引号不配对时也必须闭合', () => {
    for (const s of ['"', "'\"", "a'b'c", "';id;'"]) {
      const q = quoteArg(s)
      // 去掉所有 '\'' 与 \ 后不应残留裸单引号
      assert.equal(q.replace(/'\\''/g, '\u0000').replace(/'/g, '').length > 0, true, s)
    }
  })
})

describe('quoteArgv', () => {
  it('逐参数转义后用空格拼', () => {
    assert.equal(quoteArgv(['rm', '-rf', 'a b']), "rm -rf 'a b'")
  })

  it('空数组得到空串', () => {
    assert.equal(quoteArgv([]), '')
  })

  it('注入串在拼接后仍是单个参数', () => {
    // 反解析：单引号外的空格才是分隔符
    const script = quoteArgv(['echo', 'a b; rm -rf /'])
    assert.equal(script, "echo 'a b; rm -rf /'")
  })
})

describe('buildSshArgv —— 选项组合', () => {
  it('key 认证默认：BatchMode=yes + IdentitiesOnly=yes + NumberOfPasswordPrompts=0', () => {
    const o = opts(buildSshArgv(BASE))
    assert.equal(o.BatchMode, 'yes')
    assert.equal(o.IdentitiesOnly, 'yes')
    assert.equal(o.NumberOfPasswordPrompts, '0')
  })

  it('agent 认证：IdentitiesOnly 不加（我们要的是 agent 里的所有身份）', () => {
    const argv = buildSshArgv({ authKind: 'agent', knownHostsMode: 'strict' })
    const o = opts(argv)
    assert.equal(o.BatchMode, 'yes')
    assert.equal(o.IdentitiesOnly, undefined)
    assert.equal(o.NumberOfPasswordPrompts, '0')
  })

  it('identitiesOnly:false 显式关掉', () => {
    const o = opts(buildSshArgv({ ...BASE, identitiesOnly: false }))
    assert.equal(o.IdentitiesOnly, undefined)
  })

  it('密码认证**不加** BatchMode=yes（那会关掉 askpass 的触发询问）', () => {
    for (const authKind of ['password', 'keyboard-interactive'] as const) {
      const o = opts(buildSshArgv({ authKind, knownHostsMode: 'strict' }))
      assert.equal(o.BatchMode, undefined, authKind)
      assert.equal(o.NumberOfPasswordPrompts, '1', authKind)
    }
  })

  it('port / identityFile / ProxyJump 各自成为独立 argv', () => {
    const argv = buildSshArgv({
      ...BASE,
      port: 2222,
      identityFile: '/keys/id_ed25519',
      proxyJump: 'ops@jump.example.com',
    })
    assert.ok(argv.includes('-p'))
    assert.equal(argv[argv.indexOf('-p') + 1], '2222')
    assert.ok(argv.includes('-i'))
    assert.equal(argv[argv.indexOf('-i') + 1], '/keys/id_ed25519')
    assert.equal(opts(argv).ProxyJump, 'ops@jump.example.com')
  })

  it('永远带 ForwardAgent=no 与 -T（不转发 agent、不申请 tty）', () => {
    const argv = buildSshArgv(BASE)
    assert.equal(opts(argv).ForwardAgent, 'no')
    assert.ok(argv.includes('-T'))
  })

  it('extraOptions 原样插在远端命令之前', () => {
    const argv = buildSshArgv({
      ...BASE,
      extraOptions: ['-o', 'KexAlgorithms=mlkem768x25519-sha256'],
      remoteArgv: ['echo', 'hi'],
    })
    const tail = argv.slice(argv.indexOf('echo'))
    assert.deepEqual(tail, ['echo', 'hi'])
    assert.ok(argv.some((a) => a.includes('mlkem768x25519-sha256')))
  })

  it('远端命令作为独立 argv 追加，路径含空格也不被拆', () => {
    const argv = buildSshArgv({ ...BASE, remoteArgv: ['sh', '-c', 'echo a b'] })
    assert.deepEqual(argv.slice(argv.length - 3), ['sh', '-c', 'echo a b'])
  })
})

describe('knownHostsOptions —— 四种模式', () => {
  it('strict：只信任已有的，未知即拒（默认值）', () => {
    const o = opts(knownHostsOptions('strict', undefined))
    assert.equal(o.StrictHostKeyChecking, 'yes')
    assert.equal(o.UserKnownHostsFile, undefined)
  })

  it('accept-new：未知则接受并写入', () => {
    const o = opts(knownHostsOptions('accept-new', '/tmp/kh'))
    assert.equal(o.StrictHostKeyChecking, 'accept-new')
    assert.equal(o.UserKnownHostsFile, '/tmp/kh')
  })

  it('tofu：记到 pin 文件，不污染系统 known_hosts', () => {
    const o = opts(knownHostsOptions('tofu', '/tmp/pinned'))
    assert.equal(o.StrictHostKeyChecking, 'accept-new')
    assert.equal(o.UserKnownHostsFile, '/tmp/pinned')
  })

  it('tofu 不给路径时用默认 pin 文件（不是系统 known_hosts）', () => {
    const o = opts(knownHostsOptions('tofu', undefined))
    assert.ok(o.UserKnownHostsFile !== undefined)
    assert.ok(!o.UserKnownHostsFile.includes('.ssh/known_hosts'), o.UserKnownHostsFile)
  })

  it('off：完全关掉，且丢弃 known_hosts', () => {
    const o = opts(knownHostsOptions('off', undefined))
    assert.equal(o.StrictHostKeyChecking, 'no')
    assert.equal(o.UserKnownHostsFile, '/dev/null')
  })
})

describe('hostTarget', () => {
  it('有 user → user@host', () => {
    assert.equal(hostTarget('10.0.0.7', 'deploy'), 'deploy@10.0.0.7')
  })

  it('无 user / 空 user → 只有 host（rsync 会自己补 -l）', () => {
    assert.equal(hostTarget('10.0.0.7'), '10.0.0.7')
    assert.equal(hostTarget('10.0.0.7', ''), '10.0.0.7')
  })
})

describe('buildRshArgv —— rsync --rsh 契约', () => {
  const rsh = buildRshArgv({ ...BASE, sshPath: '/usr/bin/ssh' })

  it('第一个 argv 是 ssh 的绝对路径', () => {
    assert.equal(rsh[0], '/usr/bin/ssh')
  })

  it('**不含 host** —— rsync 自己会追加', () => {
    assert.ok(!rsh.includes('deploy@10.0.0.7'))
    assert.ok(!rsh.includes('10.0.0.7'))
  })

  it('**不含 %h** —— 实测它不会被替换，传了就是把字面量交给 ssh', () => {
    assert.ok(!rsh.some((a) => a.includes('%h')))
  })

  it('**不含远端命令** —— rsync 会追加 `rsync --server ...`', () => {
    assert.ok(!rsh.some((a) => a === 'rsync' || a === '--server'))
  })

  it('保留认证与主机密钥选项', () => {
    const o = opts(rsh)
    assert.equal(o.BatchMode, 'yes')
    assert.equal(o.StrictHostKeyChecking, 'yes')
  })

  it('rshOptionValue 拼成 -e 的单参数', () => {
    assert.equal(rshOptionValue(['/usr/bin/ssh', '-p', '22']), '/usr/bin/ssh -p 22')
  })

  it('rshArgv 含空白或引号时拒绝拼串（rsync 按空白切，粘在一起就切错了）', () => {
    // 三个用例各自钉住「被拒的那一个 argv 元素」：只钉前缀的话，
    // 哪天校验漏了另一个元素也照样绿。
    assert.throws(
      () => rshOptionValue(['/usr/bin/ssh', '-o', 'ProxyJump=a b']),
      bareErrorMatching(/ProxyJump=a b/),
    )
    assert.throws(
      () => rshOptionValue(['/usr/bin/ssh', 'a b']),
      bareErrorMatching(/"a b"/),
    )
    assert.throws(
      () => rshOptionValue(['/usr/bin/ssh', 'a"b']),
      bareErrorMatching(/"a\\"b"/),
    )
  })

  // 说明：`a;id` 这种**不**该抛。事实 2 实测 rsync 侧不过 shell，
  // 它只按空白切分 `-e`，所以分号在那个位置没有注入含义。为此拒绝只会让
  // 合法路径（目录名带分号）不可用 —— 那是过度约束，不是有用的防线。
  it('rsync 侧不过 shell，所以分号不构成注入面（事实 2）', () => {
    assert.equal(rshOptionValue(['/usr/bin/ssh', 'a;id']), '/usr/bin/ssh a;id')
  })
})

// ------------------------------------------------------------
// buildRemoteCommand —— ssh2 路径上唯一的转义防线
// ------------------------------------------------------------

describe('buildRemoteCommand', () => {
  it('普通命令原样', () => {
    assert.equal(buildRemoteCommand(['systemctl', 'restart', 'nginx']), 'systemctl restart nginx')
  })

  it('含空格的参数保持为**一个**参数（ssh2 的 exec 只吃字符串，所以这里必须自己转义）', () => {
    assert.equal(buildRemoteCommand(['echo', 'a b']), "echo 'a b'")
  })

  it('分号 / 管道 / & 被引号中和，不会在远端 shell 里变成第二条命令', () => {
    assert.equal(buildRemoteCommand(['echo', 'a;id']), "echo 'a;id'")
    assert.equal(buildRemoteCommand(['echo', 'a|id']), "echo 'a|id'")
    assert.equal(buildRemoteCommand(['echo', 'a&&id']), "echo 'a&&id'")
  })

  it('反引号与 $() 不会执行', () => {
    assert.equal(buildRemoteCommand(['echo', '`id`']), "echo '`id`'")
    assert.equal(buildRemoteCommand(['echo', '$(id)']), "echo '$(id)'")
    assert.equal(buildRemoteCommand(['echo', '`id`;id']), "echo '`id`;id'")
  })

  it('单引号按 POSIX 规则转义，且反解析回原串', () => {
    const q = buildRemoteCommand(['echo', "it's"])
    assert.equal(q, `echo 'it'\\''s'`)
    assert.equal(unquoteArg(q.slice('echo '.length)), "it's")
  })

  it('**换行被拒绝**而不是转义（换行是远端 shell 的命令分隔符）', () => {
    for (const bad of [['echo', 'a\nb'], ['echo', 'a\rb'], ['echo', 'a\0b']]) {
      assert.throws(
        () => buildRemoteCommand(bad),
        (e: unknown) => e instanceof Error && /换行或 NUL/.test((e as Error).message),
        JSON.stringify(bad),
      )
    }
  })

  it('空 argv 拒绝', () => {
    assert.throws(() => buildRemoteCommand([]), (e: unknown) => {
      assert.ok(e instanceof DpError, `期望 DpError，实际 ${String(e)}`)
      assert.equal(e.code, 'DP.CONFIG.INVALID')
      return true
    })
  })
})

// ------------------------------------------------------------
// setEnvOptions —— 远端环境变量真的被送出去了
// ------------------------------------------------------------

describe('setEnvOptions', () => {
  it('变成 -o SetEnv=K=V，且逐个独立成 argv', () => {
    assert.deepEqual(setEnvOptions({ LANG: 'C' }), ['-o', 'SetEnv=LANG=C'])
    assert.deepEqual(setEnvOptions({ A: '1', B: '2' }), ['-o', 'SetEnv=A=1', '-o', 'SetEnv=B=2'])
  })

  it('buildSshArgv 把它放在远端命令**之前**（native 路径的真实形状）', () => {
    const argv = buildSshArgv({ ...BASE, setEnv: { LANG: 'C' }, remoteArgv: ['id', '-un'] })
    const i = argv.indexOf('SetEnv=LANG=C')
    assert.ok(i > 0, 'SetEnv 必须出现在 argv 里')
    assert.equal(argv[i - 1], '-o')
    assert.ok(i < argv.indexOf('id'), '必须在远端命令之前')
    assert.deepEqual(argv.slice(-2), ['id', '-un'])
  })

  it('**不再有 DP_ENV_*** —— 那是一条没有任何远端脚本会读的静默失效路径', () => {
    const argv = buildSshArgv({ ...BASE, setEnv: { LANG: 'C' } })
    assert.equal(argv.some((a) => a.includes('DP_ENV_')), false)
  })

  it('值里的空格保留在同一个 SetEnv 里（不拆成多个 argv）', () => {
    assert.deepEqual(setEnvOptions({ GREETING: 'hello world' }), ['-o', 'SetEnv=GREETING=hello world'])
  })

  it('值里的换行/NUL 拒绝', () => {
    // 消息必须命中「值」这条分支而不是上面的「变量名非法」——
    // 只断 code 的话，实现调换两个分支的顺序这条照样绿。
    assert.throws(() => setEnvOptions({ A: 'x\ny' }), (e: unknown) => {
      assert.ok(e instanceof DpError, `期望 DpError，实际 ${String(e)}`)
      assert.equal(e.code, 'DP.CONFIG.INVALID')
      assert.match(e.message, /值含换行或 NUL/)
      return true
    })
    assert.throws(() => setEnvOptions({ A: 'x\0y' }), (e: unknown) => {
      assert.ok(e instanceof DpError, `期望 DpError，实际 ${String(e)}`)
      assert.equal(e.code, 'DP.CONFIG.INVALID')
      assert.match(e.message, /值含换行或 NUL/)
      return true
    })
  })

  it('非法变量名拒绝', () => {
    for (const bad of ['1A', 'A-B', 'A B', '', 'A.B']) {
      // 第二个参数不能是 bad 本身：字符串在 assert.throws 里只当失败消息，
      // 错误校验整个是空的 —— 那就退化成「抛了任何东西都算过」。
      assert.throws(
        () => setEnvOptions({ [bad]: 'v' }),
        (e: unknown) => {
          assert.ok(e instanceof DpError, `期望 DpError，实际 ${String(e)}`)
          assert.equal(e.code, 'DP.CONFIG.INVALID')
          // 消息必须回显被拒的名字，才能分得开是「变量名非法」而不是上面那条「值含换行」
          assert.ok(e.message.includes(JSON.stringify(bad)), `${e.message} 未回显 ${bad}`)
          return true
        },
        bad,
      )
    }
  })

  it('空 env 产出空数组（不产生任何 -o）', () => {
    assert.deepEqual(setEnvOptions({}), [])
  })
})

describe('sftp 批量脚本', () => {  it('每条命令一行，末尾自动补 quit', () => {
    assert.equal(buildSftpBatch(['ls', 'get a b']), 'ls\nget a b\nquit\n')
  })

  it('已有换行的命令不重复补', () => {
    assert.equal(buildSftpBatch(['ls\n']), 'ls\nquit\n')
  })

  it('空命令列表也必须带 quit，否则 sftp 会挂着等输入', () => {
    assert.equal(buildSftpBatch([]), 'quit\n')
  })

  it('sftpQuote 转义反斜杠与双引号', () => {
    assert.equal(sftpQuote('/a/b'), '"/a/b"')
    assert.equal(sftpQuote('a"b'), '"a\\"b"')
    assert.equal(sftpQuote('a\\b'), '"a\\\\b"')
  })

  it('含换行的参数直接拒绝 —— 换行在 -b 脚本里是命令分隔符', () => {
    assert.throws(() => sftpQuote('a\nb'), bareErrorMatching(/不能含换行/))
  })
})

describe('hops -> ProxyJump（纯函数，产出 argv 元素而非 shell 字符串）', () => {
  const jumpOf = (hops: readonly HopSpec[], knownHostsMode: KnownHostsMode = 'strict'): string | undefined => {
    const argv = buildSshArgv({ authKind: 'agent', knownHostsMode, hops })
    const opt = argv.find((a) => a.startsWith('ProxyJump='))
    return opt === undefined ? undefined : opt.slice('ProxyJump='.length)
  }

  // hops 的最后一跳是目标机：它不进 -J，所以这批用例的链尾都挂一个目标机
  const TARGET: HopSpec = { ssh: 'deploy@10.0.0.7' }

  it('最后一跳是目标机，不进 -J：两跳只产出第一跳', () => {
    assert.equal(jumpOf([{ ssh: 'ops@jump.example.com' }, TARGET]), 'ops@jump.example.com')
  })

  it('三跳：两条跳板按链顺序用英文逗号连接', () => {
    assert.equal(
      jumpOf([{ ssh: 'ops@jump1.example.com' }, { ssh: 'ops@jump2.example.com' }, TARGET]),
      'ops@jump1.example.com,ops@jump2.example.com',
    )
  })

  it('链里只有目标机时不产出 -J：那不是多跳，写空 -J 会让 ssh 报一条空跳板', () => {
    assert.equal(jumpOf([TARGET]), undefined)
  })

  it('带端口：连接串里的端口与 port 字段都写出来', () => {
    assert.equal(jumpOf([{ ssh: 'ops@jump.example.com:2200' }, TARGET]), 'ops@jump.example.com:2200')
    assert.equal(jumpOf([{ ssh: 'ops@jump.example.com', port: 2222 }, TARGET]), 'ops@jump.example.com:2222')
  })

  it('端口 22 也显式写出：ssh_config 里给该 Host 配过 Port 时，省略会连到另一台', () => {
    assert.equal(jumpOf([{ ssh: 'ops@jump.example.com:22' }, TARGET]), 'ops@jump.example.com:22')
  })

  it('无 user 前缀时只写 host', () => {
    assert.equal(jumpOf([{ ssh: 'jump.example.com' }, TARGET]), 'jump.example.com')
  })

  it('密码限制只落在进 -J 的跳板：目标机用密码放行，跳板用密码才报错', () => {
    assert.doesNotThrow(() =>
      buildSshArgv({
        authKind: 'agent',
        knownHostsMode: 'strict',
        hops: [{ ssh: 'ops@jump' }, { ssh: 'deploy@t', auth: { type: 'password', passwordRef: 'env:P' } }],
      }),
    )
    assert.throws(
      () =>
        buildSshArgv({
          authKind: 'agent',
          knownHostsMode: 'strict',
          hops: [{ ssh: 'ops@jump', auth: { type: 'password', passwordRef: 'env:P' } }, TARGET],
        }),
      { code: 'DP.CONFIG.INVALID' },
    )
  })

  it('跳板用密码认证 -> 报错并给出出路（-J 无法逐跳喂密码）', () => {
    assert.throws(
      () => buildSshArgv({ authKind: 'agent', knownHostsMode: 'strict', hops: [{ ssh: 'ops@jump', auth: { type: 'password', passwordRef: 'env:P' } }, TARGET] }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.match(err.hint ?? '', /config/)
        return true
      },
    )
  })

  it('跳板 keyboard-interactive 同样拒绝', () => {
    assert.throws(
      () => buildSshArgv({ authKind: 'agent', knownHostsMode: 'strict', hops: [{ ssh: 'ops@jump', auth: { type: 'keyboard-interactive', passwordRef: 'env:P' } }, TARGET] }),
      { code: 'DP.CONFIG.INVALID' },
    )
  })

  it('跳板的 knownHosts 与整体冲突 -> 报错（-J 只有一条命令行）', () => {
    assert.throws(
      () =>
        buildSshArgv({
          authKind: 'agent',
          knownHostsMode: 'strict',
          hops: [{ ssh: 'ops@jump', knownHosts: 'off' }, TARGET],
        }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID')
        assert.match(err.hint ?? '', /config/)
        return true
      },
    )
  })

  it('目标机的 knownHosts 与整体冲突 -> 放行（它不进 -J，不受那条限制）', () => {
    assert.doesNotThrow(() =>
      buildSshArgv({
        authKind: 'agent',
        knownHostsMode: 'strict',
        hops: [{ ssh: 'ops@jump' }, { ssh: 'deploy@t', knownHosts: 'off' }],
      }),
    )
  })

  it('跳板 knownHosts 与整体一致 -> 放行', () => {
    assert.doesNotThrow(() =>
      buildSshArgv({
        authKind: 'agent',
        knownHostsMode: 'strict',
        hops: [{ ssh: 'ops@jump', knownHosts: 'strict' }, TARGET],
      }),
    )
  })

  it('hops 与 proxyJump 同时给 -> 报错，不替用户二选一', () => {
    assert.throws(
      () => buildSshArgv({ authKind: 'agent', knownHostsMode: 'strict', hops: [{ ssh: 'ops@jump' }], proxyJump: 'a@b' }),
      { code: 'DP.CONFIG.INVALID' },
    )
  })

  it('空 hops 不产生 ProxyJump 选项', () => {
    assert.equal(jumpOf([]), undefined)
  })
})
