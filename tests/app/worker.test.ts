import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Miniflare, Response as MfResponse } from "miniflare"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { BODY, ENV, makeApp, makeFetch } from "./helpers"
import { bundleWorker } from "./workerBundle"

let mf: Miniflare
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
        // Worker からの外向きの要求（ゲートウェイと読み取りサービス）を、偽の実装へ向ける
        outboundService: async (req: any) => (await fx.fetch(req.url, { method: req.method, headers: req.headers, body: req.body && (await req.text()) })) as unknown as MfResponse,
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
