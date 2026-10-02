/**
 * fake spawn —— **测试专用**，零真实子进程。
 *
 * 存在的理由：测试不许起真进程、不许连网络（AGENTS.md）。而 `runRsync` 的价值
 * 全在"退出码 → 结论"这条映射上，用真 rsync 去测它既不稳定（本机根本没 rsync）
 * 也测不全（23/24/255 这些码没法自然制造）。
 *
 * 刻意**不实现** pid：`killProcessTree(undefined)` 直接返回，于是测试不会在
 * Windows 上真的拉起 taskkill。进程树被杀的断言落在 `kill()` 的记录上。
 */
import type { SpawnImpl, SpawnedProcess } from './types.js'

export interface FakeProcessRecord {
  readonly file: string
  readonly args: readonly string[]
  readonly killed: readonly string[]
  readonly stdin: readonly string[]
}

export interface FakeSpawn {
  readonly impl: SpawnImpl
  readonly records: FakeProcessRecord[]
  /** 主动完成一个已经 spawn 出去的进程 */
  close(index: number, code: number): void
  /** 往 stdout 推一段输出（用于 prompt 嗅探） */
  emit(index: number, stream: 'stdout' | 'stderr', data: string): void
  readonly count: () => number
}

export interface FakeSpawnSpec {
  /** 第 n 个进程退出时的 code；不传则永不 close（用于超时用例） */
  readonly exitCode?: number
  readonly stdout?: string
  readonly stderr?: string
  /** 生成后自动结束（默认 true；超时用例传 false） */
  readonly autoClose?: boolean
  readonly delayMs?: number
}

export function fakeSpawn(spec: FakeSpawnSpec = {}): FakeSpawn {
  const records: FakeProcessRecord[] = []
  const pending: {
    close: (code: number) => void
    out: (d: string) => void
    err: (d: string) => void
  }[] = []

  const impl: SpawnImpl = (file, args) => {
    const record: { killed: string[]; stdin: string[] } = { killed: [], stdin: [] }
    records.push({ file, args, killed: record.killed, stdin: record.stdin })

    let closeCb: ((code: number | null) => void) | undefined
    let outCb: ((c: Buffer) => void) | undefined
    let errCb: ((c: Buffer) => void) | undefined
    let finished = false

    const finish = (code: number): void => {
      if (finished) return
      finished = true
      closeCb?.(code)
    }

    const child = {
      stdin: {
        end(data?: string) {
          if (data !== undefined) record.stdin.push(data)
        },
        write(chunk: Uint8Array) {
          record.stdin.push(Buffer.from(chunk).toString('utf8'))
          return true
        },
        on() {
          /* EPIPE 忽略 */
        },
      },
      stdout: {
        on(_e: 'data', cb: (c: Buffer) => void) {
          outCb = cb
        },
      },
      stderr: {
        on(_e: 'data', cb: (c: Buffer) => void) {
          errCb = cb
        },
      },
      on(event: 'close', cb: (c: number | null) => void) {
        closeCb = cb
      },
      kill(signal?: NodeJS.Signals) {
        record.killed.push(signal ?? 'SIGTERM')
        finish(-1)
        return true
      },
    } as unknown as SpawnedProcess

    pending.push({
      close: finish,
      out: (d: string) => outCb?.(Buffer.from(d)),
      err: (d: string) => errCb?.(Buffer.from(d)),
    })

    const autoClose = spec.autoClose ?? true
    if (autoClose) {
      const delay = spec.delayMs ?? 0
      setTimeout(() => {
        if (spec.stdout !== undefined) outCb?.(Buffer.from(spec.stdout))
        if (spec.stderr !== undefined) errCb?.(Buffer.from(spec.stderr))
        finish(spec.exitCode ?? 0)
      }, delay)
    }
    return child
  }

  return {
    impl,
    records,
    close: (i, code) => pending[i]?.close(code),
    emit: (i, stream, data) => (stream === 'stdout' ? pending[i]?.out(data) : pending[i]?.err(data)),
    count: () => records.length,
  }
}
