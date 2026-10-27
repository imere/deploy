/**
 * 配置里的提权 → 运行形态的提权。
 *
 * 单独一份是因为它有两个消费者：`apply` 的传输层要它去包远端命令，
 * `facts` 的可写性探测也要它 —— 探测按登录用户去探、写入却提权去写，
 * 是「明明配了免密 sudo，`/etc/nginx/conf.d` 却被判不可写」那一类错的标准形状。
 */
import { ERR, DpError, type BecomeConfig } from '@dp/ports'
import type { HostConfig } from '@dp/schema'

/**
 * schema 的 become（配置形态）→ ports 的 become（运行形态）。
 *
 * 两个形状不一样是刻意的：配置形态带 method / passwordRef（凭据解析是
 * schema 的职责），运行形态只描述「怎么提权」。
 *
 * 有两类配置**明确拒绝**而不是凑一个值出来 —— 歧义靠拒绝，不靠默认值：
 *  - `custom`：schema 里没有承载命令模板的字段，凑一个就是凭空发明行为；
 *  - `method: stdin | pty`：要密码的提权，而运行形态没有密码通道。
 */
export function becomeFor(hostConfig: HostConfig, path: string): BecomeConfig | undefined {
  const b = hostConfig.become
  if (b === undefined) return undefined
  switch (b.type) {
    case 'none':
      return { type: 'none' }
    case 'sudo': {
      // stdin / pty 意味着「sudo 要问密码」。传输层没有密码通道（passwordRef 是
      // schema 的事，BecomeConfig 里根本没有承载它的字段），而 @dp/ssh 对
      // nonInteractive=false 的处理是**直接拒绝**（become.ts：铁律 0 不许等 stdin）。
      // 与其让它在深处抛一句看不懂的 refusal，不如在这里说清「没接」。
      if (b.method === 'stdin' || b.method === 'pty') {
        throw new DpError(ERR.CONFIG.INVALID, `become.method=${b.method} 尚未接入传输层`, {
          path: `${path}.become.method`,
          hint: '传输层没有密码通道，带密码的 sudo 会撞铁律 0。请配免密 sudo（nopasswd）或改用 su',
        })
      }
      return {
        type: 'sudo',
        ...(b.user !== undefined ? { user: b.user } : {}),
        nonInteractive: true,
      }
    }
    case 'doas':
      return { type: 'doas', ...(b.user !== undefined ? { user: b.user } : {}) }
    case 'su': {
      if (b.user === undefined || b.user === '') {
        throw new DpError(ERR.CONFIG.INVALID, 'become.type=su 必须写 become.user', {
          path: `${path}.become.user`,
          hint: 'su 不给用户名就没有目标身份，写成 { "type": "su", "user": "www-data" }',
        })
      }
      return { type: 'su', user: b.user }
    }
    case 'custom': {
      // schema 已保证 template 存在且含 ${cmd}；这里再兜一次是因为本函数也会被
      // 不经过 schema 的路径调用（测试夹具、--facts 旁路），「custom 一定有模板」
      // 得在代码里也成立，否则 wrapCommand 会在更深处抛一个不带配置项位置的错
      if (b.template === undefined || b.template.trim() === '') {
        throw new DpError(ERR.CONFIG.INVALID, 'become.type=custom 缺少 template', {
          path: `${path}.become.template`,
          hint: '模板形如 `dzdo -u root ${cmd}`；${cmd} 会被替换成被提权的那条命令',
        })
      }
      return { type: 'custom', template: b.template }
    }
  }
}
