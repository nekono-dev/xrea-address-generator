import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { AliasService } from "../../src/server/aliasService"
import { createApp } from "../../src/server/app"
import { FakeProton, FakeXrea, sampleMails } from "./fakes"

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }
function webDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "web-"))
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>入口</title>")
  fs.writeFileSync(path.join(dir, "sw.js"), "self.addEventListener('fetch', () => {})")
  fs.writeFileSync(path.join(dir, "manifest.webmanifest"), "{}")
  fs.mkdirSync(path.join(dir, "assets"))
  fs.writeFileSync(path.join(dir, "assets", "main-abc123.js"), "console.log(1)")
  return dir
}
const app = () => createApp({ service: new AliasService({ xrea: new FakeXrea(sampleMails()), proton: new FakeProton() }), webDir: webDir(), logger: silent })

describe("配信時のキャッシュの指示", () => {
  test("web-pwa/AC-8: 宣言・Service Worker・画面の入口は毎回の検証を、版を含む画面ファイルは1年間のキャッシュを指示する", async () => {
    const a = app()
    for (const p of ["/", "/some/route", "/sw.js", "/manifest.webmanifest"]) expect((await a.request(p)).headers.get("cache-control"), p).toBe("no-cache")
    expect((await a.request("/assets/main-abc123.js")).headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect((await a.request("/manifest.webmanifest")).headers.get("content-type")).toBe("application/manifest+json")
    expect((await a.request("/sw.js")).headers.get("content-type")).toContain("text/javascript")
  })

  test("存在しない /assets/ のパスは、入口ではなく 404 を返す", async () => {
    const res = await app().request("/assets/main-old.js")
    expect(res.status).toBe(404)
    expect(res.headers.get("cache-control")).toBe("no-cache")
  })
})
