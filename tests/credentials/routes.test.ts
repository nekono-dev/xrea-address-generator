import { Hono } from "hono"
import { beforeAll, describe, expect, test, vi } from "vitest"
import { ConfigError, loadCredentialConfig } from "../../src/credentials/config"
import { createCookieStore } from "../../src/credentials/cookieStore"
import { credentialRoutes, requireCredentials } from "../../src/credentials/routes"
import { deriveKey } from "../../src/credentials/seal"

const body = {
  xrea: { account: "acct", serverName: "s1.xrea.com", apiSecretKey: "SECRET-XYZ" },
  protonToken: "TOKEN-XYZ",
}
let store: ReturnType<typeof createCookieStore>
beforeAll(async () => {
  store = createCookieStore(await deriveKey("a".repeat(32)), { secure: true })
})

type Check = "disabled" | "available" | "unavailable"
function setup(verify: (x: unknown) => Promise<boolean> = async () => true, protonCheck: () => Promise<Check> = async () => "available") {
  const lines: string[] = []
  const log = {
    info: (o: object) => lines.push(JSON.stringify(o)),
    warn: (o: object) => lines.push(JSON.stringify(o)),
    error: (o: object) => lines.push(JSON.stringify(o)),
  }
  const app = credentialRoutes({ store, verify, protonCheck, log })
  const put = (b: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
    app.request("/api/credentials", { method: "PUT", headers, body: JSON.stringify(b) })
  return { app, put, lines }
}

describe("登録と問い合わせ", () => {
  test("credential-session/AC-1: 正しい認証情報でXREAへの疎通が確認され、cookieが発行される", async () => {
    const verify = vi.fn(async () => true)
    const { put } = setup(verify)
    const res = await put(body)
    expect(res.status).toBe(204)
    expect(verify).toHaveBeenCalledWith(body.xrea)
    expect(res.headers.get("set-cookie")).toContain("xag_session=")
  })

  test("credential-session/AC-2: 疎通が失敗すると400でcookieが発行されない", async () => {
    const { put } = setup(async () => false)
    const res = await put(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("invalid_credentials")
    expect(res.headers.get("set-cookie")).toBeNull()
  })

  test("credential-session/AC-2: 項目の欠落・長すぎ・Content-Type違いは400、到達不能は502", async () => {
    const { put } = setup()
    expect((await put({ ...body, xrea: { ...body.xrea, account: "" } })).status).toBe(400)
    expect((await put({ ...body, xrea: { ...body.xrea, apiSecretKey: "k".repeat(129) } })).status).toBe(400)
    expect((await put(body, { "content-type": "text/plain" })).status).toBe(400)
    const down = setup(async () => {
      throw new Error("down")
    })
    expect((await down.put(body)).status).toBe(502)
  })

  test("credential-session/AC-25: ログアウトが有効期間0のcookieを返す204になり、登録済みでも未登録でも成功する", async () => {
    const { app, put } = setup()
    const cookie = (await put(body)).headers.get("set-cookie")!.split(";")[0]!
    for (const headers of [{ cookie }, {} as Record<string, string>]) {
      const res = await app.request("/api/credentials", { method: "DELETE", headers })
      expect(res.status).toBe(204)
      expect(res.headers.get("set-cookie")).toMatch(/^xag_session=; Max-Age=0;.*HttpOnly.*SameSite=Strict/)
    }
  })

  test("credential-session/AC-7: 登録後の問い合わせが登録済みと期限を返し、秘匿値を含まない", async () => {
    const { app, put } = setup()
    const cookie = (await put(body)).headers.get("set-cookie")!.split(";")[0]!
    const res = await app.request("/api/credentials", { headers: { cookie } })
    const text = await res.text()
    const j = JSON.parse(text)
    expect(j.registered).toBe(true)
    expect(j.proton).toBe(true)
    expect(new Date(j.expiresAt).getTime()).toBeGreaterThan(Date.now())
    expect(text).not.toContain("SECRET-XYZ")
    expect(text).not.toContain("TOKEN-XYZ")
    const none = await app.request("/api/credentials")
    expect(await none.json()).toEqual({ registered: false })
  })

  test("credential-session/AC-26: 登録済みの問い合わせで、7日の有効期間のcookieが再発行され、同じ認証情報を取り出せる", async () => {
    const { app, put } = setup()
    const cookie = (await put(body)).headers.get("set-cookie")!.split(";")[0]!
    const res = await app.request("/api/credentials", { headers: { cookie } })
    const renewed = res.headers.get("set-cookie")!
    expect(renewed).toMatch(/^xag_session=[^;]+; Max-Age=604800;.*HttpOnly.*SameSite=Strict/)
    const j = await res.json()
    expect(new Date(j.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6.9 * 24 * 3600 * 1000)
    const again = await app.request("/api/credentials", { headers: { cookie: renewed.split(";")[0]! } })
    expect((await again.json()).proton).toBe(true)
    // 未登録の問い合わせではcookieを発行しない
    expect((await app.request("/api/credentials")).headers.get("set-cookie")).toBeNull()
  })

  test("credential-session/AC-7: Proton Passトークン未指定では proton が false", async () => {
    const { app, put } = setup()
    const cookie = (await put({ xrea: body.xrea })).headers.get("set-cookie")!.split(";")[0]!
    expect((await (await app.request("/api/credentials", { headers: { cookie } })).json()).proton).toBe(false)
  })

  test("credential-session/AC-9: 応答とログにシークレットキーとトークンが含まれない", async () => {
    const { app, put, lines } = setup()
    const r = await put(body)
    const cookie = r.headers.get("set-cookie")!.split(";")[0]!
    const g = await app.request("/api/credentials", { headers: { cookie } })
    const bad = await setup(async () => false).put(body)
    const all = [await g.text(), await bad.text(), ...lines].join("\n")
    expect(all).not.toContain("SECRET-XYZ")
    expect(all).not.toContain("TOKEN-XYZ")
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe("保護対象の検査", () => {
  test("credential-session/AC-11: cookieなしは401で後続が呼ばれず、登録済みは通る", async () => {
    const next = vi.fn((c: any) => c.json({ ok: true }))
    const app = new Hono()
    app.use("/api/*", requireCredentials(store))
    app.get("/api/x", next)
    const res = await app.request("/api/x")
    expect(res.status).toBe(401)
    expect((await res.json()).error.code).toBe("credentials_required")
    expect(next).not.toHaveBeenCalled()
    const cookie = (await store.save({ xrea: body.xrea, protonToken: null })).split(";")[0]!
    expect((await app.request("/api/x", { headers: { cookie } })).status).toBe(200)
  })
})

describe("設定", () => {
  test("credential-session/AC-10: 秘密値が未設定・31文字は失敗し、32文字は成功する", () => {
    expect(() => loadCredentialConfig({})).toThrow(ConfigError)
    expect(() => loadCredentialConfig({ COOKIE_SECRET: "a".repeat(31) })).toThrow(/COOKIE_SECRET/)
    const c = loadCredentialConfig({ COOKIE_SECRET: "a".repeat(32) })
    expect(c).toMatchObject({ store: "cookie", secure: true })
    expect(loadCredentialConfig({ COOKIE_SECRET: "a".repeat(32), COOKIE_SECURE: "0" }).secure).toBe(false)
    expect(() => loadCredentialConfig({ COOKIE_SECRET: "a".repeat(32), CREDENTIAL_STORE: "x" })).toThrow(ConfigError)
  })
})

describe("連携の利用可否", () => {
  const registered = async (res: Response, app: { request: (p: string, i?: RequestInit) => Response | Promise<Response> }) => {
    const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? ""
    return app.request("/api/credentials", { headers: { cookie } })
  }

  test("credential-session/AC-18: 連携が未設定または利用不可のとき200 { proton } が返り、XREAの認証情報だけが保持される", async () => {
    for (const state of ["disabled", "unavailable"] as const) {
      const { app, put } = setup(undefined, async () => state)
      const res = await put(body)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ proton: state })
      const cookie = res.headers.get("set-cookie") ?? ""
      expect(cookie).toContain("xag_session=")
      const info = await (await registered(res, app)).json()
      expect(info).toMatchObject({ registered: true, proton: false })
      const reg = await store.load(cookie.split(";")[0] ?? null)
      expect(reg?.credentials).toEqual({ xrea: body.xrea, protonToken: null })
    }
    // 確認が例外のときも利用不可として扱う
    const { put } = setup(undefined, async () => {
      throw new Error("boom")
    })
    const res = await put(body)
    expect([res.status, await res.json()]).toEqual([200, { proton: "unavailable" }])
  })

  test("credential-session/AC-17: 連携が利用可能のとき204が返り、トークンが保持される", async () => {
    const { app, put } = setup()
    const res = await put(body)
    expect(res.status).toBe(204)
    expect(await (await registered(res, app)).json()).toMatchObject({ proton: true })
  })

  test("credential-session/AC-19: トークンを含まない登録の要求では、利用可否の確認が呼び出されず204が返る", async () => {
    const check = vi.fn(async (): Promise<Check> => "available")
    const { put } = setup(undefined, check)
    expect((await put({ xrea: body.xrea })).status).toBe(204)
    expect((await put({ xrea: body.xrea, protonToken: "" })).status).toBe(204)
    expect(check).not.toHaveBeenCalled()
  })

  test("credential-session/AC-20: 疎通の確認が失敗する登録の要求では、利用可否の確認が呼び出されない", async () => {
    const check = vi.fn(async (): Promise<Check> => "available")
    const { put } = setup(async () => false, check)
    expect((await put(body)).status).toBe(400)
    expect(check).not.toHaveBeenCalled()
  })
})
