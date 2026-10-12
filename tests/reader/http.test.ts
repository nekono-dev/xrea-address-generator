import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { createReaderApp } from "../../src/reader/app"
import type { CliRunner } from "../../src/reader/cli"
import { ConfigError, loadReaderConfig } from "../../src/reader/config"
import { Tenants } from "../../src/reader/tenants"
import { silentLogger } from "../../src/shared/logger"
import { vaultsJson } from "./helpers"

const TOKEN = "i".repeat(32)
const fixture = fs.readFileSync(path.join(__dirname, "../fixtures/proton-items.json"), "utf8")
const H = (t = "pat-A") => ({ authorization: `Bearer ${TOKEN}`, "x-proton-token": t })
const settle = () => new Promise(r => setTimeout(r, 20))

type Call = { token: string; dir: string; args: string[] }
function setup(max = 20, itemsFor: (token: string) => string = () => fixture) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "reader-"))
  const calls: Call[] = []
  const makeRunner = (token: string, dir: string): CliRunner => async args => {
    calls.push({ token, dir, args })
    fs.mkdirSync(dir, { recursive: true }) // 実物と同じく、実行すると保存先ができる
    if (args[0] === "info") return { stdout: "", durationMs: 1 }
    return { stdout: args[0] === "vault" ? vaultsJson(1) : itemsFor(token), durationMs: 1 }
  }
  const tenants = new Tenants(max, base, { logger: silentLogger, makeRunner })
  const app = createReaderApp({ tenants, internalToken: TOKEN, logger: silentLogger })
  const get = (t?: string) => app.request("/v1/entries", { headers: H(t) })
  return { base, calls, tenants, app, get }
}

const items = (title: string) =>
  JSON.stringify({ items: [{ state: "Active", content: { title, content: { Login: { username: "same@example.com", email: "", password: "PW-SECRET" } } } }] })

describe("認証", () => {
  test("proton-pass-reader/AC-11: 共有シークレットの誤りとトークンの欠落が401になり、死活確認は共有シークレットなしで200になる", async () => {
    const { app, calls } = setup()
    const cases: Record<string, string>[] = [{}, { authorization: "Bearer wrong", "x-proton-token": "t" }, { authorization: `Bearer ${TOKEN}` }, { authorization: `Bearer ${TOKEN}`, "x-proton-token": "" }]
    for (const headers of cases) {
      for (const [m, p] of [["GET", "/v1/entries"], ["POST", "/v1/refresh"]]) {
        const res = await app.request(p!, { method: m, headers })
        expect(res.status).toBe(401)
      }
    }
    expect(calls).toEqual([])
    const hz = await app.request("/healthz")
    expect(hz.status).toBe(200)
    expect(await hz.json()).toEqual({ ok: true })
    expect((await app.request("/health")).status).toBe(200)
  })

  test("INTERNAL_TOKEN が未設定または短いと失敗し、既定値が仕様どおりになる", () => {
    expect(() => loadReaderConfig({})).toThrow(ConfigError)
    expect(() => loadReaderConfig({ INTERNAL_TOKEN: "x" })).toThrow(/INTERNAL_TOKEN/)
    expect(loadReaderConfig({ INTERNAL_TOKEN: TOKEN })).toEqual({
      internalToken: TOKEN, sessionDir: "/var/lib/xrea-alias-dashboard/session", maxTenants: 20, port: 8082, bindAddress: "0.0.0.0", logLevel: "info",
    })
  })
})

describe("トークンの分離", () => {
  test("proton-pass-reader/AC-1: 2つの異なるトークンの要求で、公式CLIにそれぞれのトークンと別のセッション保存先が渡される", async () => {
    const { get, calls, base } = setup()
    await get("pat-A")
    await get("pat-B")
    await settle()
    const byToken = (t: string) => calls.filter(c => c.token === t)
    expect(byToken("pat-A").length).toBeGreaterThan(0)
    expect(byToken("pat-B").length).toBeGreaterThan(0)
    const dirA = new Set(byToken("pat-A").map(c => c.dir))
    const dirB = new Set(byToken("pat-B").map(c => c.dir))
    expect(dirA.size).toBe(1)
    expect(dirB.size).toBe(1)
    expect([...dirA][0]).not.toBe([...dirB][0])
    expect([...dirA][0]!.startsWith(base)).toBe(true)
    expect([...dirA][0]).not.toContain("pat-A") // トークンそのものをパスに使わない
  })

  test("proton-pass-reader/AC-6: 有効期間内の2回目の取得で公式CLIが呼び出されず、別のトークンの対応表が混ざらない", async () => {
    const { get, calls } = setup(20, t => (t === "pat-A" ? items("from-A") : items("from-B")))
    await get("pat-A")
    await get("pat-B")
    await settle()
    const n = calls.length
    const a = await (await get("pat-A")).json()
    const b = await (await get("pat-B")).json()
    expect(calls.length).toBe(n)
    expect(a.entries).toEqual({ "same@example.com": ["from-A"] })
    expect(b.entries).toEqual({ "same@example.com": ["from-B"] })
  })
})

describe("応答の項目", () => {
  test("proton-pass-reader/AC-4: 応答の項目が許可した項目だけで、パスワードとVault名とURLを含まない", async () => {
    const { get } = setup()
    await get()
    await settle()
    const res = await get()
    const text = await res.text()
    const j = JSON.parse(text)
    expect(Object.keys(j).sort()).toEqual(["entries", "status"])
    expect(Object.keys(j.status).sort()).toEqual(["error", "itemCount", "reloginAt", "state", "updatedAt"])
    expect(j.status.state).toBe("ready")
    expect(j.entries["sns@example.com"]).toEqual(["Bluesky", "X (Twitter)"])
    for (const secret of ["FIXTURE-SECRET", "FIXTURE-NOTE", "FIXTURE-TOTP", "https://i1.example", "vault0"]) expect(text).not.toContain(secret)
  })

  test("proton-pass-reader/AC-9: 初回の要求は取得中の状態を返し、更新の要求は202を返す", async () => {
    const { get, app } = setup()
    const first = await (await get()).json()
    expect(first.status.state).toBe("loading")
    expect(first.entries).toEqual({})
    await settle()
    expect((await app.request("/v1/refresh", { method: "POST", headers: H() })).status).toBe(202)
  })
})

describe("トークンごとの保持と破棄", () => {
  test("proton-pass-reader/AC-12: 21個目のトークンの要求で最も古く使われたトークンが破棄され、そのセッション保存先が削除される", async () => {
    const { get, calls, tenants } = setup(20)
    for (let i = 0; i < 20; i++) await get(`pat-${i}`)
    await settle()
    await get("pat-0") // pat-0 を最近使ったことにする
    const dirOf = (t: string) => calls.find(c => c.token === t)!.dir
    expect(fs.existsSync(dirOf("pat-1"))).toBe(true)
    await get("pat-20")
    expect(tenants.size).toBe(20)
    expect(fs.existsSync(dirOf("pat-1"))).toBe(false) // 最も古い pat-1 の保存先が消える
    expect(fs.existsSync(dirOf("pat-0"))).toBe(true)
  })

  test("proton-pass-reader/AC-17: 保持するトークンの数が20を超えない", async () => {
    const { get, tenants } = setup(20)
    for (let i = 0; i < 45; i++) {
      await get(`pat-${i}`)
      expect(tenants.size).toBeLessThanOrEqual(20)
    }
  })
})
