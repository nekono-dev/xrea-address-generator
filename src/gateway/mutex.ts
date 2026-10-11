// 変更要求（発行・削除）の直列化。到着順に1件ずつ実行する。
export class Mutex {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}
