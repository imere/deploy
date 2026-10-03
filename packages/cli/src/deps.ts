/**
 * apply 的**依赖装配点** —— 生产走真实现，测试注入假的。
 *
 * 为什么需要它：`dp apply` 对远端主机要真连 ssh、真起 rsync/tar。测试里这两件事
 * 一个都不许发生（测试不许连网络；本机也没有 rsync），所以事实获取与
 * 传输执行**都**必须可注入 —— 只注入传输不够，连接那一步同样会在测试里真连。
 *
 * 形状刻意与 @dp/transport 的 `transfer` 完全一致：注入方拿到的就是生产函数签名，
 * 不存在「测试专用签名」那种只在测试里成立、于是掩盖了真实不兼容的接缝。
 */
import { probeLocalFacts } from '@dp/local'
import { transfer } from '@dp/transport'
import type { TransferRequest, TransferResult } from '@dp/transport'
import { acquireFacts, type FactsRequest, type FactsResult } from './facts-source.js'

export interface ApplyDeps {
  /** 目标机事实 + 那条已连上的连接。装配期失败必须由调用方兜住 */
  readonly acquireFacts: (request: FactsRequest) => Promise<FactsResult>
  /** 本机事实。协商的另一端 */
  readonly probeLocalFacts: () => Promise<Awaited<ReturnType<typeof probeLocalFacts>>>
  /**
   * 传输执行。绝不真连的测试从这里塞假的。
   * 依赖类型由 transfer 的真实签名反推（`Parameters<typeof transfer>[1]`），
   * 而不是另写一份 —— 另写一份就会在签名漂移时静默失配。
   */
  readonly transfer: (
    req: TransferRequest,
    deps: Parameters<typeof transfer>[1],
  ) => Promise<TransferResult>
}

/** 生产装配。**唯一**知道具体实现的地方 */
export function defaultApplyDeps(): ApplyDeps {
  return { acquireFacts, probeLocalFacts, transfer }
}
