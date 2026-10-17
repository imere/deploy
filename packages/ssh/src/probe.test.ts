import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DriverExecResult, ExecRequest, SshDriver, SshDriverKind } from './driver.js'
import { probeCreatableRemote } from './probe.js'

/**
 * 只认脚本、按登记内容回话的驱动。
 *
 * 不用 `FakeSshDriver`：它只认带 `#dp-op` 头的 posix 脚本，而这里要断言的是「脚本长什么样」——
 * 一个会把不认识的东西一律打成退出码 5 的假驱动，恰恰看不到要验的东西。
 */
function scriptDriver(
  reply: (script: string) => DriverExecResult | Promise<DriverExecResult>,
): { driver: SshDriver; scripts: string[] } {
  const scripts: string[] = []
  const driver = {
    kind: 'ssh2' as SshDriverKind,
    async available() {
      return { ok: true }
    },
    async exec(req: ExecRequest) {
      const script = req.argv[2] ?? ''
      scripts.push(script)
      return reply(script)
    },
    async close() {},
  }
  return { driver: driver as unknown as SshDriver, scripts }
}

const ok = (stdout: string): DriverExecResult => ({ code: 0, stdout, stderr: '' })

describe('probeCreatableRemote · 脚本形态', () => {
  it('发了「往上找第一个存在的目录」与「真建文件再删」这两段 —— 缺任何一段，发布根的可写性都是假的', async () => {
    const { driver, scripts } = scriptDriver(() => ok(''))
    await probeCreatableRemote(driver, ['/srv/web'])
    const script = scripts[0] ?? ''
    assert.ok(/nearest\(\)/.test(script), `脚本里没有 nearest()：不存在的发布根会被直接判死\n${script}`)
    assert.ok(/\[ ! -d "\$d" \]/.test(script), `nearest() 没有判目录是否存在\n${script}`)
    assert.ok(/\.dp-w-/.test(script), `没有真建探测文件：只读挂载与 ACL 会骗过 access()\n${script}`)
    // 冒到根就停：dirname / 还是 /，不判会死循环
    assert.ok(/dirname "\$d"/.test(script), `nearest() 没有用 dirname 往上冒\n${script}`)
  })

  it('脚本里出现的是**入参原样路径**，不是它展开后的祖先 —— 否则 canWrite 的键与发布根对不上', async () => {
    const { driver, scripts } = scriptDriver(() => ok(''))
    await probeCreatableRemote(driver, ['/srv/web', '/opt/web'])
    const script = scripts[0] ?? ''
    assert.ok(script.includes('/srv/web'), `脚本里没有 /srv/web\n${script}`)
    assert.ok(script.includes('/opt/web'), `脚本里没有 /opt/web\n${script}`)
  })

  it('多条路径只发一次 exec（每条都真实往返一次的话，跳板链上就是几秒）', async () => {
    const { driver, scripts } = scriptDriver(() => ok(''))
    await probeCreatableRemote(driver, ['/srv/web', '/opt/web', '/var/www/web'])
    assert.equal(scripts.length, 1, `应该是 1 次 exec，实际 ${scripts.length} 次`)
  })
})

describe('probeCreatableRemote · 结论', () => {
  it('按 DPW 行的路径建键，值为 1 才记 true', async () => {
    const { driver } = scriptDriver(() => ok('DPW\t/srv/web\t1\nDPW\t/opt/web\t0\n'))
    const got = await probeCreatableRemote(driver, ['/srv/web', '/opt/web'])
    assert.equal(got.canWrite['/srv/web'], true)
    assert.equal(got.canWrite['/opt/web'], false, '远端说写不进去就必须记 false，不能因为它在候选表里就放宽')
  })

  it('known 里已有的结论不再发 exec —— 每次探测都是真 IO，重复测同一个目录纯属浪费', async () => {
    const { driver, scripts } = scriptDriver(() => ok(''))
    const got = await probeCreatableRemote(driver, ['/srv/web'], { '/srv/web': true })
    assert.equal(scripts.length, 0, '已有结论还去远端问了一次')
    assert.equal(got.canWrite['/srv/web'], true)
  })

  it('known 只有一部分时，只补测缺的那些', async () => {
    const { driver, scripts } = scriptDriver(() => ok('DPW\t/opt/web\t1\n'))
    await probeCreatableRemote(driver, ['/srv/web', '/opt/web'], { '/srv/web': false })
    const script = scripts[0] ?? ''
    assert.ok(script.includes('/opt/web'), `该补测的没发：${script}`)
    assert.equal(script.includes('/srv/web'), false, `已测过的还发了一遍：${script}`)
  })

  it('远端没给结果行的路径保守记 false，且 notes 里写明「没能实测」', async () => {
    const { driver } = scriptDriver(() => ok('DPW\t/opt/web\t1\n'))
    const got = await probeCreatableRemote(driver, ['/srv/web', '/opt/web'])
    assert.equal(got.canWrite['/srv/web'], false, '没有结论就是没有依据，不能当可写')
    assert.equal(
      got.notes.some((n) => n.includes('/srv/web') && n.includes('没能实测')),
      true,
      `notes 里没有说明 /srv/web 为什么是 false：${got.notes.join(' | ')}`,
    )
  })

  it('driver 抛错：全部保守记 false，且不把异常吞掉（notes 里带着原因）', async () => {
    const driver = {
      kind: 'ssh2',
      async available() {
        return { ok: true }
      },
      async exec() {
        throw new Error('connection reset')
      },
      async close() {},
    } as unknown as SshDriver
    const got = await probeCreatableRemote(driver, ['/srv/web'])
    assert.equal(got.canWrite['/srv/web'], false)
    assert.equal(
      got.notes.some((n) => n.includes('connection reset')),
      true,
      `notes 里没有带上失败原因：${got.notes.join(' | ')}`,
    )
  })

  it('空路径表不发 exec —— 没有项目名时不该为「补测」多跑一趟', async () => {
    const { driver, scripts } = scriptDriver(() => ok(''))
    const got = await probeCreatableRemote(driver, [])
    assert.equal(scripts.length, 0)
    assert.deepEqual(got.canWrite, {})
  })
})
