import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DpError, type Facts, type Runner } from '@dp/ports'
import {
  acquireFacts,
  hopJumpStrings,
  parseSshTarget,
  nearestExistingDir,
  releaseRootCandidates,
  resolveSshEndpoint,
} from './facts-source.js'

describe('facts-source · 发布根候选按平台分流（纯）', () => {
  const home = process.platform === 'win32' ? 'C:/Users/u' : '/home/u'

  it('win32 上不出现 /srv、/opt 这类 POSIX 候选', () => {
    const got = releaseRootCandidates('web', home, {}, 'win32')
    assert.ok(got.length > 0)
    for (const p of got) {
      assert.ok(
        !/^[A-Za-z]:?[\\/]?(srv|opt|var|usr)[\\/]/i.test(p) && !p.startsWith('/srv'),
        `win32 不该出现 POSIX 候选：${p}`,
      )
    }
  })

  it('linux 上不出现 %ProgramData% 这类 Windows 候选', () => {
    const got = releaseRootCandidates('web', home, {}, 'linux')
    for (const p of got) {
      assert.ok(!p.includes('ProgramData') && !p.includes('LOCALAPPDATA'), `linux 不该出现 Windows 候选：${p}`)
    }
    assert.ok(
      got.some((p) => p.startsWith('/srv/') || p.startsWith('/opt/') || p.includes('/apps/')),
      `linux 候选应该有 POSIX 路径，实际 ${got.join(' | ')}`,
    )
  })

  it('同一平台下三种布局的候选都被展开且去重', () => {
    const got = releaseRootCandidates('web', home, {}, 'linux')
    assert.equal(new Set(got).size, got.length, '候选不该有重复')
    // system / hybrid / user 至少各有一个，否则某一种布局会永远选不到发布根
    assert.ok(got.some((p) => p.startsWith('/opt/')), `缺 system 类候选：${got.join(' | ')}`)
    assert.ok(got.some((p) => p.includes('/apps/')), `缺 user 类候选：${got.join(' | ')}`)
  })

  it('unknown 平台回退到 ~/apps，不会返回空', () => {
    const got = releaseRootCandidates('web', home, {}, 'unknown')
    assert.ok(got.length > 0, 'unknown 平台也要有候选，否则 plan 必然失败')
  })
})

describe('facts-source · 纯解析', () => {
  it('parseSshTarget：user@host:port', () => {
    assert.deepEqual(parseSshTarget('deploy@10.0.0.5:2222', 'p'), {
      user: 'deploy',
      host: '10.0.0.5',
      port: 2222,
    })
  })

  it('parseSshTarget：不写端口就不猜 22（交给驱动）', () => {
    assert.deepEqual(parseSshTarget('deploy@10.0.0.5', 'p'), { user: 'deploy', host: '10.0.0.5' })
  })

  it('parseSshTarget：端口越界 / 非数字 → 明确报错', () => {
    for (const bad of ['h:0', 'h:70000', 'h:abc']) {
      assert.throws(() => parseSshTarget(bad, 'p'), { code: 'DP.CONFIG.INVALID' }, `应该拒绝 ${bad}`)
    }
  })

  it('nearestExistingDir：一路冒到已存在的祖先，最差停在自己身上', () => {
    const root = process.platform === 'win32' ? 'C:/' : '/'
    assert.equal(nearestExistingDir(root), root, '根自身存在时就是它')
    // 一个几乎肯定不存在的深路径：不能无限循环，必须收敛到某个已存在的祖先
    const deep = `${root}no-such-dir-${Date.now()}/a/b/c`
    const got = nearestExistingDir(deep)
    assert.notEqual(got, deep)
    assert.ok(got.length < deep.length)
  })
})

/**
 * hops 的语义：**最后一跳就是目标机**。这些断言钉的正是这一点 ——
 * 把目标机从链里去掉或重复加进 -J，症状都是「连到了另一台机器」，
 * 而那两次连接很可能都成功。
 */
describe('facts-source · hops 推导（纯）', () => {
  const key = { type: 'key' as const, identityFile: 'hop-key' }

  it('两跳链：目标是最后一跳，hops 是完整链条', () => {
    const got = resolveSshEndpoint(
      { layout: 'auto',
        hops: [
          { ssh: 'jump@jump.internal', auth: { type: 'agent' } },
          { ssh: 'deploy@10.0.0.5:2222', auth: key },
        ],
      },
      'hosts.web',
    )
    assert.equal(got.host, '10.0.0.5', 'host 必须是最后一跳（目标机），不是第一跳')
    assert.equal(got.user, 'deploy')
    assert.equal(got.port, 2222)
    assert.equal(got.hops?.length, 2, 'hops 必须是整条链，不是只有跳板')
    assert.equal(got.hops?.[0]?.ssh, 'jump@jump.internal')
    assert.equal(got.hops?.[1]?.ssh, 'deploy@10.0.0.5:2222')
  })

  it('单跳链（hops 只有一跳）= 目标机，不产出多余跳板', () => {
    const got = resolveSshEndpoint({ layout: 'auto', hops: [{ ssh: 'deploy@10.0.0.5', auth: key }] }, 'hosts.web')
    assert.equal(got.host, '10.0.0.5')
    assert.equal(got.hops?.length, 1)
    // 一条跳板都没有时不该产出 -J：写成空 ProxyJump 会被 OpenSSH 当成一条空跳板而报错
    assert.equal(hopJumpStrings(got.hops), undefined, '单跳链不该产出跳板串')
  })

  it('hopJumpStrings 只含跳板，不含目标机', () => {
    const got = resolveSshEndpoint(
      { layout: 'auto',
        hops: [
          { ssh: 'jump1@jump-a:2201', auth: { type: 'agent' } },
          { ssh: 'jump2@jump-b', auth: { type: 'agent' } },
          { ssh: 'deploy@10.0.0.5:2222', auth: key },
        ],
      },
      'hosts.web',
    )
    assert.deepEqual(hopJumpStrings(got.hops), ['jump1@jump-a:2201', 'jump2@jump-b'])
  })

  it('ssh 与 hops 都没有 → 报错，且文案把 hops 算作合法来源', () => {
    assert.throws(() => resolveSshEndpoint({ layout: 'auto', local: true }, 'hosts.web'), (e: DpError) => {
      assert.equal(e.code, 'DP.CONFIG.INVALID')
      assert.ok(e.hint?.includes('hops'), `hint 必须提到 hops，否则配了跳板链的用户会以为自己没配：${e.hint}`)
      return true
    })
  })

  it('ssh 与 hops 同时给 → 报错（配置层之外也要成立「二选一」）', () => {
    assert.throws(
      () => resolveSshEndpoint({ layout: 'auto', ssh: 'a@h1', hops: [{ ssh: 'b@h2', auth: key }] }, 'hosts.web'),
      { code: 'DP.CONFIG.INVALID' },
    )
  })

  it('目标机端口冲突（串里 vs port 字段）→ 报错，不替用户选', () => {
    assert.throws(
      () =>
        resolveSshEndpoint(
          { layout: 'auto', hops: [{ ssh: 'jump@j1', auth: { type: 'agent' } }, { ssh: 'deploy@10.0.0.5:2222', auth: key, port: 2200 }] },
          'hosts.web',
        ),
      (e: DpError) => {
        assert.equal(e.code, 'DP.CONFIG.INVALID')
        assert.equal(e.path, 'hosts.web.hops[1].port', 'path 必须指向出错的那一跳')
        return true
      },
    )
  })

  it('hops 为空数组按「没给」处理，报错而不是当成一条空链', () => {
    assert.throws(() => resolveSshEndpoint({ layout: 'auto', hops: [] }, 'hosts.web'), { code: 'DP.CONFIG.INVALID' })
  })

  it('单跳 ssh 路径不变：不产出 hops', () => {
    const got = resolveSshEndpoint({ layout: 'auto', ssh: 'deploy@10.0.0.5:2222' }, 'hosts.web')
    assert.equal(got.hops, undefined, '单跳不该产出 hops，否则会与 proxyJump 撞车')
    // 放在 deepEqual 之后会因为 assert 的类型收窄把 hops 从类型上抹掉
    assert.deepEqual(got, { host: '10.0.0.5', user: 'deploy', port: 2222 })
  })
})

describe('facts-source · 认证绝不继承', () => {
  it('中间跳没给 auth 时不兜底 —— 留着空让驱动报错，绝不复制目标机凭据', () => {
    const targetAuth = { type: 'key' as const, identityFile: 'target-only' }
    const got = resolveSshEndpoint({ layout: 'auto', hops: [{ ssh: 'jump@jump.internal' }, { ssh: 'deploy@10.0.0.5' }] }, 'hosts.web', targetAuth)
    assert.equal(got.hops?.[0]?.auth, undefined, '中间跳不许继承目标机的凭据')
    assert.deepEqual(got.hops?.[1]?.auth, targetAuth, '最后一跳才认整体 auth')
  })

  it('中间跳缺 auth：路径指向那一跳，且连接层会据此报错', () => {
    const got = resolveSshEndpoint({ layout: 'auto', hops: [{ ssh: 'jump@jump.internal' }, { ssh: 'deploy@10.0.0.5' }] }, 'hosts.web', {
      type: 'key',
      identityFile: 'target-only',
    })
    // 拒绝发生在 @dp/ssh 的 planHopChain（那里才有逐跳的 auth 校验，且不是公开导出）。
    // 本包该保证的只有一件事：**不替它补 auth**。补了就是把目标机的钥匙递到跳板上，
    // 而 planHopChain 之后再也查不出这件事发生过。
    const chain = got.hops!
    assert.equal(chain[0]?.auth, undefined, '中间跳的 auth 必须留空')
    assert.equal(chain[0]?.ssh, 'jump@jump.internal')
    assert.equal(chain.length, 2, '目标机仍在链里，只是没有凭据')
  })

  it('目标机显式给了 auth 时以配置为准，不被整体 auth 覆盖', () => {
    const explicit = { type: 'key' as const, identityFile: 'from-config' }
    const got = resolveSshEndpoint({ layout: 'auto', hops: [{ ssh: 'jump@j1', auth: { type: 'agent' } }, { ssh: 'deploy@10.0.0.5', auth: explicit }] }, 'hosts.web', {
      type: 'key',
      identityFile: 'from-env',
    })
    assert.deepEqual(got.hops?.[1]?.auth, explicit)
  })
})

/**
 * 接线本身的断言。
 *
 * 这一组要挡的是**最难发现的那类错**：推导函数完全正确、纯函数测试全绿，
 * 只是调用方忘了把 `hops` 放进 `SshConnectionOptions` —— 功能仍然是断的，
 * 而单测一片绿。所以必须从 `acquireFacts` 这一端往里看**实际传出去的东西**。
 */
describe('facts-source · hops 真的传到了连接层', () => {
  const fakeFacts = { host: 'placeholder' } as unknown as Facts

  function recordingConnect(): { options: () => unknown; connect: Parameters<typeof acquireFacts>[0]['connect'] } {
    let captured: unknown
    const connect: Parameters<typeof acquireFacts>[0]['connect'] = async (opts) => {
      captured = opts
      return {
        facts: fakeFacts,
        probeNotes: [],
        runner: {} as Runner,
        close: async () => {},
      } as unknown as Awaited<ReturnType<NonNullable<typeof connect>>>
    }
    return { options: () => captured, connect }
  }

  it('acquireFacts 把整条 hops 链与目标机一起交给 connectSsh', async () => {
    const rec = recordingConnect()
    await acquireFacts({
      hostId: 'web',
      host: { layout: 'auto',
        hops: [
          { ssh: 'jump@jump.internal', auth: { type: 'agent' } },
          { ssh: 'deploy@10.0.0.5:2222' },
        ],
      },
      // 认不出来的凭据来源就用 agent：断言的是 hops 有没有传下去，不是 auth 怎么推出来的
      env: { DP_SSH_KEY: 'some-key' },
      connect: rec.connect,
    })
    const got = rec.options() as { host: string; port?: number; hops?: readonly { ssh: string; auth?: unknown }[] }
    assert.equal(got.host, '10.0.0.5', '连的必须是最后一跳（目标机）')
    assert.equal(got.port, 2222)
    assert.equal(got.hops?.length, 2, 'hops 没传下去或被截断 = 多跳仍然是断的')
    assert.equal(got.hops?.[0]?.ssh, 'jump@jump.internal')
    assert.equal(got.hops?.[1]?.ssh, 'deploy@10.0.0.5:2222')
  })

  it('中间跳的 auth 没有被目标机的凭据污染（送到连接层时仍然为空）', async () => {
    const rec = recordingConnect()
    await acquireFacts({
      hostId: 'web',
      host: { layout: 'auto', hops: [{ ssh: 'jump@jump.internal' }, { ssh: 'deploy@10.0.0.5' }] },
      env: { DP_SSH_KEY: 'some-key' },
      connect: rec.connect,
    })
    const got = rec.options() as { hops?: readonly { auth?: unknown }[] }
    assert.equal(got.hops?.[0]?.auth, undefined, '目标机的凭据绝不能出现在跳板上')
    assert.deepEqual(got.hops?.[1]?.auth, { type: 'key', identityFile: 'some-key' })
  })

  it('单跳主机不产出 hops（老路径没被改坏）', async () => {
    const rec = recordingConnect()
    await acquireFacts({
      hostId: 'web',
      host: { layout: 'auto', ssh: 'deploy@10.0.0.5:2222' },
      env: { DP_SSH_KEY: 'some-key' },
      connect: rec.connect,
    })
    const got = rec.options() as { host: string; hops?: unknown }
    assert.equal(got.host, '10.0.0.5')
    assert.equal(got.hops, undefined)
  })
})
