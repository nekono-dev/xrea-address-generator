import { describe, expect, test, vi } from "vitest"
import { loadAppConfig } from "../../src/app/config"
import { GatewayClient } from "../../src/app/gatewayClient"
import { ENV, BODY, XREA, defaultReader, makeApp, recorder } from "./helpers"

const get = (app: any, path: string, cookie: string) => app.request(path, { headers: { cookie } })

describe("ゲートウェイへの中継", () => {
  test("alias-service/AC-1: 一覧の応答に、ゲートウェイが返したアドレスとメールボックスの印が含まれる", async () => {
    const { app, register } = await makeApp()
    const cookie = await register()
    const { aliases } = await (await get(app, "/api/aliases", cookie)).json()
    expect(aliases.map((a: any) => [a.address, a.mailbox])).toEqual([
      ["bank@example.org", false],
      ["mail@example.com", true],
      ["mail@example.net", true],
      ["shop@example.com", false],
      ["sns@example.net", false],
    ])
  })

  test("alias-service/AC-6: 発行・転送先の変更・削除・候補の要求が認証情報を添えて中継され、409と403がそのまま返る", async () => {
    const { app, register, seen, xrea, json } = await makeApp()
    const cookie = await register()
    const h = { ...json, cookie }
    const created = await app.request("/api/aliases", { method: "POST", headers: h, body: JSON.stringify({ name: "travel", domain: "example.net", forwardTo: "sub@mail.example" }) })
    expect(created.status).toBe(201)
    expect((await created.json()).alias).toMatchObject({ address: "travel@example.net", protonEntries: [] })
    expect(xrea.created).toEqual([{ name: "travel", domain: "example.net", forwardTo: "sub@mail.example" }])
    const changed = await app.request(`/api/aliases/${encodeURIComponent("travel@example.net")}`, { method: "PATCH", headers: h, body: JSON.stringify({ forwardTo: "me@mail.example" }) })
    expect(changed.status).toBe(200)
    expect((await changed.json()).alias.forwardTo).toBe("me@mail.example")
    expect((await app.request(`/api/aliases/${encodeURIComponent("travel@example.net")}`, { method: "DELETE", headers: h })).status).toBe(204)
    expect((await (await get(app, "/api/options", cookie)).json()).domains).toContain("example.com")
    // ゲートウェイの 409・403・404・400 のコードと状態がそのまま返る
    const dup = await app.request("/api/aliases", { method: "POST", headers: h, body: JSON.stringify({ name: "shop", domain: "example.com", forwardTo: "me@mail.example" }) })
    expect([dup.status, (await dup.json()).error.code]).toEqual([409, "conflict"])
    const forbidden = await app.request(`/api/aliases/${encodeURIComponent("mail@example.com")}`, { method: "DELETE", headers: h })
    expect([forbidden.status, (await forbidden.json()).error.code]).toEqual([403, "forbidden"])
    expect((await app.request("/api/aliases/none%40example.com", { method: "DELETE", headers: h })).status).toBe(404)
    const bad = await app.request("/api/aliases", { method: "POST", headers: h, body: JSON.stringify({ name: "has space", domain: "example.com", forwardTo: "me@mail.example" }) })
    expect(bad.status).toBe(400)
    // 中継した要求のすべてにXREAの認証情報が付いている
    const relayed = seen.gateway.filter(s => s.url.includes("/v1/"))
    expect(relayed.length).toBeGreaterThan(5)
    for (const s of relayed) expect(s.headers["x-xrea-account"]).toBe("acct")
  })

  test("alias-service/AC-21: 転送の解除の要求が認証情報を添えてゲートウェイへ中継され、解除後の項目が返る", async () => {
    const { app, register, seen, xrea } = await makeApp()
    const cookie = await register()
    const res = await app.request(`/api/aliases/${encodeURIComponent("mail@example.net")}/forward`, { method: "DELETE", headers: { cookie } })
    expect(res.status).toBe(200)
    expect((await res.json()).alias).toMatchObject({ address: "mail@example.net", forwardTo: "", mailbox: true, protonEntries: [] })
    expect(xrea.removed).toEqual([4])
    const relayed = seen.gateway.find(s => s.method === "DELETE")!
    expect(new URL(relayed.url).pathname).toBe("/v1/aliases/mail%40example.net/forward")
    expect(relayed.headers["x-xrea-secret"]).toBe("XREA-SECRET-KEY")
    const forbidden = await app.request(`/api/aliases/${encodeURIComponent("shop@example.com")}/forward`, { method: "DELETE", headers: { cookie } })
    expect([forbidden.status, (await forbidden.json()).error.code]).toEqual([403, "forbidden"])
  })

  test("alias-service/AC-6: 不正なJSONの本文は400 validation_error になる", async () => {
    const { app, register, json } = await makeApp()
    const res = await app.request("/api/aliases", { method: "POST", headers: { ...json, cookie: await register() }, body: "{" })
    expect([res.status, (await res.json()).error.code]).toEqual([400, "validation_error"])
  })

  test("alias-service/AC-8: 共有シークレットが付き、認証情報とトークンは要求ヘッダにだけ現れ、URLと本文には現れない", async () => {
    const { app, register, seen, json } = await makeApp()
    const cookie = await register()
    await get(app, "/api/aliases", cookie)
    await app.request("/api/aliases", { method: "POST", headers: { ...json, cookie }, body: JSON.stringify({ name: "new", domain: "example.com", forwardTo: "me@mail.example" }) })
    await app.request("/api/proton/refresh", { method: "POST", headers: { cookie } })
    expect(seen.gateway.length).toBeGreaterThan(1)
    expect(seen.reader.length).toBeGreaterThan(0)
    for (const s of [...seen.gateway, ...seen.reader]) {
      expect(s.headers.authorization).toBe("Bearer " + ENV.INTERNAL_TOKEN)
      expect(s.url).not.toContain("XREA-SECRET-KEY")
      expect(s.url).not.toContain("PROTON-PAT-VALUE")
      expect(s.body).not.toContain("XREA-SECRET-KEY")
      expect(s.body).not.toContain("PROTON-PAT-VALUE")
    }
    expect(seen.gateway[0]!.headers["x-xrea-secret"]).toBe("XREA-SECRET-KEY")
    expect(seen.reader[0]!.headers["x-proton-token"]).toBe("PROTON-PAT-VALUE")
  })

  test("alias-service/AC-9: 一覧の応答とログに、認証情報・トークン・パスワード項目の文字列が含まれない", async () => {
    const { lines, log } = recorder()
    const { app, register } = await makeApp({ log })
    const cookie = await register()
    const out = [await (await get(app, "/api/aliases", cookie)).text(), await (await get(app, "/api/proton/status", cookie)).text()]
    out.push(await (await app.request("/api/aliases", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ name: "shop", domain: "example.com", forwardTo: "me@mail.example" }) })).text())
    const all = [...out, ...lines].join("\n")
    for (const s of ["XREA-SECRET-KEY", "PROTON-PAT-VALUE", "pop_pass"]) expect(all).not.toContain(s)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.join("\n")).not.toContain("shop@example.com")
  })

  test("alias-service/AC-13: ゲートウェイが拒否・不達のとき502 upstream_error が返る", async () => {
    const brokenFetch = (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch
    const client = new GatewayClient("http://gateway.test", ENV.INTERNAL_TOKEN, brokenFetch)
    await expect(client.list(XREA)).rejects.toMatchObject({ code: "upstream_error", message: "XREAゲートウェイへ接続できません" })
    // 共有シークレットの不一致は、利用者の認証情報の問題と区別して 502 にする
    const wrong = new GatewayClient("http://gateway.test", "w".repeat(32), (await makeApp()).fetch)
    await expect(wrong.list(XREA)).rejects.toMatchObject({ code: "upstream_error", message: "内部サービスの認証に失敗しました" })
  })

  test("alias-service/AC-18: ゲートウェイが応答しない状態で、10秒時点で502が返る", async () => {
    vi.useFakeTimers()
    try {
      const never = ((_u: string, init: RequestInit) => new Promise((_r, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch
      const client = new GatewayClient("http://gateway.test", ENV.INTERNAL_TOKEN, never)
      const p = client.list(XREA).then(() => "ok", e => e)
      await vi.advanceTimersByTimeAsync(9_999)
      let settled = false
      void p.then(() => (settled = true))
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const e = await p
      expect(e).toMatchObject({ code: "upstream_error" })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("一覧の合成とProton Pass", () => {
  test("alias-service/AC-2: エントリ名を持つアドレスの一覧の項目に、そのエントリ名が昇順で含まれる", async () => {
    const { app, register } = await makeApp({
      reader: () => Response.json({ status: { state: "ready", updatedAt: null, reloginAt: null, itemCount: 2, error: null }, entries: { "sns@example.net": ["Bluesky", "X (Twitter)"] } }),
    })
    const { aliases, proton } = await (await get(app, "/api/aliases", await register())).json()
    expect(aliases.find((a: any) => a.address === "sns@example.net")).toEqual({
      address: "sns@example.net", name: "sns", domain: "example.net", forwardTo: "sub@mail.example", mailbox: false, protonEntries: ["Bluesky", "X (Twitter)"],
    })
    expect(aliases.find((a: any) => a.address === "bank@example.org").protonEntries).toEqual([])
    expect(proton.state).toBe("ready")
  })

  test("alias-service/AC-3: 読み取りサービスが未設定、またはトークンが未登録のとき、照合の状態が無効になり、呼び出されない", async () => {
    const noUrl = loadAppConfig({ ...ENV, PROTON_READER_URL: "" })
    expect(noUrl.readerUrl).toBeNull()
    const a = await makeApp({ env: { PROTON_READER_URL: "" } })
    const r1 = await (await get(a.app, "/api/aliases", await a.register())).json()
    expect(r1.proton.state).toBe("disabled")
    expect(r1.aliases.every((x: any) => x.protonEntries.length === 0)).toBe(true)
    expect(a.seen.reader).toEqual([])
    const b = await makeApp()
    const r2 = await (await get(b.app, "/api/aliases", await b.register({ xrea: XREA }))).json()
    expect(r2.proton.state).toBe("disabled")
    expect(b.seen.reader).toEqual([])
  })

  test("alias-service/AC-4: 読み取りサービスが取得中の状態を返すとき、一覧が返り、照合の状態が取得中になる", async () => {
    const { app, register } = await makeApp({
      reader: () => Response.json({ status: { state: "loading", updatedAt: null, reloginAt: null, itemCount: null, error: null }, entries: {} }),
    })
    const res = await get(app, "/api/aliases", await register())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.aliases).toHaveLength(5)
    expect(j.proton.state).toBe("loading")
  })

  test("alias-service/AC-5: 再取得の要求が読み取りサービスへ中継されて202が返る", async () => {
    const { app, register, seen } = await makeApp()
    const res = await app.request("/api/proton/refresh", { method: "POST", headers: { cookie: await register() } })
    expect(res.status).toBe(202)
    expect(seen.reader.map(s => `${s.method} ${new URL(s.url).pathname}`)).toEqual(["POST /v1/refresh"])
  })

  test("照合状態の取得は、読み取りサービスの status だけを返す", async () => {
    const { app, register } = await makeApp()
    const j = await (await get(app, "/api/proton/status", await register())).json()
    expect(j).toMatchObject({ state: "ready", itemCount: 3 })
    expect(j.entries).toBeUndefined()
  })

  test("alias-service/AC-13: 読み取りサービスが応答しないとき、一覧が返って照合の状態がエラーになる", async () => {
    const { app, register } = await makeApp({ reader: () => Promise.reject(new Error("down")) })
    const res = await get(app, "/api/aliases", await register())
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.aliases).toHaveLength(5)
    expect(j.proton).toMatchObject({ state: "error", error: { kind: "cli" } })
  })
})

describe("連携の利用可否", () => {
  const caps = async (app: any) => (await app.request("/api/capabilities")).json()

  test("alias-service/AC-22: 登録していない状態で200になり、読み取りサービスのURLが未設定なら未設定を返して呼び出さない", async () => {
    const { app, seen } = await makeApp()
    const res = await app.request("/api/capabilities")
    expect([res.status, res.headers.get("cache-control"), await res.json()]).toEqual([200, "no-store", { proton: "available" }])
    const none = await makeApp({ env: { PROTON_READER_URL: "" } })
    expect(await caps(none.app)).toEqual({ proton: "disabled" })
    expect([none.seen.reader, none.seen.health]).toEqual([[], []])
    expect(seen.health.at(-1)?.headers.authorization).toBeUndefined()
  })

  test("alias-service/AC-23: 死活確認に200を返すと利用可能、接続できないか200以外を返すと利用不可になる", async () => {
    expect(await caps((await makeApp()).app)).toEqual({ proton: "available" })
    expect(await caps((await makeApp({ health: () => new Response("x", { status: 503 }) })).app)).toEqual({ proton: "unavailable" })
    expect(
      await caps(
        (
          await makeApp({
            health: () => {
              throw new TypeError("fetch failed")
            },
          })
        ).app,
      ),
    ).toEqual({ proton: "unavailable" })
  })

  test("alias-service/AC-24: 利用可能は30秒、利用不可は5秒の間、再確認せずに返し、最新の確認を求めたときは再確認する", async () => {
    vi.useFakeTimers()
    try {
      let status = 200
      const { app, seen } = await makeApp({ health: () => new Response("x", { status }) })
      const calls = () => seen.health.length
      expect(await caps(app)).toEqual({ proton: "available" })
      status = 503
      vi.advanceTimersByTime(29_000)
      expect(await caps(app)).toEqual({ proton: "available" })
      expect(calls()).toBe(1)
      vi.advanceTimersByTime(2_000)
      expect(await caps(app)).toEqual({ proton: "unavailable" })
      expect(calls()).toBe(2)
      status = 200
      vi.advanceTimersByTime(4_000)
      expect(await caps(app)).toEqual({ proton: "unavailable" })
      expect(calls()).toBe(2)
      vi.advanceTimersByTime(2_000)
      expect(await caps(app)).toEqual({ proton: "available" })
      expect(calls()).toBe(3)
      // 登録（最新の確認）は保持を無視して確認する
      status = 503
      const res = await app.request("/api/credentials", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) })
      expect([res.status, await res.json()]).toEqual([200, { proton: "unavailable" }])
      expect(calls()).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  test("alias-service/AC-25: 読み取りサービスが応答しない状態で、1.5秒以内に利用不可で返る", async () => {
    const { app } = await makeApp({ health: () => new Promise<Response>(() => undefined) })
    const start = performance.now()
    const body = await caps(app)
    expect(body).toEqual({ proton: "unavailable" })
    expect(performance.now() - start).toBeLessThan(1_500)
  })
})
