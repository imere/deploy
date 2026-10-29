import { probeLocalFacts } from '@dp/runner-local'
import { transfer } from '@dp/transport'
import type { TransferRequest, TransferResult } from '@dp/transport'
import { acquireFacts, type FactsRequest, type FactsResult } from './facts-source.js'

export interface ApplyDeps {
  /** 目标机事实 + 那条已连上的连接。装配期失败必须由调用方兜住 */
  readonly acquireFacts: (request: FactsRequest) => Promise<FactsResult>
  /** 本地事实。协商的另一端 */
  readonly probeLocalFacts: () => Promise<Awaited<ReturnType<typeof probeLocalFacts>>>
  /**
   * 传输执行。绝不真连的测试从这里塞假的。
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
