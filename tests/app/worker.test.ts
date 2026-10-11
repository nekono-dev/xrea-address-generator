import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Miniflare, Response as MfResponse } from "miniflare"
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { sampleMails } from "../gateway/fakes"
import { BODY, ENV, makeApp, makeFetch } from "./helpers"
import { bundleWorker } from "./workerBundle"

let mf: Miniflare
const xreaFake = () =>
  Response.json({ status_code: 200, result: Object.fromEntries(sampleMails().map((m, i) => [String(i), { ...m, pop_pass: "x" }])) })
const fx = makeFetch({})

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-"))
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>入口</title>")
  fs.mkdirSync(path.join(dir, "assets"))
  fs.writeFileSync(path.join(dir, "assets", "main-abc123.js"), "console.log(1)")
  fs.copyFileSync("web/public/_headers", path.join(dir, "_headers"))
  mf = new Miniflare({
    workers: [
      {
        modules: true,
        script: await bundleWorker(),
        compatibilityDate: "2026-08-01",
        bindings: ENV,
        assets: { directory: dir, binding: "ASSETS", routerConfig: { has_user_worker: true, static_routing: { user_worker: ["/api/*", "/healthz"] } }, assetConfig: { not_found_handling: "none" } },
        // ゲートウェイは Worker 内の Durable Object として動く（実物のクラスを使う）
        durableObjects: { GATEWAY: "GatewayTenant" },
        unsafeEphemeralDurableObjects: true,
        // Worker からの外向きの要求を偽の実装へ向ける。XREA は一覧の応答だけを返し、読み取りサービスは偽の実装に渡す
        outboundService: async (req: any) => {
          if (new URL(req.url).host === "api.xrea.com") return xreaFake() as unknown as MfResponse
          return (await fx.fetch(req.url, { method: req.method, headers: req.headers, body: req.body && (await req.text()) })) as unknown as MfResponse
        },
      },
    ],
  })
  await mf.ready
}, 60_000)
afterAll(async () => {
  await mf?.dispose()
})

describe("Workersの実行環境", () => {
  test("alias-service/AC-12: Node.jsとWorkersで同じAPIの要求が同じ応答になる", async () => {
    const node = await makeApp({ xrea: fx.xrea })
    const nodeCookie = await node.register()
    const nodeBody = await (await node.app.request("/api/aliases", { headers: { cookie: nodeCookie } })).json()

    const put = await mf.dispatchFetch("http://app.test/api/credentials", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(BODY) })
    expect(put.status).toBe(204)
    const cookie = put.headers.get("set-cookie")!.split(";")[0]!
    expect(put.headers.get("set-cookie")).toContain("HttpOnly")
    const res = await mf.dispatchFetch("http://app.test/api/aliases", { headers: { cookie } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(nodeBody)
    // 未登録は401
    expect((await mf.dispatchFetch("http://app.test/api/aliases")).status).toBe(401)
    expect(await (await mf.dispatchFetch("http://app.test/healthz")).json()).toEqual({ ok: true })
  }, 30_000)

  test("alias-service/AC-27: Node.jsではゲートウェイの呼び出しがネットワークを使わず、Workersでは Durable Object を通して一覧が返る", async () => {
    const spy = vi.spyOn(globalThis, "fetch")
    const node = await makeApp()
    const cookie = await node.register()
    expect((await node.app.request("/api/aliases", { headers: { cookie } })).status).toBe(200)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
    expect(node.seen.gateway.length).toBeGreaterThan(0)
    // Workers: 登録（一覧の取得）と一覧が、束縛 GATEWAY の Durable Object を通って成功する
    const put = await mf.dispatchFetch("http://app.test/api/credentials", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ xrea: { account: "other-acct", serverName: "s1.xrea.com", apiSecretKey: "OTHER-KEY" } }) })
    expect(put.status).toBe(204)
    const res = await mf.dispatchFetch("http://app.test/api/aliases", { headers: { cookie: put.headers.get("set-cookie")!.split(";")[0]! } })
    expect(res.status).toBe(200)
    expect((await res.json() as any).aliases.length).toBeGreaterThan(0)
  }, 30_000)

  test("alias-service/AC-12: Workersで版を含む画面ファイルが1年間のキャッシュの指示を伴い、未知のパスは入口を返す", async () => {
    const asset = await mf.dispatchFetch("http://app.test/assets/main-abc123.js")
    expect(asset.status).toBe(200)
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    const top = await mf.dispatchFetch("http://app.test/")
    expect(top.headers.get("cache-control")).toBe("no-cache")
    expect(await (await mf.dispatchFetch("http://app.test/some/route")).text()).toContain("入口")
    expect((await mf.dispatchFetch("http://app.test/assets/main-old.js")).status).toBe(404)
  }, 30_000)
})
