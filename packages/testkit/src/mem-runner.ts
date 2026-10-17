import assert from 'node:assert/strict'
import {
  CURRENT_LINK_NAME,
  DpError,
  type ExecOptions,
  type ExecResult,
  type Facts,
  type FileStat,
  type Runner,
} from '@dp/ports'

/** 树上的一个节点。三个参照桩的交集：既存文件也存软链，目录与文件用同一种判断走完 Runner 接口 */
interface Node {
  kind: 'dir' | 'file' | 'link'
  content?: string
  target?: string
}

/**
 * 一次 exec 的台账。`argv` 复制成新数组、`options` 原样收下：
 * 断言「cwd / timeoutMs / stdin 逐元素对不对」时读这里，而不是在实现里再猜一遍。
 */
export interface ExecCall {
  readonly argv: readonly string[]
  readonly options?: ExecOptions
}

/**
 * 未命中注册应答时的兜底判定。返回 undefined 等于「这条命令不在计划内」；返回一个结果就是放行。
 * nginx 家族用它接管 -t 的影子校验语义，而不是把判定语义写死进公共件。
 */
type ExecFallback = (argv: readonly string[], index: number) => ExecResult | undefined

/** 可选项说明见字段注释 */
export interface MemoryRunnerOptions {
  /**
   * 家族兜底：按 (argv, 第几次) 给出应答，undefined = 计划之外照旧抛错。
   */
  defaultExec?: ExecFallback
  /**
   * writeFile 要求父目录已存在并当场报错。nginx 影子目录那批用例要「漏 mkdir 当场失败」；
   * 关掉时写文件不检查父目录（static / cli 家族的历史语义，deploy 自行先 mkdir）。
   */
  requireParentDir?: boolean
}

/**
 * 内存 Runner —— 三个包测试桩（target-static / target-nginx / target-docker / cli·ops）的公共语义：
 * 文件树模拟 + exec 录制 + 按注册应答，各家特有探针不进这里，靠 options 或测试文件自己补。
 *
 * exec 的默认立场是「未注册 = 计划之外的命令」：返回 code 0 的话，执行器跑错命令根本测不出来。
 */
export class MemoryRunner implements Runner {
  readonly id = 'memory'
  readonly facts: Facts
  /** 每一次 exec 的台账，出现的顺序即真实发生的顺序 */
  readonly execs: ExecCall[] = []
  private readonly tree = new Map<string, Node>()
  private readonly responses = new Map<string, ExecResult>()
  private readonly fallback?: ExecFallback
  private readonly strictParent: boolean

  constructor(facts: Facts, options: MemoryRunnerOptions = {}) {
    this.facts = facts
    this.tree.set('/', { kind: 'dir' })
    this.fallback = options.defaultExec
    this.strictParent = options.requireParentDir === true
  }

  /**
   * 按 argv 注册固定应答。key 用不可见分隔符拼整段 argv —— 路径里有空格也不会串味。
   *
   * @param argv 完整的命令数组，逐元素精确匹配
   * @param result 这次 exec 应返回的固定结果
   */
  on(argv: readonly string[], result: ExecResult): void {
    this.responses.set([...argv].join('\u0000'), result)
  }

  /** 已执行的全部 argv，按发生顺序。等元素断言防「两个参数被拼成一个」 */
  argvs(): readonly (readonly string[])[] {
    return this.execs.map((e) => e.argv)
  }

  async exec(argv: readonly string[], options?: ExecOptions): Promise<ExecResult> {
    this.execs.push({ argv: [...argv], ...(options !== undefined ? { options } : {}) })
    const hit = this.responses.get([...argv].join('\u0000'))
    if (hit !== undefined) return hit
    const over = this.fallback?.(argv, this.execs.length - 1)
    if (over !== undefined) return over
    throw new Error(`内存 Runner 收到计划外的 exec：${JSON.stringify(argv)}`)
  }

  async stat(path: string): Promise<FileStat | null> {
    const n = this.tree.get(path)
    if (n === undefined) return null
    return {
      isDirectory: n.kind === 'dir',
      isSymbolicLink: n.kind === 'link',
      size: n.content?.length ?? 0,
      mtimeMs: 0,
    }
  }

  async listDir(path: string): Promise<readonly string[]> {
    const out: string[] = []
    for (const key of this.tree.keys()) {
      if (key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')) {
        out.push(key.slice(path.length + 1))
      }
    }
    return out
  }

  /** 递归建目录。真机器上螺丝是逐级的，漏建父目录在这里被兜住而不是在生产上炸 */
  async mkdir(path: string): Promise<void> {
    const parts = path.split('/').filter((p) => p !== '')
    for (let i = 1; i <= parts.length; i++) {
      const p = `/${parts.slice(0, i).join('/')}`
      if (this.tree.get(p) === undefined) this.tree.set(p, { kind: 'dir' })
    }
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    if (this.strictParent) {
      const parent = path.slice(0, path.lastIndexOf('/')) || '/'
      if (this.tree.get(parent) === undefined) {
        throw new DpError('DP.PATH.NOT_WRITABLE', `ENOENT：父目录不存在 ${parent}`)
      }
    } else {
      // 宽松档隐式物化父目录链：static 的 entries 直写从不 mkdir staging（签名只给路径），
      // 靠的就是 writeFile 会把父链建出来；父链没有目录节点，rename staging 时树上是空的，
      // 「rename 缺源即报错」这条铁语义就会把正常的部署流程当场打死。
      await this.mkdir(path.slice(0, path.lastIndexOf('/')) || '/')
    }
    this.tree.set(path, {
      kind: 'file',
      content: typeof data === 'string' ? data : new TextDecoder().decode(data),
    })
  }

  async readFile(path: string): Promise<string> {
    const n = this.tree.get(path)
    if (n === undefined) throw new DpError('DP.PATH.NOT_WRITABLE', `不存在：${path}`)
    return n.content ?? ''
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new TextEncoder().encode(await this.readFile(path))
  }

  async remove(path: string): Promise<void> {
    for (const key of [...this.tree.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.tree.delete(key)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    if (this.tree.get(from) === undefined) {
      throw new DpError('DP.PATH.NOT_WRITABLE', `不存在：${from}`)
    }
    await this.remove(to)
    const nodes = [...this.tree.entries()].filter(([k]) => k === from || k.startsWith(`${from}/`))
    for (const [k, v] of nodes) {
      this.tree.set(to + k.slice(from.length), v)
      this.tree.delete(k)
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (!this.facts.capabilities.canSymlink) {
      throw new DpError('DP.PATH.NOT_WRITABLE', '不支持软链')
    }
    this.tree.set(linkPath, { kind: 'link', target })
  }

  async readlink(path: string): Promise<string | null> {
    return this.tree.get(path)?.target ?? null
  }

  async realpath(path: string): Promise<string> {
    return path
  }

  /**
   * 同步窥视树上的一个路径：文件给内容、软链给 target，目录与不存在的路径给 null。
   * Runner 接口全是异步的，而断言里要的只是一眼读数 —— `runner.peek(p) ?? ''`
   * 比一路 await 短得多。各家测试桩里的同名方法语义与此一致，迁移即删本地版。
   */
  peek(path: string): string | null {
    const n = this.tree.get(path)
    if (n === undefined) return null
    if (n.kind === 'file') return n.content ?? ''
    return n.target ?? null
  }
}

/**
 * 铁律 0 的机器化检查：每条 exec 都必须带 timeoutMs，且永远不喂 stdin。
 * 不变量跟着测试走 —— 调用方在每个用例收尾处调它，漏了 timeout 或喂了 stdin 的命令当场红。
 *
 * @param runner 一次用例里真正跑过的那个 Runner。只认按 {@link ExecCall} 形状记的台账：
 *                本地测试桩用自己的 exec 录制（不必是 {@link MemoryRunner}）同样能过这道检查
 */
export function assertExecInvariants(runner: { readonly execs: readonly ExecCall[] }): void {
  for (const call of runner.execs) {
    assert.notEqual(call.options?.timeoutMs, undefined, `exec 缺 timeoutMs：${JSON.stringify(call.argv)}`)
    assert.equal(call.options?.stdin, undefined, `exec 喂了 stdin：${JSON.stringify(call.argv)}`)
  }
}

/**
 * 读发布根上 current 软链指向的版本 id。断言「现在线上是哪一版」的最短写法；
 * 不造第二个 current 名字 —— 软链名取自 ports 的常量。
 *
 * @param runner 目标机通道，读软链只走它的 readlink
 * @param root 发布根目录
 * @returns 软链目标最后一段作为版本 id；没有软链给 null
 */
export async function currentReleaseId(runner: Runner, root: string): Promise<string | null> {
  const link = await runner.readlink(`${root}/${CURRENT_LINK_NAME}`)
  if (link === null) return null
  return link.slice(link.lastIndexOf('/') + 1)
}
