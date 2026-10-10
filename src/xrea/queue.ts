// エンドポイントごとにリクエストを直列化し、前回の送信完了から一定の間隔を空けて実行する。
// XREAは同一エンドポイントへ1秒に1回を超えるとエラーを返すため、余裕を持たせて1100ミリ秒とする。

export const MIN_GAP_MS = 1100

type Sleep = (ms: number) => Promise<void>
const defaultSleep: Sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export class EndpointQueue {
  private tails = new Map<string, Promise<void>>()
  private lastDone = new Map<string, number>()

  constructor(
    private readonly gapMs = MIN_GAP_MS,
    private readonly sleep: Sleep = defaultSleep,
    private readonly now: () => number = Date.now,
  ) {}

  run<T>(endpoint: string, task: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(endpoint) ?? Promise.resolve()
    const result = prev.then(async () => {
      const last = this.lastDone.get(endpoint)
      if (last !== undefined) {
        const wait = last + this.gapMs - this.now()
        if (wait > 0) await this.sleep(wait)
      }
      try {
        return await task()
      } finally {
        // 失敗・打ち切りでも次のタスクの待機時間の起点を更新する
        this.lastDone.set(endpoint, this.now())
      }
    })
    // 失敗しても後続のタスクを止めない
    this.tails.set(
      endpoint,
      result.then(
        () => undefined,
        () => undefined,
      ),
    )
    return result
  }
}
