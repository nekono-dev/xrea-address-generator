// トークンごとの読み取り部品の保持と破棄。
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { consoleLogger, type Logger } from "../shared/logger"
import { CachedReader } from "./cache"
import { createCliRunner, type CliRunner } from "./cli"
import { Session } from "./session"

export class Tenants {
  private readers = new Map<string, CachedReader>()

  constructor(
    private max: number,
    private baseDir: string,
    private opts: { bin?: string; logger?: Logger; ttlMs?: number; now?: () => number; makeRunner?: (token: string, dir: string) => CliRunner } = {},
  ) {}

  get size(): number {
    return this.readers.size
  }

  /** key = sha256(token) の先頭32文字の16進。無ければ作り、再取得を開始する */
  get(token: string): CachedReader {
    const key = createHash("sha256").update(token).digest("hex").slice(0, 32)
    let reader = this.readers.get(key)
    if (reader) {
      // Map の挿入順を使用順にする
      this.readers.delete(key)
    } else {
      reader = this.create(token, path.join(this.baseDir, key))
    }
    this.readers.set(key, reader)
    this.evict()
    return reader
  }

  private create(token: string, dir: string): CachedReader {
    const log = this.opts.logger ?? consoleLogger
    const base = this.opts.makeRunner?.(token, dir) ?? createCliRunner({ token, sessionDir: dir, bin: this.opts.bin })
    // ログインの実行を記録する（トークンやセッションの内容は出さない）
    const run: CliRunner = async args => {
      const r = await base(args)
      if (args[0] === "login") log.info({ cmd: "login", exitCode: 0, durationMs: r.durationMs })
      return r
    }
    const session = new Session(run, dir)
    const reader = new CachedReader({ run, session, logger: log, ttlMs: this.opts.ttlMs, now: this.opts.now })
    void session
      .ensure()
      .catch(() => undefined)
      .then(() => reader.refresh())
    return reader
  }

  /** max を超えたら最も古く使われたものを破棄し、そのセッション保存先 baseDir/<key> を再帰的に削除する */
  private evict(): void {
    while (this.readers.size > this.max) {
      const key = this.readers.keys().next().value!
      this.readers.delete(key)
      fs.rmSync(path.join(this.baseDir, key), { recursive: true, force: true })
    }
  }
}
