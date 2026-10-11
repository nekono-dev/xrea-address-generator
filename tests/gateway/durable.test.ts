import { describe, expect, test } from "vitest"
import { GatewayTenant } from "../../src/gateway/durableObject"
import { durableFetcher, type GatewayNamespace } from "../../src/gateway/durableRouter"
import { tenantKey } from "../../src/gateway/tenantKey"
import { XreaClient } from "../../src/xrea/client"
import { FakeXrea, sampleMails } from "./fakes"

const creds = (account: string, secret = "XREA-SECRET-KEY") => ({ account, serverName: "s1.xrea.com", apiSecretKey: secret })
const headers = (c: ReturnType<typeof creds>) => ({ "x-xrea-account": c.account, "x-xrea-server": c.serverName, "x-xrea-secret": c.apiSecretKey, "content-type": "application/json" })
const noDomain = async () => {
  throw new Error("MXは確認しない")
}

/** 名前ごとに1つの Durable Object を作る偽の名前空間。同じ名前には同じ実体を返す */
function namespace(make: (name: string) => GatewayTenant) {
  const objects = new Map<string, GatewayTenant>()
  const names: string[] = []
  const ns: GatewayNamespace = {
    idFromName: name => (names.push(name), name),
    get: (id: string) => {
      if (!objects.has(id)) objects.set(id, make(id))
      return objects.get(id)!
    },
  }
  return { ns, objects, names }
}

describe("振り分け", () => {
  test("gateway-durable-object/AC-1: 同じ認証情報の要求が同じ識別子へ届き、異なる認証情報が異なる識別子へ届く", async () => {
    const { ns, objects, names } = namespace(() => new GatewayTenant(undefined, undefined, { xrea: () => new FakeXrea(sampleMails()), domainCheck: noDomain }))
    const fetcher = durableFetcher(ns)
    const call = (c: ReturnType<typeof creds>) => fetcher(c, new Request("http://gateway.internal/v1/aliases", { headers: headers(c) }))
    expect((await call(creds("a"))).status).toBe(200)
    await call(creds("a"))
    await call(creds("b"))
    await call(creds("a", "OTHER-KEY")) // シークレットキーが違えば別のアカウントとして扱う
    expect(names[0]).toBe(names[1])
    expect(new Set(names).size).toBe(3)
    expect(objects.size).toBe(3)
  })
})

describe("Durable Objectの中の処理", () => {
  test("gateway-durable-object/AC-2: 同一アカウントの同時の2件の発行は1件目の完了後に2件目が始まり、別のアカウントは待たされない", async () => {
    const xreas: Record<string, FakeXrea> = { a: new FakeXrea(sampleMails()), b: new FakeXrea(sampleMails()) }
    for (const x of Object.values(xreas)) x.delayMs = 50
    const { ns } = namespace(() => new GatewayTenant(undefined, undefined, { xrea: c => xreas[c.account]!, domainCheck: noDomain }))
    const fetcher = durableFetcher(ns)
    const post = (account: string, name: string) => {
      const c = creds(account)
      return fetcher(c, new Request("http://gateway.internal/v1/aliases", { method: "POST", headers: headers(c), body: JSON.stringify({ name, domain: "example.com", forwardTo: "me@mail.example" }) }))
    }
    const rs = await Promise.all([post("a", "first"), post("a", "second"), post("b", "other")])
    expect(rs.map(r => r.status)).toEqual([201, 201, 201])
    const a = xreas.a!
    const create1 = a.log.find(l => l.op === "create")!
    expect(a.log.filter(l => l.op === "list")[1]!.start).toBeGreaterThanOrEqual(create1.end)
    expect(Math.max(...xreas.b!.log.map(l => l.end))).toBeLessThan(Math.max(...a.log.map(l => l.end)))
  })

  test("gateway-durable-object/AC-3: 同一エンドポイントへの連続2回の要求が1.1秒以上空き、31秒後と変更の成功直後の一覧の取得でXREAが再び呼ばれる", async () => {
    // 実物の XREA クライアントの待ち行列を通し、送信の時刻を記録する
    const sent: { path: string; at: number }[] = []
    const fakeFetch = async (url: string) => {
      sent.push({ path: new URL(url).pathname, at: performance.now() })
      const result = url.endsWith("/mail/list") ? Object.fromEntries(sampleMails().map((m, i) => [String(i), { ...m, pop_pass: "x" }])) : undefined
      return { status: 200, text: async () => JSON.stringify({ status_code: 200, result }) }
    }
    let t = 0
    const tenant = new GatewayTenant(undefined, undefined, { xrea: c => new XreaClient(c, { fetch: fakeFetch as never }), now: () => t, domainCheck: noDomain })
    const c = creds("a")
    const list = () => tenant.fetch(new Request("http://gateway.internal/v1/aliases", { headers: headers(c) }))
    const post = (name: string) => tenant.fetch(new Request("http://gateway.internal/v1/aliases", { method: "POST", headers: headers(c), body: JSON.stringify({ name, domain: "example.com", forwardTo: "me@mail.example" }) }))
    const lists = () => sent.filter(s => s.path === "/v1/mail/list")
    await list()
    t = 29_000
    await list()
    expect(lists()).toHaveLength(1) // キャッシュが有効
    t = 31_000
    await list()
    expect(lists()).toHaveLength(2) // 31秒後は取り直す
    // 発行は一覧を取り直してから作成する。同一エンドポイント（一覧）への続けての要求は1.1秒以上空く
    expect((await post("one")).status).toBe(201)
    expect((await post("two")).status).toBe(201)
    const l = lists()
    for (let i = 1; i < l.length; i++) expect(l[i]!.at - l[i - 1]!.at).toBeGreaterThanOrEqual(1090)
    const before = lists().length
    await list() // 変更の成功直後はキャッシュが破棄されている
    expect(lists().length).toBe(before + 1)
  }, 20_000)

  test("gateway-durable-object/AC-4: 識別子の名前にアカウント名とシークレットキーの文字列が含まれず、永続ストレージへの書き込みが0回である", async () => {
    const key = await tenantKey(creds("my-account", "TOP-SECRET-VALUE"))
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(key).not.toContain("my-account")
    expect(key).not.toContain("TOP-SECRET-VALUE")
    // 永続ストレージに触れたら失敗する状態を渡して、通常の要求を処理する
    const storage = new Proxy({}, { get: () => () => Promise.reject(new Error("storage に触れました")) })
    const tenant = new GatewayTenant({ storage }, {}, { xrea: () => new FakeXrea(sampleMails()), domainCheck: noDomain })
    const c = creds("my-account", "TOP-SECRET-VALUE")
    const res = await tenant.fetch(new Request("http://gateway.internal/v1/aliases", { headers: headers(c) }))
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain("TOP-SECRET-VALUE")
  })

  test("gateway-durable-object/AC-7: 稼働中でキャッシュが有効な一覧の応答が200ミリ秒以内に返る", async () => {
    const xrea = new FakeXrea(sampleMails())
    const tenant = new GatewayTenant(undefined, undefined, { xrea: () => xrea, domainCheck: noDomain })
    const c = creds("a")
    const list = () => tenant.fetch(new Request("http://gateway.internal/v1/aliases", { headers: headers(c) }))
    await list()
    xrea.delayMs = 1500 // キャッシュが効いていれば影響しない
    const start = performance.now()
    expect((await list()).status).toBe(200)
    expect(performance.now() - start).toBeLessThan(200)
  })
})
