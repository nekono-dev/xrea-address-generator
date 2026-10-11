import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, test } from "vitest"
import { createCookieStore, readCookie } from "../../src/credentials/cookieStore"
import { deriveKey } from "../../src/credentials/seal"
import { createNodeSqliteClient } from "../../src/credentials/sqliteClient"
import { createSqlStore, type SqlClient } from "../../src/credentials/sqliteStore"
import { COOKIE_NAME, LIFETIME_SEC, type CredentialStore, type Credentials } from "../../src/credentials/types"

const cred = (n: string): Credentials => ({
  xrea: { account: "acct", serverName: "s1.xrea.com", apiSecretKey: `SECRET-${n}` },
  protonToken: `TOKEN-${n}`,
})
const asRequestCookie = (setCookie: string) => setCookie.split(";")[0]!
let key: CryptoKey
let otherKey: CryptoKey
beforeAll(async () => {
  key = await deriveKey("a".repeat(32))
  otherKey = await deriveKey("b".repeat(32))
})

const NOW = 1_800_000_000

describe("cookie方式", () => {
  const make = () => createCookieStore(key, { secure: true })

  test("credential-session/AC-5: HttpOnly・SameSite=Strict・7日、Secureは設定を外したときだけ付かない", async () => {
    const on = await createCookieStore(key, { secure: true }).save(cred("1"))
    const off = await createCookieStore(key, { secure: false }).save(cred("1"))
    for (const h of [on, off]) {
      expect(h).toContain("HttpOnly")
      expect(h).toContain("SameSite=Strict")
      expect(h).toContain(`Max-Age=${LIFETIME_SEC}`)
      expect(h).toContain("Path=/")
    }
    expect(on).toContain("; Secure")
    expect(off).not.toContain("Secure")
  })

  test("credential-session/AC-6: 7日と1秒後・改ざん・別の鍵は未登録になる", async () => {
    const store = make()
    const cookie = asRequestCookie(await store.save(cred("1"), { now: NOW }))
    expect((await store.load(cookie, NOW + LIFETIME_SEC - 1))?.credentials).toEqual(cred("1"))
    expect(await store.load(cookie, NOW + LIFETIME_SEC + 1)).toBeNull()
    const i = cookie.length - 4
    const tampered = cookie.slice(0, i) + (cookie[i] === "A" ? "B" : "A") + cookie.slice(i + 1)
    expect(await store.load(tampered, NOW)).toBeNull()
    expect(await createCookieStore(otherKey, { secure: true }).load(cookie, NOW)).toBeNull()
    expect(await store.load(null)).toBeNull()
  })

  test("credential-session/AC-8: 2回目の登録後は2回目の認証情報だけが取り出される", async () => {
    const store = make()
    await store.save(cred("1"))
    const second = asRequestCookie(await store.save(cred("2")))
    expect((await store.load(second))?.credentials).toEqual(cred("2"))
  })

  test("credential-session/AC-3: cookieの値に平文のシークレットキーが含まれない", async () => {
    const h = await make().save(cred("1"))
    expect(h).not.toContain("SECRET-1")
    expect(h).not.toContain("TOKEN-1")
  })
})

type Row = { id: string; sealed: string; expires_at: number }

describe.each([
  ["組み込みSQLite", () => createNodeSqliteClient(":memory:")],
  ["別実装（メモリ上の疑似クライアント）", () => fakeClient()],
])("SQL方式 %s", (_n, mk) => {
  let db: SqlClient
  let store: CredentialStore
  const rows = (): Promise<Row[]> => db.query<Row>("SELECT id, sealed, expires_at FROM sessions")
  const fresh = () => {
    db = mk()
    store = createSqlStore(key, db, { secure: true })
  }

  test("credential-session/AC-4: cookieの値に認証情報が含まれず、行が暗号文だけを持つ", async () => {
    fresh()
    const h = await store.save(cred("1"), { now: NOW })
    expect(h).not.toContain("SECRET-1")
    const all = JSON.stringify(await rows())
    expect(all).not.toContain("SECRET-1")
    expect(all).not.toContain("TOKEN-1")
    expect((await rows())[0]!.sealed.startsWith("v1.")).toBe(true)
    expect((await store.load(asRequestCookie(h), NOW))?.credentials).toEqual(cred("1"))
  })

  test("credential-session/AC-6: 期限切れ・改ざん・別の鍵・未知のIDは未登録になる", async () => {
    fresh()
    const cookie = asRequestCookie(await store.save(cred("1"), { now: NOW }))
    expect(await store.load(cookie, NOW + LIFETIME_SEC + 1)).toBeNull()
    expect(await createSqlStore(otherKey, db, { secure: true }).load(cookie, NOW)).toBeNull()
    expect(await store.load(`${COOKIE_NAME}=unknown`, NOW)).toBeNull()
    await db.execute("UPDATE sessions SET sealed = ?", ["v1.AAAA"])
    expect(await store.load(cookie, NOW)).toBeNull()
  })

  test("credential-session/AC-8: 再登録で最初の行が削除され、2回目だけが取り出される", async () => {
    fresh()
    const first = asRequestCookie(await store.save(cred("1"), { now: NOW }))
    const second = asRequestCookie(await store.save(cred("2"), { now: NOW + 10, previousCookieHeader: first }))
    expect(await rows()).toHaveLength(1)
    expect(await store.load(first, NOW + 10)).toBeNull()
    expect((await store.load(second, NOW + 10))?.credentials).toEqual(cred("2"))
  })

  test("credential-session/AC-16: 期限切れの行を持つDBへの登録後、期限切れの行が0件になる", async () => {
    fresh()
    await store.save(cred("old"), { now: NOW })
    await store.save(cred("new"), { now: NOW + LIFETIME_SEC + 100 })
    const left = await rows()
    expect(left).toHaveLength(1)
    expect(left.filter(r => r.expires_at < NOW + LIFETIME_SEC + 100)).toHaveLength(0)
  })

  test("credential-session/AC-5: Secure属性は設定を外したときだけ付かない", async () => {
    fresh()
    const off = await createSqlStore(key, db, { secure: false }).save(cred("1"))
    expect(off).not.toContain("Secure")
    expect(await store.save(cred("1"))).toContain("; Secure")
    expect(readCookie(off, COOKIE_NAME)).toBeTruthy()
  })
})

/** SQL文を解釈せず、保持方式が発行する文だけを扱うメモリ上のクライアント（SqlClient の差し替え確認用） */
function fakeClient(): SqlClient {
  let table: Row[] = []
  return {
    async execute(sql, p = []) {
      if (sql.startsWith("CREATE TABLE")) return
      if (sql.startsWith("DELETE FROM sessions WHERE expires_at"))
        table = table.filter(r => !(r.expires_at < (p[0] as number)))
      else if (sql.startsWith("DELETE FROM sessions WHERE id")) table = table.filter(r => r.id !== p[0])
      else if (sql.startsWith("INSERT")) table.push({ id: p[0] as string, sealed: p[1] as string, expires_at: p[2] as number })
      else if (sql.startsWith("UPDATE")) table = table.map(r => ({ ...r, sealed: p[0] as string }))
      else throw new Error(`未対応: ${sql}`)
    },
    async query<T>(sql: string, p: ReadonlyArray<string | number> = []) {
      if (sql.includes("WHERE id")) return table.filter(r => r.id === p[0]) as T[]
      return table as T[]
    },
  }
}

describe("sqlite3コマンドでの参照", () => {
  const has = spawnSync("sqlite3", ["-version"]).status === 0
  test.skipIf(!has)("credential-session/AC-15: 標準のsqlite3コマンドでセッションの表を参照できる", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "xag-")), "sessions.db")
    const s = createSqlStore(key, createNodeSqliteClient(path), { secure: true })
    await s.save(cred("1"))
    const out = execFileSync("sqlite3", [path, "SELECT count(*) FROM sessions"]).toString().trim()
    expect(out).toBe("1")
  })
  test("credential-session/AC-15: 別のSQLクライアントの実装でも登録と取り出しが成功する", async () => {
    const s = createSqlStore(key, fakeClient(), { secure: true })
    const c = asRequestCookie(await s.save(cred("9")))
    expect((await s.load(c))?.credentials).toEqual(cred("9"))
  })
})
