import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { AddressInfo } from "node:net"
import { serve, type ServerType } from "@hono/node-server"
import { Hono } from "hono"
import { afterEach, describe, expect, test } from "vitest"
import { ConfigError, loadAppConfig } from "../../src/app/config"
import { staticHandler } from "../../src/app/static"
import { BODY, ENV, XREA, makeApp } from "./helpers"

function webDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-"))
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>入口</title>")
  fs.writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('fetch', () => {})")
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), "{}")
  fs.mkdirSync(path.join(dir, "assets"))
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)")
  return dir
}
let server: ServerType | null = null
afterEach(() => {
  server?.close()
  server = null
})

describe("認証の前段", () => {
  test("alias-service/AC-7: 認証情報を登録していない要求が401になり、ゲートウェイと読み取りサービスが呼び出されない", async () => {
    const { app, seen } = await makeApp()
    for (const [m, p] of [["GET", "/api/aliases"], ["POST", "/api/aliases"], ["PATCH", "/api/aliases/a%40b.c"], ["DELETE", "/api/aliases/a%40b.c"], ["GET", "/api/options"], ["GET", "/api/proton/status"], ["POST", "/api/proton/refresh"]]) {
      const res = await app.request(p!, { method: m, headers: { "content-type": "application/json" }, body: m === "GET" || m === "DELETE" ? undefined : "{}" })
      expect(res.status, `${m} ${p}`).toBe(401)
      expect((await res.json()).error.code).toBe("credentials_required")
    }
    expect(seen.gateway).toEqual([])
    expect(seen.reader).toEqual([])
    // 改ざんしたcookieも未登録として扱う
    expect((await app.request("/api/aliases", { headers: { cookie: "xag_session=v1.AAAA" } })).status).toBe(401)
  })

  test("alias-service/AC-14: 登録の要求で、ゲートウェイの一覧の取得が登録しようとする認証情報で1回呼び出される", async () => {
    const { app, seen, json } = await makeApp()
    const res = await app.request("/api/credentials", { method: "PUT", headers: json, body: JSON.stringify(BODY) })
    expect(res.status).toBe(204)
    expect(seen.gateway).toHaveLength(1)
    expect(seen.gateway[0]!.method).toBe("GET")
    expect(new URL(seen.gateway[0]!.url).pathname).toBe("/v1/aliases")
    expect(seen.gateway[0]!.headers["x-xrea-account"]).toBe(XREA.account)
    expect(seen.gateway[0]!.headers["x-xrea-secret"]).toBe(XREA.apiSecretKey)
  })

  test("認証情報の誤りは400 invalid_credentials、ゲートウェイの不達は502で、cookieは発行されない", async () => {
    const { XreaError } = await import("../../src/xrea/errors")
    const bad = await makeApp()
    bad.xrea.mailList = async () => Promise.reject(new XreaError(500, "認証情報が正しくありません。", "api"))
    const r1 = await bad.app.request("/api/credentials", { method: "PUT", headers: bad.json, body: JSON.stringify(BODY) })
    expect([r1.status, (await r1.json()).error.code, r1.headers.get("set-cookie")]).toEqual([400, "invalid_credentials", null])
    const net = await makeApp()
    net.xrea.mailList = async () => Promise.reject(new XreaError(0, "XREAへ接続できませんでした", "network"))
    const r2 = await net.app.request("/api/credentials", { method: "PUT", headers: net.json, body: JSON.stringify(BODY) })
    expect([r2.status, r2.headers.get("set-cookie")]).toEqual([502, null])
  })
})

describe("設定", () => {
  test("必須の環境変数が未設定なら、不足している変数名を示す", () => {
    expect(() => loadAppConfig({})).toThrow(ConfigError)
    expect(() => loadAppConfig({ ...ENV, XREA_GATEWAY_URL: "" })).toThrow("XREA_GATEWAY_URL")
    expect(() => loadAppConfig({ ...ENV, INTERNAL_TOKEN: "short" })).toThrow("INTERNAL_TOKEN")
    expect(() => loadAppConfig({ ...ENV, COOKIE_SECRET: "short" })).toThrow("COOKIE_SECRET")
    expect(() => loadAppConfig({ ...ENV, XREA_GATEWAY_URL: "ftp://x" })).toThrow(ConfigError)
    expect(() => loadAppConfig({ ...ENV, CREDENTIAL_STORE: "sqlite" }, { allowSqlite: false })).toThrow(ConfigError)
    expect(loadAppConfig({ ...ENV, XREA_GATEWAY_URL: "http://gw:8081/" }).gatewayUrl).toBe("http://gw:8081")
  })

  test("alias-service/AC-11: TUNNEL_TOKEN が未設定または空なら全アドレス、設定があれば自アドレスのみで待ち受け、明示はそれらに優先する", () => {
    expect(loadAppConfig(ENV).bindAddress).toBe("0.0.0.0")
    expect(loadAppConfig({ ...ENV, TUNNEL_TOKEN: "" }).bindAddress).toBe("0.0.0.0")
    expect(loadAppConfig({ ...ENV, TUNNEL_TOKEN: "x" }).bindAddress).toBe("127.0.0.1")
    expect(loadAppConfig({ ...ENV, BIND_ADDRESS: "192.168.1.5" }).bindAddress).toBe("192.168.1.5")
    expect(loadAppConfig({ ...ENV, TUNNEL_TOKEN: "x", BIND_ADDRESS: "0.0.0.0" }).bindAddress).toBe("0.0.0.0")
    expect(loadAppConfig(ENV)).toMatchObject({ port: 3000, logLevel: "info" })
  })
})

describe("配信", () => {
  test("alias-service/AC-10: 画面ファイルの要求と死活確認の要求が、APIと同じポートで応答される", async () => {
    const { app: api } = await makeApp()
    const app = new Hono()
    app.route("/", api)
    app.get("*", staticHandler(webDir()))
    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 })
    await new Promise(r => server!.once("listening", r))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const top = await fetch(`${base}/`)
    expect(top.status).toBe(200)
    expect(top.headers.get("content-type")).toContain("text/html")
    expect(await top.text()).toContain("入口")
    expect((await fetch(`${base}/assets/app.js`)).headers.get("content-type")).toContain("javascript")
    expect(await (await fetch(`${base}/some/route`)).text()).toContain("入口")
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true })
    expect((await fetch(`${base}/api/credentials`)).status).toBe(200)
    expect((await fetch(`${base}/api/aliases`)).status).toBe(401)
  })

  test("web-pwa/AC-8: 宣言・Service Worker・入口は毎回の検証を、版を含む画面ファイルは1年間のキャッシュを指示する", async () => {
    const h = staticHandler(webDir())
    const app = new Hono().get("*", h)
    for (const p of ["/", "/some/route", "/sw.js", "/manifest.webmanifest"]) expect((await app.request(p)).headers.get("cache-control"), p).toBe("no-cache")
    expect((await app.request("/assets/app.js")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect((await app.request("/manifest.webmanifest")).headers.get("content-type")).toBe("application/manifest+json")
    const miss = await app.request("/assets/main-old.js")
    expect([miss.status, miss.headers.get("cache-control")]).toEqual([404, "no-cache"])
  })

  test("画面ファイルの配信は、配信ディレクトリの外のファイルを返さない", async () => {
    const app = new Hono().get("*", staticHandler(webDir()))
    expect(await (await app.request("/..%2F..%2F..%2Fetc%2Fpasswd")).text()).toContain("入口")
  })
})

describe("応答時間", () => {
  test("alias-service/AC-15: ゲートウェイと読み取りサービスの応答を50ミリ秒遅らせた状態で、一覧の応答が200ミリ秒以内に返る", async () => {
    const { app, register } = await makeApp({
      gatewayDelayMs: 50,
      reader: async () => {
        await new Promise(r => setTimeout(r, 50))
        return Response.json({ status: { state: "ready", updatedAt: null, reloginAt: null, itemCount: 0, error: null }, entries: {} })
      },
    })
    const cookie = await register()
    const start = performance.now()
    const res = await app.request("/api/aliases", { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(performance.now() - start).toBeLessThan(200) // 2つの呼び出しは並列に行う
  })

  test("alias-service/AC-17: 読み取りサービスが応答しない状態で、一覧の応答が3秒以内に返る", async () => {
    const { app, register } = await makeApp({ reader: () => new Promise(() => undefined) })
    const cookie = await register()
    const start = performance.now()
    const res = await app.request("/api/aliases", { headers: { cookie } })
    const elapsed = performance.now() - start
    expect(res.status).toBe(200)
    expect((await res.json()).proton.state).toBe("error")
    expect(elapsed).toBeGreaterThanOrEqual(1900) // 2秒で打ち切る
    expect(elapsed).toBeLessThan(3000)
  }, 10_000)
})
