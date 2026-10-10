// XREAの一覧のキャッシュ。有効期間内はメモリから返し、発行・削除の成功時に破棄する。
import type { MailEntry } from "../xrea/errors"

export const LIST_TTL_MS = 30_000

export class ListCache {
  private value: MailEntry[] | null = null
  private fetchedAt = 0

  constructor(
    private readonly load: () => Promise<MailEntry[]>,
    private readonly ttlMs = LIST_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(): Promise<MailEntry[]> {
    if (this.value && this.now() - this.fetchedAt < this.ttlMs) return this.value
    return this.fresh()
  }

  async fresh(): Promise<MailEntry[]> {
    const v = await this.load()
    this.value = v
    this.fetchedAt = this.now()
    return v
  }

  invalidate(): void {
    this.value = null
  }
}
