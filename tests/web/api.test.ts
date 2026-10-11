import { afterEach, describe, expect, test } from "vitest"
import { api, ApiFailure, NETWORK_ERROR, setFetch } from "../../web/src/api"
import { createStore, view } from "../../web/src/store"

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
afterEach(() => setFetch((...a) => fetch(...a)))

describe("通信層", () => {
  test("要求の経路・メソッド・本文が設計どおりに送信される", async () => {
    const seen: string[] = []
    setFetch(async (url, init) => {
      seen.push(`${init?.method} ${url} ${init?.body ?? ""}`)
      if (init?.method === "DELETE") return new Response(null, { status: 204 })
      if (String(url).endsWith("/refresh")) return new Response(null, { status: 202 })
      return json(200, { ok: true })
    })
    await api.list()
    await api.options()
    await api.create({ domain: "example.com", forwardTo: "me@mail.example" })
    await api.remove("a+b@example.com")
    await api.protonStatus()
    await api.protonRefresh()
    expect(seen).toEqual([
      "GET /api/aliases ",
      "GET /api/options ",
      'POST /api/aliases {"domain":"example.com","forwardTo":"me@mail.example"}',
      "DELETE /api/aliases/a%2Bb%40example.com ",
      "GET /api/proton/status ",
      "POST /api/proton/refresh {}",
    ])
  })

  test("4xx・5xx のエラー本文は、サーバのメッセージを持つ例外になる", async () => {
    setFetch(async () => json(409, { error: { code: "conflict", message: "shop@example.com はすでに存在します" } }))
    const e = await api.create({ domain: "d", forwardTo: "f" }).catch(x => x)
    expect(e).toBeInstanceOf(ApiFailure)
    expect(e).toMatchObject({ status: 409, code: "conflict", message: "shop@example.com はすでに存在します" })
  })

  test("通信の失敗は「サーバへ接続できません」になる", async () => {
    setFetch(async () => Promise.reject(new TypeError("Failed to fetch")))
    await expect(api.list()).rejects.toMatchObject({ message: NETWORK_ERROR, code: "network" })
  })
})

describe("状態の保持", () => {
  test("追加・削除・強調・通知の自動消去", async () => {
    const s = createStore()
    let n = 0
    s.subscribe(() => n++)
    const a = { address: "a@x", name: "a", domain: "x", forwardTo: "f@x", protonEntries: [], mailbox: false }
    s.add(a)
    s.add({ ...a, forwardTo: "g@x" })
    expect(s.get().aliases).toHaveLength(1)
    s.flash("a@x")
    expect(s.get().flash).toBe("a@x")
    s.remove("a@x")
    expect(s.get().aliases).toEqual([])
    s.toast("こんにちは")
    expect(s.get().toasts.map(t => t.text)).toEqual(["こんにちは"])
    expect(n).toBeGreaterThan(0)
  })

  test("絞り込みと並び替え", () => {
    const mk = (address: string, domain: string) => ({ address, name: "", domain, forwardTo: "", protonEntries: [], mailbox: false })
    const list = [mk("b@x.com", "x.com"), mk("a@y.com", "y.com"), mk("c@x.com", "x.com")]
    expect(view(list, null, "asc").map(a => a.address)).toEqual(["a@y.com", "b@x.com", "c@x.com"])
    expect(view(list, "x.com", "desc").map(a => a.address)).toEqual(["c@x.com", "b@x.com"])
  })
})
