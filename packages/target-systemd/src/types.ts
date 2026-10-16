import type { SystemdRestartPolicy } from '@dp/ports'
import type { RenderContext } from '@dp/template'

/**
 * unit 的运行范围。
 *
 * `system` 级的 unit 目录（`/etc/systemd/system`）通常要提权才写得进；
 * `user` 级不需要提权，但**只在用户会话存活期间运行** —— linger 没开的话人一注销服务就停。
 * 这不是缺陷而是它的语义，所以按 scope 分开记，不合并成一个「能写就写」的自动选择。
 */
export type SystemdScope = 'system' | 'user'

/**
 * systemd 目标的执行输入。**只描述要写出一份什么样的 unit**，
 * 不负责推导它落在哪台机器的哪个目录。
 */
export interface SystemdTargetConfig {
  /**
   * unit 文件名，**不含目录**。默认 `<项目名>.service`。
   */
  readonly unit?: string
  /**
   * unit 目录（目标机绝对路径）。**由上层从 layout 推导后注入** ——
   * 本包零 IO，不探测也不读环境；目标机路径不是配置项。
   */
  readonly unitDir: string
  readonly scope?: SystemdScope
  readonly description?: string
  /** `ExecStart=` 的值。必填：没有启动行，unit 就是一份起不来的文件 */
  readonly execStart: string
  readonly execReload?: string
  readonly workingDirectory?: string
  readonly user?: string
  readonly group?: string
  /** `Environment=` 的键值。渲染后逐条输出，值里带空格时 systemd 需要引号 */
  readonly environment?: Readonly<Record<string, string>>
  /** 默认 `on-failure`：正常退出（含 0）不该被无限重启 */
  readonly restart?: SystemdRestartPolicy
  readonly restartSec?: number
  readonly after?: readonly string[]
  readonly requires?: readonly string[]
  readonly wantedBy?: string
  /**
   * 逃生舱。**逐行**原样输出，不做转义。
   *
   * 只挡一件事：行里的控制字符。unit 是「一行一条指令」的格式，
   * 一行里塞进换行就等于凭空多出几条指令 —— 那不是逃生舱，是注入口。
   */
  readonly extra?: readonly string[]
  /** 覆盖未带 `# managed by dp` 标记的现存 unit（仍先备份） */
  readonly force?: boolean
  /**
   * 渲染上下文（`${env.NAME}`、`${release.current}` 等的值）。**注入而非读环境**：
   * 自己去读 process.env 会让 plan() 不再是纯函数。
   */
  readonly render: RenderContext
}
