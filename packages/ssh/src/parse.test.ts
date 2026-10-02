import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySshError,
  hostKeyHint,
  parseArch,
  parseFingerprint,
  parseInit,
  parseLinger,
  parsePlatform,
  parseSshG,
  parseStatLine,
  parseSudoList,
  parseToolPaths,
  sshGValue,
  truncateOutput,
  TRUNCATE_MARK,
} from './parse.js'

describe('parseSshG', () => {
  const sample = [
    'user deploy',
    'hostname 10.0.0.7',
    'port 2222',
    'identityfile ~/.ssh/id_ed25519',
    'identityfile ~/.ssh/id_rsa',
    'stricthostkeychecking yes',
    'proxyjump ops@jump.example.com',
    'sendenv LANG',
    'sendenv LC_*',
    '# comment',
    '',
  ].join('\n')

  it('key → value', () => {
    const g = parseSshG(sample)
    assert.equal(sshGValue(g, 'user'), 'deploy')
    assert.equal(sshGValue(g, 'hostname'), '10.0.0.7')
    assert.equal(sshGValue(g, 'port'), '2222')
  })

  it('重复键全部保留（identityfile / sendenv）', () => {
    const g = parseSshG(sample)
    assert.deepEqual(g['identityfile'], ['~/.ssh/id_ed25519', '~/.ssh/id_rsa'])
    assert.deepEqual(g['sendenv'], ['LANG', 'LC_*'])
  })

  it('忽略注释与空行', () => {
    assert.equal(sshGValue(parseSshG(sample), 'comment'), undefined)
  })

  it('空输入得到空对象', () => {
    assert.deepEqual(parseSshG(''), {})
  })

  it('畸形输入不抛', () => {
    assert.doesNotThrow(() => parseSshG('\0\0\0\n   \n===\n'))
  })
})

describe('parseFingerprint', () => {
  it('SHA256 形式', () => {
    const f = parseFingerprint('256 SHA256:7bKx0svQ1k9Zq8pLm3nR5tYw2EjHcVdFuAoIgNbXk9U user@host (ED25519)')
    assert.ok(f !== undefined)
    assert.equal(f.bits, 256)
    assert.equal(f.fingerprint, 'SHA256:7bKx0svQ1k9Zq8pLm3nR5tYw2EjHcVdFuAoIgNbXk9U')
    assert.equal(f.keyType, 'ed25519')
    assert.equal(f.sha256, true)
  })

  it('RSA 也能解析', () => {
    const f = parseFingerprint('3072 SHA256:abc def host (RSA)')
    assert.equal(f?.keyType, 'rsa')
  })

  it('MD5 形式标 sha256:false（SHA-1 已不可信，不能当匹配依据）', () => {
    const f = parseFingerprint('2048 aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99 host (RSA)')
    assert.equal(f?.sha256, false)
    assert.equal(f?.fingerprint.startsWith('aa:bb'), true)
  })

  it('畸形输入返回 undefined 而不是抛', () => {
    for (const bad of ['', 'not a fingerprint', '256', 'zzz SHA256:xxx host (ED25519)']) {
      assert.equal(parseFingerprint(bad), undefined, bad)
    }
  })

  it('多行输入取第一行非空', () => {
    const f = parseFingerprint('\n\n256 SHA256:x y (ED25519)\n')
    assert.equal(f?.fingerprint, 'SHA256:x')
  })
})

describe('uname 归一化', () => {
  it('platform', () => {
    assert.equal(parsePlatform('Linux'), 'linux')
    assert.equal(parsePlatform('Darwin'), 'darwin')
    assert.equal(parsePlatform('FreeBSD'), 'freebsd')
    assert.equal(parsePlatform('MINGW64_NT-10.0'), 'unknown')
    assert.equal(parsePlatform(''), 'unknown')
    assert.equal(parsePlatform('  Linux  '), 'linux')
  })

  it('arch', () => {
    assert.equal(parseArch('x86_64'), 'x64')
    assert.equal(parseArch('aarch64'), 'arm64')
    assert.equal(parseArch('i686'), 'x86')
    assert.equal(parseArch('armv7l'), 'arm')
    assert.equal(parseArch('riscv64'), 'other')
    assert.equal(parseArch(''), 'other')
  })
})

describe('parseInit —— PID 1 的真名 + 工具弱证据', () => {
  it('认得 systemd', () => {
    assert.equal(parseInit('systemd', {}), 'systemd')
    assert.equal(parseInit('systemd-journald', {}), 'systemd')
  })

  it('认得 openrc / runit / launchd', () => {
    assert.equal(parseInit('init-openrc', {}), 'openrc')
    assert.equal(parseInit('runit', {}), 'sysvinit')
    assert.equal(parseInit('s6-svscan', {}), 'sysvinit')
    assert.equal(parseInit('launchd', {}), 'launchd')
  })

  it('认不出名字时退到工具弱证据', () => {
    assert.equal(parseInit('weird', { systemctl: '/usr/bin/systemctl' }), 'systemd')
    assert.equal(parseInit('weird', { rcService: '/sbin/rc-service' }), 'openrc')
  })

  it('什么都没有 → none（不猜）', () => {
    assert.equal(parseInit('weird', {}), 'none')
    assert.equal(parseInit('', {}), 'none')
  })
})

describe('parseLinger', () => {
  it('Linger=yes → true', () => {
    assert.equal(parseLinger('Linger=yes'), true)
  })

  it('Linger=no → false', () => {
    assert.equal(parseLinger('Linger=no'), false)
  })

  it('拼错/缺字段/空 → 保守 false', () => {
    for (const bad of ['', 'Linger=true', 'Linger=1', 'garbage', 'Linger=yes extra', 'Linger=']) {
      assert.equal(parseLinger(bad), false, bad)
    }
  })

  it('大小写与尾随空格不敏感（loginctl 恒为小写，放宽只影响这一个自造字段）', () => {
    assert.equal(parseLinger('Linger=YES'), true)
    assert.equal(parseLinger('linger=yes'), true)
    assert.equal(parseLinger('Linger=yes  '), true)
  })
})

describe('parseSudoList —— 「能 sudo 哪几条」而不是「能不能 sudo」', () => {
  it('(ALL) NOPASSWD: ALL', () => {
    assert.deepEqual(parseSudoList('User deploy may run the following commands:\n    (ALL) NOPASSWD: ALL\n'), [
      'ALL',
    ])
  })

  it('白名单里的多条命令被逐条取出', () => {
    const out = parseSudoList(
      ['(root) NOPASSWD: /usr/bin/systemctl, /usr/bin/tar', '    (deploy) NOPASSWD: /bin/systemctl'].join('\n'),
    )
    assert.deepEqual(out.sort(), ['/bin/systemctl', '/usr/bin/systemctl', '/usr/bin/tar'])
  })

  it('无 sudo 权限 → []', () => {
    assert.deepEqual(parseSudoList('', 'Sorry, user deploy may not run sudo on host.'), [])
  })

  it('不在 sudoers 里 → []', () => {
    assert.deepEqual(parseSudoList('', 'deploy is not in the sudoers file'), [])
  })

  it('带密码的 ALL 不计入 —— 它们会挂住，与铁律 0 冲突', () => {
    assert.deepEqual(parseSudoList('    (ALL : ALL) ALL\n    (ALL) ALL\n'), [])
  })

  it('settag 之类的 VAR=value 噪声被排除', () => {
    assert.deepEqual(parseSudoList('    (ALL) NOPASSWD: SETENV: /bin/ls, /bin/cat'), ['/bin/ls', '/bin/cat'])
  })

  it('空输入与畸形输入 → []，不抛', () => {
    assert.deepEqual(parseSudoList(''), [])
    assert.doesNotThrow(() => parseSudoList('\0\n  \n=== NOPASSWD:'))
  })
})

describe('parseToolPaths', () => {
  it('DPT\\t<name>\\t<path|-> → tools 形状', () => {
    const out = parseToolPaths(['DPT\tssh\t/usr/bin/ssh', 'DPT\tnginx\t-', 'DPT\trsync\t/usr/bin/rsync'].join('\n'))
    assert.equal(out['ssh'], '/usr/bin/ssh')
    assert.equal(out['nginx'], null)
    assert.equal(out['rsync'], '/usr/bin/rsync')
  })

  it('缺行的工具不算存在', () => {
    assert.equal(parseToolPaths('DPT\tssh\t/usr/bin/ssh')['docker'], undefined)
  })

  it('无标记的行被忽略', () => {
    assert.deepEqual(parseToolPaths('hello\nworld'), {})
  })

  it('畸形行不抛', () => {
    assert.doesNotThrow(() => parseToolPaths('DPT\tonly-two-fields\nDPT\t\t\n'))
  })
})

describe('parseStatLine', () => {
  it('DPSTAT\\tkind\\tsize\\tmtime', () => {
    const s = parseStatLine('DPSTAT\tfile\t1234\t1700000000\n')
    assert.deepEqual(s, { kind: 'file', size: 1234, mtimeSec: 1700000000 })
  })

  it('link / dir', () => {
    assert.equal(parseStatLine('DPSTAT\tlink\t5\t1')?.kind, 'link')
    assert.equal(parseStatLine('DPSTAT\tdir\t0\t2')?.kind, 'dir')
  })

  it('未知 kind 归为 other，不猜', () => {
    assert.equal(parseStatLine('DPSTAT\tsocket\t0\t1')?.kind, 'other')
  })

  it('非数字字段退回 0', () => {
    const s = parseStatLine('DPSTAT\tfile\txx\tyy')
    assert.equal(s?.size, 0)
    assert.equal(s?.mtimeSec, 0)
  })

  it('缺标签或字段不足 → undefined', () => {
    assert.equal(parseStatLine('nothing here'), undefined)
    assert.equal(parseStatLine('DPSTAT\tfile'), undefined)
  })
})

describe('truncateOutput —— 保留头尾，防炸内存', () => {
  it('未超限原样返回', () => {
    assert.equal(truncateOutput('hello', 100), 'hello')
  })

  it('超限时头尾都在，中间有截断标记', () => {
    const out = truncateOutput('A'.repeat(500) + 'B'.repeat(500), 100)
    assert.ok(out.startsWith('A'))
    assert.ok(out.trimEnd().endsWith('B'))
    assert.ok(out.includes(TRUNCATE_MARK), out.slice(0, 80))
    assert.ok(Buffer.byteLength(out) < 600, `结果应该远小于原文：${Buffer.byteLength(out)}`)
  })

  it('标记里带被丢掉的字节数', () => {
    const out = truncateOutput('x'.repeat(1000), 100)
    assert.match(out, /truncated \d+ bytes/)
  })

  it('多字节字符不产生半个 UTF-8 序列', () => {
    const out = truncateOutput('日'.repeat(400), 200)
    assert.equal(out.includes('\uFFFD'), false, '出现了替换字符，说明按字节切断了多字节字符')
  })
})

describe('classifySshError —— 顺序敏感', () => {
  it('主机密钥不匹配优先于未知', () => {
    const f = classifySshError(
      '@@@@@@@@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@@@@@@@@\nssh-ed25519 AAAAC3Nza dp-target\nHost key verification failed.',
      255,
    )
    assert.equal(f.code, 'DP.SSH.HOST_KEY_MISMATCH')
  })

  it('未知主机', () => {
    const f = classifySshError('No ED25519 host key is known for dp-target and you have requested strict checking.', 255)
    assert.equal(f.code, 'DP.SSH.HOST_KEY_UNKNOWN')
  })

  it('认证失败', () => {
    assert.equal(classifySshError('dp@host: Permission denied (publickey,password).', 255).code, 'DP.SSH.AUTH_FAILED')
    assert.equal(classifySshError('Too many authentication failures', 255).code, 'DP.SSH.AUTH_FAILED')
  })

  it('连不上', () => {
    assert.equal(classifySshError('ssh: connect to host 10.0.0.7 port 22: Connection refused', 255).code, 'DP.SSH.CONNECT_FAILED')
    assert.equal(classifySshError('ssh: Could not resolve hostname dp-target: Name or service not known', 255).code, 'DP.SSH.CONNECT_FAILED')
  })

  it('认不出来时归 CONNECT_FAILED 而不是瞎猜成 AUTH', () => {
    assert.equal(classifySshError('some brand new OpenSSH wording we have never seen', 255).code, 'DP.SSH.CONNECT_FAILED')
  })

  it('空 stderr 也给出可用的 reason', () => {
    assert.equal(classifySshError('', 1).reason, 'ssh 退出码 1')
  })
})

describe('hostKeyHint —— 必须告诉用户「我们不会自动改」', () => {
  it('mismatch 给出期望/实际指纹与手动更新指引', () => {
    const h = hostKeyHint({
      code: 'DP.SSH.HOST_KEY_MISMATCH',
      reason: 'r',
      expected: 'SHA256:old',
      actual: 'SHA256:new',
    })
    assert.match(h, /SHA256:old/)
    assert.match(h, /SHA256:new/)
    assert.match(h, /手动更新/)
    assert.match(h, /不会自动改/)
  })

  it('unknown 指向 accept-new / tofu', () => {
    const h = hostKeyHint({ code: 'DP.SSH.HOST_KEY_UNKNOWN', reason: 'r' })
    assert.match(h, /accept-new/)
    assert.match(h, /tofu/)
  })
})
