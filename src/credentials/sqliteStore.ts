// SQL方式の保持。cookieにはセッションIDだけを入れ、認証情報は暗号化して SqlClient 経由で保存する。
import { cookieHeader, nowSec, readCookie } from "./cookieStore"
import { open, seal, toBase64Url } from "./seal"
import { COOKIE_NAME, LIFETIME_SEC, type CredentialStore, type Credentials } from "./types"

/** SQL文とバインド変数だけで操作する最小の境界。保持方式はこのインターフェース以外のDB APIを使わない */
export interface SqlClient {
  execute(sql: string, params?: ReadonlyArray<string | number>): Promise<void>
  query<T>(sql: string, params?: ReadonlyArray<string | number>): Promise<T[]>
}

// SQLiteの標準の構文のみを使う。Cloudflare D1（SQLite互換）でも同じ文が通る
export const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  sealed TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`

type Payload = { c: Credentials; e: number }

export function createSqlStore(key: CryptoKey, db: SqlClient, opts: { secure: boolean }): CredentialStore {
  let ready: Promise<void> | null = null
  const init = () => (ready ??= db.execute(CREATE_TABLE).catch(e => ((ready = null), Promise.reject(e))))
  return {
    async save(credentials, o) {
      await init()
      const now = o?.now ?? nowSec()
      const exp = now + LIFETIME_SEC
      const id = toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
      const sealed = await seal(key, { c: credentials, e: exp } satisfies Payload)
      await db.execute("DELETE FROM sessions WHERE expires_at < ?", [now])
      const prev = readCookie(o?.previousCookieHeader, COOKIE_NAME)
      if (prev) await db.execute("DELETE FROM sessions WHERE id = ?", [prev])
      await db.execute("INSERT INTO sessions (id, sealed, expires_at) VALUES (?, ?, ?)", [id, sealed, exp])
      return cookieHeader(id, opts.secure)
    },
    async load(header, now = nowSec()) {
      const id = readCookie(header, COOKIE_NAME)
      if (!id) return null
      await init()
      const rows = await db.query<{ sealed: string; expires_at: number }>(
        "SELECT sealed, expires_at FROM sessions WHERE id = ?",
        [id],
      )
      const row = rows[0]
      if (!row || row.expires_at <= now) return null
      const p = await open<Payload>(key, row.sealed)
      return p && p.e > now ? { credentials: p.c, expiresAt: p.e } : null
    },
  }
}
