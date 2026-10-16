import type { ProcessStopSignal } from '@dp/ports'
import type { RenderContext } from '@dp/template'

/**
 * 裸进程目标的执行输入。
 *
 * 它**自带极简进程管理**：pidfile 记 pid，停止走「先信号后强杀」，存活靠 `kill -0`。
 * 不接 pm2 / supervisord 一类外部进程管理器 —— 它们要进目标机的依赖清单，
 * 于是「目标机没装 pm2」会在部署期被报成「打包漏了东西」，而真正的原因是环境缺件。
 *
 * 目标机不支持这一套时（比如 Windows），本包直接拒绝而不是退成「起了但活不下来」。
 */
export interface ProcessTargetConfig {
  /**
   * argv[0]。**不是一行 shell** —— 它会被原样 exec，不经 shell 解释。
   */
  readonly command: string
  readonly args?: readonly string[]
  /** 默认 `${release.current}`（当前生效版本目录） */
  readonly workingDirectory?: string
  readonly env?: Readonly<Record<string, string>>
  /** 默认 `SIGTERM`。只收「给进程收尾机会」的那几个信号 */
  readonly stopSignal?: ProcessStopSignal
  /** 优雅期，毫秒。它是**上限**而不是「等它结束」 */
  readonly stopTimeoutMs?: number
  /**
   * pidfile 路径，**相对发布根目录**。
   *
   * 固定位置而非跟着版本目录走，是因为激活时要先停掉「当前跑着的那个」——
   * 而「当前是哪个」此时还没确定。
   */
  readonly pidFile?: string
  /** stdout / stderr 的落盘位置，相对发布根目录 */
  readonly stdoutLog?: string
  /** 渲染上下文。注入而非读环境 */
  readonly render: RenderContext
}
