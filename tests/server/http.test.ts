import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { serve, type ServerType } from "@hono/node-server"
import { afterEach, describe, expect, test } from "vitest"
import { AliasService } from "../../src/server/aliasService"
import { createApp } from "../../src/server/app"
import { ConfigError, loadConfig } from "../../src/server/config"
import { ListCache } from "../../src/server/listCache"
import { Mutex } from "../../src/server/mutex"
import { XreaError } from "../../src/xrea/errors"
import { FakeProton, FakeXrea, sampleMails } from "./fakes"

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }
function webDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-"))
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>入口</title>")
  fs.mkdirSync(path.join(dir, "assets"))
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)")
  return dir
}
const build = (xrea = new FakeXrea(sampleMails())) => {
  const service = new AliasService({ xrea, proton: new FakeProton() })
  return { xrea, service, app: createApp({ service, webDir: webDir(), logger: silent }) }
}
let server: ServerType | null = null
afterEach(() => {
  server?.close()
  server = null
})

describe("HTTPの入出力と配信", () => {
  test("alias-service/AC-13: 画面ファイルの要求と死活確認の要求が、APIと同じポートで応答される", async () => {
    const { app } = build()
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 })
    await new Promise(r => server!.once("listening", r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const top = await fetch(`${base}/`)
    expect(top.status).toBe(200)
    expect(top.headers.get("content-type")).toContain("text/html")
    expect(await top.text()).toContain("入口")
    expect((await fetch(`${base}/assets/app.js`)).headers.get("content-type")).toContain("javascript")
    expect(await (await fetch(`${base}/some/route`)).text()).toContain("入口") // 該当ファイルが無いパスは入口
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true })
    expect((await fetch(`${base}/api/aliases`)).status).toBe(200)
  })

  test("画面ファイルの配信は、配信ディレクトリの外のファイルを返さない", async () => {
    const { app } = build()
    const res = await app.request("/..%2F..%2F..%2Fetc%2Fpasswd")
    expect(await res.text()).toContain("入口")
  })

  test("不正なJSONの本文は 400 validation_error になる", async () => {
    const { app } = build()
    const res = await app.request("/api/aliases", { method: "POST", body: "{", headers: { "content-type": "application/json" } })
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe("validation_error")
  })

  test("XREAのエラーは、メッセージ付きなら 502、送信間隔の超過なら 503 になる", async () => {
    const xrea = new FakeXrea(sampleMails())
    const { app } = build(xrea)
    xrea.mailList = async () => Promise.reject(new XreaError(500, "認証情報が正しくありません。", "api"))
    let res = await app.request("/api/aliases")
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: { code: "upstream_error", message: "認証情報が正しくありません。" } })
    xrea.mailList = async () => Promise.reject(new XreaError(500, "", "rate_limit"))
    res = await app.request("/api/options")
    expect(res.status).toBe(503)
    expect((await res.json()).error.code).toBe("rate_limited")
  })

  test("必須の環境変数が未設定なら、不足している変数名を示す", () => {
    expect(() => loadConfig({ XREA_ACCOUNT: "a" })).toThrow(ConfigError)
    expect(() => loadConfig({ XREA_ACCOUNT: "a" })).toThrow("XREA_SERVER_NAME, XREA_API_SECRET_KEY")
    const c = loadConfig({ XREA_ACCOUNT: "a", XREA_SERVER_NAME: "s", XREA_API_SECRET_KEY: "k", PROTON_PASS_PERSONAL_ACCESS_TOKEN: "t", TUNNEL_TOKEN: "x" })
    expect(c).toMatchObject({ bindAddress: "127.0.0.1", port: 3000, logLevel: "info", proton: { token: "t", sessionDir: "/var/lib/xrea-address-generator/session" } })
  })

  test("alias-service/AC-20: Proton Passのトークンが未設定でも起動でき、連携は無効になる", () => {
    const base = { XREA_ACCOUNT: "a", XREA_SERVER_NAME: "s", XREA_API_SECRET_KEY: "k" }
    expect(loadConfig(base).proton).toBeNull()
    expect(loadConfig({ ...base, PROTON_PASS_PERSONAL_ACCESS_TOKEN: "" }).proton).toBeNull()
  })

  test("alias-service/AC-21: TUNNEL_TOKEN が未設定なら全アドレスで待ち受け、設定があれば 127.0.0.1 で待ち受ける", () => {
    const base = { XREA_ACCOUNT: "a", XREA_SERVER_NAME: "s", XREA_API_SECRET_KEY: "k" }
    expect(loadConfig(base).bindAddress).toBe("0.0.0.0")
    expect(loadConfig({ ...base, TUNNEL_TOKEN: "" }).bindAddress).toBe("0.0.0.0")
    expect(loadConfig({ ...base, TUNNEL_TOKEN: "x" }).bindAddress).toBe("127.0.0.1")
    // 待ち受けアドレスを明示したときは、それを優先する
    expect(loadConfig({ ...base, BIND_ADDRESS: "192.168.1.5" }).bindAddress).toBe("192.168.1.5")
    expect(loadConfig({ ...base, TUNNEL_TOKEN: "x", BIND_ADDRESS: "0.0.0.0" }).bindAddress).toBe("0.0.0.0")
  })
})

describe("キャッシュと排他", () => {
  test("alias-service/AC-14: キャッシュが有効なときの一覧の応答が、200ミリ秒以内に返る", async () => {
    const { app, xrea } = build()
    await app.request("/api/aliases")
    xrea.delayMs = 1500 // キャッシュが効いていれば影響しない
    const start = performance.now()
    const res = await app.request("/api/aliases")
    expect(res.status).toBe(200)
    expect(performance.now() - start).toBeLessThan(200)
    expect(xrea.calls.filter(c => c === "list")).toHaveLength(1)
  })

  test("alias-service/AC-16: 31秒後の一覧の取得でXREAが再び呼び出され、発行の成功直後の一覧の取得でも再び呼び出される", async () => {
    let t = 0
    const xrea = new FakeXrea(sampleMails())
    const service = new AliasService({ xrea, proton: new FakeProton(), now: () => t })
    await service.listAliases()
    t = 29_000
    await service.listAliases()
    expect(xrea.calls.filter(c => c === "list")).toHaveLength(1)
    t = 31_000
    await service.listAliases()
    expect(xrea.calls.filter(c => c === "list")).toHaveLength(2)
    await service.createAlias({ name: "new", domain: "example.com", forwardTo: "me@mail.example" }) // 内部で一覧を取り直す
    const before = xrea.calls.filter(c => c === "list").length
    await service.listAliases()
    expect(xrea.calls.filter(c => c === "list")).toHaveLength(before + 1)
  })

  test("alias-service/AC-17: 同時に送信した2件の発行要求が、1件目の完了後に2件目の処理を開始する", async () => {
    const xrea = new FakeXrea(sampleMails())
    xrea.delayMs = 50
    const { app } = build(xrea)
    const post = (name: string) =>
      app.request("/api/aliases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, domain: "example.com", forwardTo: "me@mail.example" }) })
    const [a, b] = await Promise.all([post("first"), post("second")])
    expect(a.status).toBe(201)
    expect(b.status).toBe(201)
    const create1 = xrea.log.find(l => l.op === "create")!
    const secondStart = xrea.log.filter(l => l.op === "list")[1]!.start
    expect(secondStart).toBeGreaterThanOrEqual(create1.end)
  })

  test("一覧のキャッシュは破棄で取り直し、排他は失敗しても後続を実行する", async () => {
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
