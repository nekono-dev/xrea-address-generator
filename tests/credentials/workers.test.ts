import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { afterAll, beforeAll, expect, test } from "vitest"

let mf: Miniflare
beforeAll(async () => {
  const out = await build({
    entryPoints: ["tests/credentials/fixtures/workerEntry.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  })
  mf = new Miniflare({
    workers: [{ modules: true, script: out.outputFiles[0]!.text, compatibilityDate: "2025-01-01" }],
  })
}, 60_000)
afterAll(async () => {
  await mf?.dispose()
})

test("credential-session/AC-12: Workersの実行環境でcookie方式の保存と取り出しが成功する", async () => {
  const cred = {
    xrea: { account: "acct", serverName: "s1.xrea.com", apiSecretKey: "SECRET" },
    protonToken: null,
  }
  const saved = await mf.dispatchFetch("http://localhost/save", { method: "POST", body: JSON.stringify(cred) })
  expect(saved.status).toBe(204)
  const cookie = saved.headers.get("set-cookie")!.split(";")[0]!
  const loaded = await mf.dispatchFetch("http://localhost/load", { headers: { cookie } })
  expect(((await loaded.json()) as any).credentials).toEqual(cred)
}, 60_000)
