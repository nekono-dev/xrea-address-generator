import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, test, vi } from "vitest"
import { createGatewayApp } from "../../src/gateway/app"
import { ListCache } from "../../src/gateway/listCache"
import { Mutex } from "../../src/gateway/mutex"
import { Registry } from "../../src/gateway/registry"
import { AppError } from "../../src/shared/errors"
import { silentLogger } from "../../src/shared/logger"
import { XreaError } from "../../src/xrea/errors"
import { FakeXrea, sampleMails } from "./fakes"

const H = { "x-xrea-account": "acct", "x-xrea-server": "s1.xrea.com", "x-xrea-secret": "XREA-SECRET-KEY" }
const JSON_H = { ...H, "content-type": "application/json" }

function setup(xrea = new FakeXrea(sampleMails()), logger = silentLogger, now: () => number = Date.now) {
  const registry = new Registry(100, 600_000, now, () => xrea)
  return { xrea, registry, app: createGatewayApp({ registry, logger, domainCheck: noDomain }) }
}

const noDomain = async () => {
  throw new AppError("validation_error", "テストではMXを確認しません")
}

describe("認証情報の検査と組み込み", () => {
  test("xrea-gateway/AC-7: 認証情報の項目が1つでも欠けた要求が401になり、XREAは呼ばれない", async () => {
    const { app, xrea } = setup()
    const bad: Record<string, string>[] = [
      {},
      { ...H, "x-xrea-secret": "" },
      { ...H, "x-xrea-account": "" },
      { ...H, "x-xrea-server": "" },
      { "x-xrea-account": "a", "x-xrea-server": "s" },
    ]
    for (const headers of bad) {
      const res = await app.request("/v1/aliases", { headers })
      expect(res.status).toBe(401)
      expect((await res.json()).error.code).toBe("unauthorized")
    }
    expect(xrea.calls).toEqual([])
  })

  test("xrea-gateway/AC-11: ゲートウェイの呼び出しがfetchを使わず、待ち受けのコードを持たない", async () => {
    const { app } = setup()
    const f = vi.spyOn(globalThis, "fetch")
    expect((await app.request("/v1/aliases", { headers: H })).status).toBe(200)
    expect(f).not.toHaveBeenCalled()
    f.mockRestore()
    // ゲートウェイの実装にポートを開く部品が含まれない（待ち受けはアプリの入口だけが持つ）
    const dir = new URL("../../src/gateway/", import.meta.url)
    for (const file of readdirSync(dir)) {
      const text = readFileSync(new URL(file, dir), "utf8")
      expect(text, file).not.toMatch(/node-server|\.listen\(|serve\(/)
    }
  })

  test("XREAのエラーは、メッセージ付きなら 424、送信間隔の超過なら 429 になる（5xx は Cloudflare に本文を置き換えられるため使わない）", async () => {
    const xrea = new FakeXrea(sampleMails())
    const { app } = setup(xrea)
    xrea.mailList = async () => Promise.reject(new XreaError(500, "認証情報が正しくありません。", "api"))
    let res = await app.request("/v1/aliases", { headers: H })
    expect(res.status).toBe(424)
    expect(await res.json()).toEqual({ error: { code: "upstream_error", message: "認証情報が正しくありません。", kind: "api" } })
    xrea.mailList = async () => Promise.reject(new XreaError(500, "", "rate_limit"))
    res = await app.request("/v1/options", { headers: H })
    expect(res.status).toBe(429)
    expect((await res.json()).error.code).toBe("rate_limited")
  })

  test("想定外の例外は500で、詳細を応答にもログにも出さない", async () => {
    const xrea = new FakeXrea(sampleMails())
    xrea.mailList = async () => Promise.reject(new Error("boom XREA-SECRET-KEY"))
    const lines: string[] = []
    const logger = { info: (o: object) => lines.push(JSON.stringify(o)), warn: (o: object) => lines.push(JSON.stringify(o)), error: (o: object) => lines.push(JSON.stringify(o)) }
    const { app } = setup(xrea, logger)
    const res = await app.request("/v1/aliases", { headers: H })
    expect(res.status).toBe(500)
    expect(await res.text() + lines.join("\n")).not.toContain("XREA-SECRET-KEY")
  })
})

describe("秘匿情報", () => {
  test("xrea-gateway/AC-9: 一覧・発行・エラー応答とログに、パスワード項目とシークレットキーが含まれない", async () => {
    const xrea = new FakeXrea(sampleMails().map(m => ({ ...m, pop_pass: "XREA-POP-PASSWORD" }) as never))
    const lines: string[] = []
    const logger = { info: (o: object) => lines.push(JSON.stringify(o)), warn: (o: object) => lines.push(JSON.stringify(o)), error: (o: object) => lines.push(JSON.stringify(o)) }
    const { app } = setup(xrea, logger)
    const out: string[] = []
    out.push(await (await app.request("/v1/aliases", { headers: H })).text())
    out.push(await (await app.request("/v1/aliases", { method: "POST", headers: JSON_H, body: JSON.stringify({ name: "new", domain: "example.com", forwardTo: "me@mail.example" }) })).text())
    out.push(await (await app.request("/v1/aliases", { method: "POST", headers: JSON_H, body: JSON.stringify({ name: "shop", domain: "example.com", forwardTo: "me@mail.example" }) })).text())
    out.push(await (await app.request("/v1/aliases", { headers: { ...H, "x-xrea-secret": "" } })).text())
    const all = [...out, ...lines].join("\n")
    expect(all).not.toContain("XREA-POP-PASSWORD")
    expect(all).not.toContain("pop_pass")
    expect(all).not.toContain("XREA-SECRET-KEY")
    expect(lines.join("\n")).not.toContain("shop@example.com")
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe("アカウントごとのキャッシュ・排他・保持", () => {
  test("xrea-gateway/AC-12: キャッシュが有効なときの一覧の応答が、200ミリ秒以内に返る", async () => {
    const { app, xrea } = setup()
    await app.request("/v1/aliases", { headers: H })
    xrea.delayMs = 1500 // キャッシュが効いていれば影響しない
    const start = performance.now()
    const res = await app.request("/v1/aliases", { headers: H })
    expect(res.status).toBe(200)
    expect(performance.now() - start).toBeLessThan(200)
    expect(xrea.calls.filter(c => c === "list")).toHaveLength(1)
  })

  test("xrea-gateway/AC-14: 31秒後の一覧の取得でXREAが再び呼ばれ、発行の成功直後の一覧の取得でも再び呼ばれる", async () => {
    let t = 0
    const { app, xrea } = setup(new FakeXrea(sampleMails()), silentLogger, () => t)
    const list = () => app.request("/v1/aliases", { headers: H })
    const lists = () => xrea.calls.filter(c => c === "list").length
    await list()
    t = 29_000
    await list()
    expect(lists()).toBe(1)
    t = 31_000
    await list()
    expect(lists()).toBe(2)
    await app.request("/v1/aliases", { method: "POST", headers: JSON_H, body: JSON.stringify({ name: "new", domain: "example.com", forwardTo: "me@mail.example" }) })
    const before = lists()
    await list()
    expect(lists()).toBe(before + 1)
  })

  test("xrea-gateway/AC-8: 同時の2件の発行は1件目の完了後に2件目が始まり、別のアカウントは待たされない", async () => {
    const xreas = { a: new FakeXrea(sampleMails()), b: new FakeXrea(sampleMails()) }
    xreas.a.delayMs = 50
    xreas.b.delayMs = 50
    const registry = new Registry(100, 600_000, Date.now, c => (c.account === "a" ? xreas.a : xreas.b))
    const app = createGatewayApp({ registry, logger: silentLogger, domainCheck: noDomain })
    const post = (account: string, name: string) =>
      app.request("/v1/aliases", { method: "POST", headers: { ...JSON_H, "x-xrea-account": account }, body: JSON.stringify({ name, domain: "example.com", forwardTo: "me@mail.example" }) })
    const rs = await Promise.all([post("a", "first"), post("a", "second"), post("b", "other")])
    expect(rs.map(r => r.status)).toEqual([201, 201, 201])
    const create1 = xreas.a.log.find(l => l.op === "create")!
    expect(xreas.a.log.filter(l => l.op === "list")[1]!.start).toBeGreaterThanOrEqual(create1.end)
    // 別のアカウントは、aの2件目の完了を待たずに完了する
    const aEnd = Math.max(...xreas.a.log.map(l => l.end))
    const bEnd = Math.max(...xreas.b.log.map(l => l.end))
    expect(bEnd).toBeLessThan(aEnd)
  })

  test("xrea-gateway/AC-10: 101個目で最も古く使われたクライアントが破棄され、10分後に使われていないクライアントが破棄される", async () => {
    let t = 0
    const made: string[] = []
    const reg = new Registry(100, 600_000, () => t, c => (made.push(c.account), new FakeXrea([])))
    const creds = (i: number) => ({ account: `a${i}`, serverName: "s", apiSecretKey: "k" })
    for (let i = 0; i < 100; i++) await reg.get(creds(i))
    expect(reg.size).toBe(100)
    await reg.get(creds(0)) // a0 を最近使ったことにする
    await reg.get(creds(100))
    expect(reg.size).toBe(100)
    await reg.get(creds(0))
    expect(made).toHaveLength(101) // a0 は破棄されていない
    await reg.get(creds(1))
    expect(made).toHaveLength(102) // a1 が最も古く、破棄されていた
    t = 600_001
    await reg.get(creds(2)) // 他のものは10分を過ぎて破棄される
    expect(reg.size).toBe(1)
  })

  test("xrea-gateway/AC-15: 一覧のキャッシュは破棄で取り直し、排他は失敗しても後続を実行する", async () => {
    let n = 0
    const cache = new ListCache(async () => [{ no: ++n } as never], 30_000, () => 0)
    await cache.get()
    await cache.get()
    expect(n).toBe(1)
    cache.invalidate()
    await cache.get()
    expect(n).toBe(2)
    const m = new Mutex()
    await expect(m.run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x")
    await expect(m.run(async () => "ok")).resolves.toBe("ok")
  })
})
