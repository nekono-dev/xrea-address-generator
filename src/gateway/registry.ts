// アカウントごとのクライアント・キャッシュ・排他の保持。
import { createHash } from "node:crypto"
import { XreaClient, type XreaConfig } from "../xrea/client"
import { ListCache } from "./listCache"
import { Mutex } from "./mutex"
import type { XreaPort } from "./service"

export type Tenant = { xrea: XreaPort; cache: ListCache; mutex: Mutex; lastUsed: number; serverName: string }

export class Registry {
  private tenants = new Map<string, Tenant>()

  constructor(
    private max = 100,
    private idleMs = 600_000,
    private now: () => number = Date.now,
    private factory: (c: XreaConfig) => XreaPort = c => new XreaClient(c),
    private ttlMs = 30_000,
  ) {}

  /** key = sha256(account + "\0" + serverName + "\0" + apiSecretKey) の16進。無ければ作る */
  get(creds: XreaConfig): Tenant {
    const key = createHash("sha256").update(`${creds.account}\0${creds.serverName}\0${creds.apiSecretKey}`).digest("hex")
    this.evict()
    let t = this.tenants.get(key)
    if (!t) {
      const xrea = this.factory(creds)
      t = { xrea, cache: new ListCache(() => xrea.mailList(), this.ttlMs, this.now), mutex: new Mutex(), lastUsed: 0, serverName: creds.serverName }
      this.tenants.set(key, t)
    }
    t.lastUsed = this.now()
    // Map の挿入順を使用順にする
    this.tenants.delete(key)
    this.tenants.set(key, t)
    this.evict()
    return t
  }

  get size(): number {
    return this.tenants.size
  }

  /** 最後の使用から idleMs を過ぎたものを破棄し、max を超えたら最も古く使われたものを破棄する */
  private evict(): void {
    const now = this.now()
    for (const [k, t] of this.tenants) if (now - t.lastUsed >= this.idleMs) this.tenants.delete(k)
    while (this.tenants.size > this.max) this.tenants.delete(this.tenants.keys().next().value!)
  }
}
