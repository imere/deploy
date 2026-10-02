import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectPrompt, promptHint, PROMPT_PATTERNS, type PromptPattern } from './prompt.js'

const hit = (text: string, extra?: readonly PromptPattern[]) => detectPrompt(text, extra)

describe('detectPrompt —— 必须命中的真实提示符', () => {
  const cases: readonly [string, string][] = [
    ['密码提示（小写）', 'password:'],
    ['密码提示（大写）', 'Password:'],
    ['sudo 自己的措辞', '[sudo] password for deploy:'],
    ['sudo 简写', 'sudo password:'],
    ['su 的措辞', 'su:'],
    ['OpenSSH 的密码提示', "deploy@dp-target's password:"],
    ['密钥 passphrase', "Enter passphrase for key '/home/deploy/.ssh/id_ed25519':"],
    ['裸 passphrase', 'passphrase:'],
    ['首次连接的指纹确认', 'The authenticity of host ... can\'t be established.\nAre you sure you want to continue connecting (yes/no/[fingerprint])?'],
    ['Y/n 确认', 'Do you want to continue [Y/n]?'],
    ['y/n 确认', 'Are you sure (y/n)? '],
    ['sudo 无 tty', 'sudo: no tty present and no askpass program specified'],
    ['sudo 需要终端', 'sudo: a terminal is required to read the password'],
    ['doas', 'doas (user@host) password:'],
    ['PIN', 'PIN:'],
    ['二次验证', 'Verification code:'],
    ['一次性口令', 'One-time code:'],
  ]

  for (const [name, text] of cases) {
    it(name, () => {
      const m = hit(text)
      assert.ok(m !== undefined, `没命中：${JSON.stringify(text)}`)
      assert.ok(m.line.length > 0)
    })
  }

  it('提示符带前导空格/尾随空格也命中', () => {
    assert.ok(hit('   Password:  ') !== undefined)
    assert.ok(hit('\tpassword:') !== undefined)
  })

  it('提示符夹在多行输出的中间也能命中', () => {
    const m = hit('line one\nsome warning\nPassword:\n')
    assert.equal(m?.kind, 'password')
  })
})

describe('detectPrompt —— 绝不能误伤正常输出', () => {
  const safe: readonly string[] = [
    'nginx: password file updated',
    'Changing password for user deploy.',
    'sshd: PasswordAuthentication yes',
    '配置项 password_auth 已开启',
    'error: too many authentication failures',
    'deployment finished: 12 files, password-protected entries skipped',
    'INFO  loaded config with password from vault ref env:DEPLOY_PASSWORD',
    'ok',
    '',
    'PasswordAuthentication is the right option name',
    'no interactive prompt here',
    'y/n is not a question here',
    'the sudo: field in config is empty',
  ]

  for (const line of safe) {
    it(`不命中：${JSON.stringify(line)}`, () => {
      assert.equal(hit(line), undefined)
    })
  }

  it('多行日志里含 password 词也不命中', () => {
    const log = [
      '2026-01-01 boot ok',
      'changing password for user deploy',
      'service nginx: active (running)',
      'deployment complete',
    ].join('\n')
    assert.equal(hit(log), undefined)
  })

  it('很长的行跳过不扫（普通日志不该被当成提示符）', () => {
    const long = `Password: ${'x'.repeat(300)}`
    assert.equal(hit(long), undefined)
  })
})

describe('detectPrompt —— 额外模式', () => {
  it('调用方可以追加本机特有的模式', () => {
    const custom: PromptPattern[] = [{ kind: 'su-password', re: /^请输入密码[:：]\s*$/ }]
    assert.equal(hit('请输入密码：'), undefined)
    assert.ok(hit('请输入密码：', custom) !== undefined)
  })

  it('追加模式排在内置模式之后', () => {
    const custom: PromptPattern[] = [{ kind: 'password', re: /^Password:\s*$/ }]
    const m = hit('Password:', custom)
    assert.equal(m?.kind, 'password')
  })

  it('CRLF 输出同样命中', () => {
    assert.ok(hit('Password:\r\n') !== undefined)
  })
})

describe('模式表与提示的性质', () => {
  it('全部模式都不含跨行匹配（避免正则回溯与误判）', () => {
    for (const { re } of PROMPT_PATTERNS) {
      assert.equal(re.flags.includes('g'), false, re.source)
    }
  })

  it('每种 kind 都有对应 hint，且 hint 指向可执行的下一步', () => {
    const kinds = new Set(PROMPT_PATTERNS.map((p) => p.kind))
    for (const kind of kinds) {
      const h = promptHint(kind)
      assert.ok(h.length > 10, `${kind} 的 hint 太短`)
    }
  })

  it('hint 里不出现凭据字样', () => {
    for (const { re } of PROMPT_PATTERNS) {
      const kind = PROMPT_PATTERNS.find((p) => p.re === re)!.kind
      assert.doesNotMatch(promptHint(kind), /password\s*=\s*\S/)
    }
  })

  it('sudo-no-tty 的 hint 指向 NOPASSWD 而不是让用户去输密码', () => {
    assert.match(promptHint('sudo-no-tty'), /NOPASSWD/)
  })

  it('su 的 hint 说清楚为什么不能等输入', () => {
    assert.match(promptHint('su-password'), /tty/)
  })
})

describe('detectPrompt —— PIN 提示（硬件密钥 / 智能卡）', () => {
  // 只认裸 `PIN:` 会漏掉带对象的写法，漏判的后果是挂在那里等人类输入（铁律 0）
  it('Enter PIN for <对象>: 必须命中', () => {
    for (const line of [
      "Enter PIN for 'My Token': ",
      "Enter PIN for 'PIV Card':",
      'Enter PIN for key:',
    ]) {
      assert.equal(detectPrompt(line)?.kind, 'pin', `${line} 应命中 pin`)
    }
  })

  it('裸 PIN: 仍然命中', () => {
    assert.equal(detectPrompt('PIN:')?.kind, 'pin')
  })

  it('不误伤含 PIN 的普通输出', () => {
    assert.equal(detectPrompt('pinned host key SHA256:abc'), undefined)
  })
})
