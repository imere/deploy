import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DpError, type DpErrorCode } from '@dp/ports'
import { ELEVATE_FAILED_HINT, summarizeElevateFailure, wrapCommand, type BecomeConfig } from './become.js'

const CMD = ['systemctl', 'restart', 'nginx']

/**
 * 反解析一条 `su -c` 脚本：按 POSIX 规则把引号去掉，还原出原参数。
 * 没有它就只能在字符串层面比对，而字符串比对证明不了「没被拆错」。
 */
function unquoteScript(script: string): string {
  let out = ''
  let i = 0
  let started = false
  while (i < script.length) {
    const c = script[i]!
    if (c === ' ' || c === '\t' || c === '\n') {
      if (started) {
        out += '\u0000'
        started = false
      }
      i++
      continue
    }
    started = true
    if (c === "'") {
      i++
      while (i < script.length) {
        if (script[i] === "'") {
          if (script[i + 1] === '\\' && script[i + 2] === "'" && script[i + 3] === "'") {
            out += "'"
            i += 4
            continue
          }
          i++
          break
        }
        out += script[i]
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out.endsWith('\u0000') ? out.slice(0, -1) : out
}

/**
 * 铁律 0 的可测形式：产出的 argv 里**不能有**任何会从 stdin 读东西的东西。
 * `sudo -S` 会、`su` 会、`doas` 在某些实现会；`-n` 是"绝不询问"。
 */
function assertNeverWaitsForStdin(argv: readonly string[]): void {
  assert.ok(!argv.includes('-S'), `产出了会从 stdin 读密码的 -S：${argv.join(' ')}`)
  assert.ok(!argv.includes('-a'), `产出了会从 stdin 读密码的 -a：${argv.join(' ')}`)
  // 任何"交互式读取"的标志都不能出现
  for (const interactive of ['-i', '-p', '--askpass', '-K', '-v']) {
    assert.ok(!argv.includes(interactive), `产出了交互标志 ${interactive}：${argv.join(' ')}`)
  }
}

describe('become: none', () => {
  it('原样返回', () => {
    assert.deepEqual(wrapCommand(CMD, { type: 'none' }), CMD)
  })

  it('不产生会等 stdin 的命令', () => {
    assertNeverWaitsForStdin(wrapCommand(CMD, { type: 'none' }))
  })
})

describe('become: sudo', () => {
  it('不带 user → sudo -n -- <cmd>', () => {
    assert.deepEqual(wrapCommand(CMD, { type: 'sudo' }), ['sudo', '-n', '--', ...CMD])
  })

  it('带 user → -u <user> 在 -- 之前', () => {
    assert.deepEqual(wrapCommand(CMD, { type: 'sudo', user: 'root' }), [
      'sudo',
      '-n',
      '-u',
      'root',
      '--',
      ...CMD,
    ])
  })

  it('带 group → -g <group>', () => {
    const argv = wrapCommand(CMD, { type: 'sudo', user: 'www-data', group: 'www' })
    assert.deepEqual(argv, ['sudo', '-n', '-g', 'www', '-u', 'www-data', '--', ...CMD])
  })

  it('nonInteractive:false → 去掉 -n，但仍需要显式密码通道', () => {
    const argv = wrapCommand(CMD, { type: 'sudo', nonInteractive: false }, { passwordChannel: true })
    assert.deepEqual(argv, ['sudo', '--', ...CMD])
    // 去掉 -n 之后唯一的兜底就是调用方声明自己有通道
    assertNeverWaitsForStdin(argv)
  })

  it('nonInteractive:false 且没有密码通道 → 必须拒绝并解释', () => {
    assert.throws(
      () => wrapCommand(CMD, { type: 'sudo', nonInteractive: false }),
      (err: unknown) => {
        assert.ok(err instanceof DpError)
        assert.equal(err.code, 'DP.CONFIG.INVALID' as DpErrorCode)
        assert.match(err.message, /等待 stdin/)
        assert.ok(err.hint !== undefined && err.hint.length > 0, '必须有 hint')
        return true
      },
    )
  })

  it('永远不带 -E（不保留用户环境，否则 LD_PRELOAD 会跟着过去）', () => {
    assert.ok(!wrapCommand(CMD, { type: 'sudo', user: 'root' }).includes('-E'))
  })

  it('默认与显式 nonInteractive:true 形状一致', () => {
    assert.deepEqual(
      wrapCommand(CMD, { type: 'sudo' }),
      wrapCommand(CMD, { type: 'sudo', nonInteractive: true }),
    )
  })
})

describe('become: doas', () => {
  it('doas -n -- <cmd>', () => {
    assert.deepEqual(wrapCommand(CMD, { type: 'doas' }), ['doas', '-n', '--', ...CMD])
  })

  it('带 user', () => {
    assert.deepEqual(wrapCommand(CMD, { type: 'doas', user: 'root' }), [
      'doas',
      '-n',
      '-u',
      'root',
      '--',
      ...CMD,
    ])
  })

  it('不产生会等 stdin 的命令', () => {
    assertNeverWaitsForStdin(wrapCommand(CMD, { type: 'doas', user: 'root' }))
  })
})

describe('become: su', () => {
  it('su <user> -c <escaped script>', () => {
    assert.deepEqual(wrapCommand(CMD, { type: 'su', user: 'root' }), [
      'su',
      'root',
      '-c',
      'systemctl restart nginx',
    ])
  })

  it('带 shell', () => {
    assert.deepEqual(wrapCommand(CMD, { type: 'su', user: 'root', shell: '/bin/sh' }), [
      'su',
      'root',
      '-s',
      '/bin/sh',
      '-c',
      'systemctl restart nginx',
    ])
  })

  it('双层引号：参数里的单引号被逐参数转义，不做裸插值', () => {
    const argv = wrapCommand(['grep', "it's"], { type: 'su', user: 'root' })
    assert.equal(argv[3], `grep 'it'\\''s'`)
  })

  it('转义后的脚本按 POSIX 规则反解析回原参数（属性测试）', () => {
    // 随机但确定的一组串：含引号、空格、$、反引号、换行、shell 元字符
    const samples = [
      "it's",
      'a b',
      '$HOME',
      '`id`',
      '$(id)',
      'a\nb',
      "'; id; '",
      '""',
      "a'b'c",
      '`whoami`x',
      'a"b',
      'back\\slash',
    ]
    for (const arg of samples) {
      const script = wrapCommand([arg], { type: 'su', user: 'root' })[3]!
      assert.equal(unquoteScript(script), arg, JSON.stringify(arg))
    }
  })

  it('含空格/分号的参数不会逃出 -c 的引号', () => {
    const argv = wrapCommand(['echo', 'a b; id'], { type: 'su', user: 'root' })
    assert.equal(argv[3], `echo 'a b; id'`)
  })

  it('自定义转义器可注入（作用于每一个参数）', () => {
    const argv = wrapCommand(['echo', 'x'], { type: 'su', user: 'root' }, { shellEscape: (a) => `[${a}]` })
    assert.equal(argv[3], '[echo] [x]')
  })
})

describe('become: custom', () => {
  it('${cmd} 替换为已转义的整条命令，再按空格切 argv', () => {
    assert.deepEqual(wrapCommand(CMD, { type: 'custom', template: 'dzdo -u root ${cmd}' }), [
      'dzdo',
      '-u',
      'root',
      'systemctl',
      'restart',
      'nginx',
    ])
  })

  it('模板里其他部分也按空格切（模板作者负责 quoting）', () => {
    assert.deepEqual(wrapCommand(['id'], { type: 'custom', template: 'pbrun id ${cmd}' }), [
      'pbrun',
      'id',
      'id',
    ])
  })

  it('命令含空格时保持为单个 argv 元素', () => {
    assert.deepEqual(wrapCommand(['echo', 'a b'], { type: 'custom', template: 'run ${cmd}' }), [
      'run',
      'echo',
      'a b',
    ])
  })

  it('多个 ${cmd} 都会被替换', () => {
    assert.deepEqual(wrapCommand(['id'], { type: 'custom', template: 'a ${cmd} b ${cmd}' }), [
      'a',
      'id',
      'b',
      'id',
    ])
  })

  it('模板不含 ${cmd} → 拒绝（原命令会被静默丢掉）', () => {
    assert.throws(
      () => wrapCommand(CMD, { type: 'custom', template: 'dzdo -u root' }),
      (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
    )
  })
})

describe('wrapCommand 的共同不变量', () => {
  const all: readonly BecomeConfig[] = [
    { type: 'none' },
    { type: 'sudo' },
    { type: 'sudo', user: 'root' },
    { type: 'sudo', nonInteractive: false },
    { type: 'doas' },
    { type: 'doas', user: 'root' },
    { type: 'su', user: 'root' },
    { type: 'custom', template: 'x ${cmd}' },
  ]

  it('任何一种 become 都不会产出会等 stdin 的命令（铁律 0）', () => {
    for (const become of all) {
      const argv = wrapCommand(CMD, become, { passwordChannel: true })
      assertNeverWaitsForStdin(argv)
    }
  })

  it('原命令始终出现在产出的尾部（没有参数被 eat）', () => {
    for (const become of all) {
      const argv = wrapCommand(CMD, become, { passwordChannel: true })
      // sudo/doas 用 `--` 分隔；none / su / custom 靠位置保证
      if (become.type === 'sudo' || become.type === 'doas') {
        assert.ok(argv.includes('--'), become.type)
        assert.deepEqual(argv.slice(argv.indexOf('--') + 1), CMD, become.type)
      } else {
        // su 把整条命令拼进 -c 的单个字符串，none/custom 保持逐参数
        assert.ok(argv.join(' ').includes('nginx'), become.type)
      }
    }
  })

  it('空 argv 一律拒绝', () => {
    for (const become of all) {
      assert.throws(
        () => wrapCommand([], become, { passwordChannel: true }),
        (err: unknown) => err instanceof DpError && err.code === 'DP.CONFIG.INVALID',
        become.type,
      )
    }
  })
})

describe('提权失败的提示', () => {
  it('ELEVATE_FAILED_HINT 指向 sudoers 白名单而不是自动提权', () => {
    assert.match(ELEVATE_FAILED_HINT, /NOPASSWD/)
    assert.match(ELEVATE_FAILED_HINT, /不会替你改/)
  })

  it('summarizeElevateFailure 取首行并截断', () => {
    assert.equal(summarizeElevateFailure('\n\n  a password is required\nmore'), 'a password is required')
    assert.equal(summarizeElevateFailure(''), '（目标机没有输出任何原因）')
    assert.equal(summarizeElevateFailure('x'.repeat(500)).length, 200)
  })
})
