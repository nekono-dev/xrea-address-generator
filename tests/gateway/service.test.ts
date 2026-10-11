import { describe, expect, test } from "vitest"
import { createGatewayApp } from "../../src/gateway/app"
import { Registry } from "../../src/gateway/registry"
import { randomName } from "../../src/gateway/randomName"
import { WORDS } from "../../src/gateway/words"
import { silentLogger } from "../../src/shared/logger"
import { FakeXrea, mail, sampleMails } from "./fakes"

const TOKEN = "t".repeat(32)
const H = { authorization: `Bearer ${TOKEN}`, "x-xrea-account": "acct", "x-xrea-server": "s1.xrea.com", "x-xrea-secret": "SECRET" }
const JSON_H = { ...H, "content-type": "application/json" }

function setup(mails = sampleMails(), opts: { rnd?: () => number; words?: readonly string[] } = {}) {
  const xrea = new FakeXrea(mails)
  const registry = new Registry(100, 600_000, Date.now, () => xrea)
  const app = createGatewayApp({ registry, internalToken: TOKEN, logger: silentLogger, ...opts })
  const post = (b: object) => app.request("/v1/aliases", { method: "POST", headers: JSON_H, body: JSON.stringify(b) })
  const patch = (address: string, b: unknown) =>
    app.request(`/v1/aliases/${encodeURIComponent(address)}`, { method: "PATCH", headers: JSON_H, body: JSON.stringify(b) })
  const del = (address: string) => app.request(`/v1/aliases/${encodeURIComponent(address)}`, { method: "DELETE", headers: H })
  return { xrea, app, post, patch, del }
}

describe("一覧・候補", () => {
  test("xrea-gateway/AC-1: 破棄を除くアドレスが返り、受信のみと両方にメールボックスの印が付く", async () => {
    const { app } = setup([...sampleMails(), mail(6, "gone", "example.org", 4)])
    const { aliases } = await (await app.request("/v1/aliases", { headers: H })).json()
    expect(aliases.map((a: any) => [a.address, a.mailbox])).toEqual([
      ["bank@example.org", false],
      ["mail@example.com", true],
      ["mail@example.net", true],
      ["shop@example.com", false],
      ["sns@example.net", false],
    ])
    expect(aliases.find((a: any) => a.address === "sns@example.net")).toEqual({
      address: "sns@example.net",
      name: "sns",
      domain: "example.net",
      forwardTo: "sub@mail.example",
      mailbox: false,
    })
  })

  test("xrea-gateway/AC-6: ドメインと転送先がそれぞれ重複なく昇順で返る", async () => {
    const { app } = setup()
    expect(await (await app.request("/v1/options", { headers: H })).json()).toEqual({
      domains: ["example.com", "example.net", "example.org"],
      forwardTargets: ["me@mail.example", "sub@mail.example"],
    })
  })
})

describe("発行", () => {
  test("xrea-gateway/AC-2: 転送のみ・指定のドメイン・指定の転送先で作成される", async () => {
    const { post, xrea } = setup()
    const res = await post({ name: "Travel", domain: "example.net", forwardTo: "sub@mail.example" })
    expect(res.status).toBe(201)
    expect((await res.json()).alias).toEqual({ address: "travel@example.net", name: "travel", domain: "example.net", forwardTo: "sub@mail.example", mailbox: false })
    expect(xrea.created).toEqual([{ name: "travel", domain: "example.net", forwardTo: "sub@mail.example" }])
    expect(xrea.mails.find(m => m.address_name === "travel")!.pop_how).toBe(1)
  })

  test("xrea-gateway/AC-2: 名前が空なら単語2つのピリオド区切りに数字2桁を直結した名前になる", async () => {
    const { post, xrea } = setup()
    for (const name of [undefined, "", "  "]) await post({ name, domain: "example.com", forwardTo: "me@mail.example" })
    expect(xrea.created).toHaveLength(3)
    for (const c of xrea.created) {
      expect(c.name).toMatch(/^[a-z]+\.[a-z]+[1-9]\d$/)
      const [w1, rest] = c.name.split(".")
      expect(WORDS).toContain(w1)
      expect(WORDS).toContain(rest!.replace(/\d+$/, ""))
    }
    expect(WORDS).toHaveLength(256)
    let i = 0
    const v = [0, 0.9, 0.355]
    expect(randomName(["quiet", "river"], () => v[i++]!)).toBe("quiet.river41")
  })

  test("xrea-gateway/AC-3: 空白を含む名前・候補にないドメイン・形式不正の転送先は400で、作成されない", async () => {
    const { post, xrea } = setup()
    for (const body of [
      { name: "has space", domain: "example.com", forwardTo: "me@mail.example" },
      { name: "ok", domain: "unknown.example", forwardTo: "me@mail.example" },
      { name: "ok", domain: "example.com", forwardTo: "not-an-address" },
      { name: ".dot", domain: "example.com", forwardTo: "me@mail.example" },
      { name: "a..b", domain: "example.com", forwardTo: "me@mail.example" },
      { name: "x".repeat(50), domain: "example.com", forwardTo: "me@mail.example" },
    ]) {
      const res = await post(body)
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("validation_error")
    }
    expect(xrea.created).toEqual([])
    expect((await post({ name: "x".repeat(49), domain: "example.com", forwardTo: "me@mail.example" })).status).toBe(201)
  })

  test("xrea-gateway/AC-3: 既存のアドレスと同じ組は409で、作成の呼び出しが行われない", async () => {
    const { post, xrea } = setup()
    const res = await post({ name: "SHOP", domain: "example.com", forwardTo: "me@mail.example" })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("conflict")
    expect(xrea.calls).not.toContain("create")
  })

  test("ランダムな名前が既存と衝突したときは再生成し、5回続けて衝突したら409にする", async () => {
    const taken = [...sampleMails(), mail(99, "a.a10", "example.com", 1)]
    const same = setup(taken, { words: ["a"], rnd: () => 0 })
    expect((await same.post({ domain: "example.com", forwardTo: "me@mail.example" })).status).toBe(409)
    const seq = [0, 0, 0, 0.5, 0.5, 0.5]
    let i = 0
    const next = setup(taken, { words: ["a", "b"], rnd: () => seq[i++] ?? 0 })
    const res = await next.post({ domain: "example.com", forwardTo: "me@mail.example" })
    expect((await res.json()).alias.name).toBe("b.b55")
  })

  test("不正なJSONの本文は 400 validation_error になる", async () => {
    const { app } = setup()
    const res = await app.request("/v1/aliases", { method: "POST", headers: JSON_H, body: "{" })
    expect(res.status).toBe(400)
  })
})

describe("削除・転送先の変更", () => {
  test("xrea-gateway/AC-4: 直前の一覧から解決した番号が削除に渡され、転送のみ以外は403、存在しないものは404", async () => {
    const { xrea, del, app } = setup()
    await app.request("/v1/aliases", { headers: H }) // キャッシュを作る
    xrea.mails = xrea.mails.map(m => (m.address_name === "bank" ? { ...m, no: 4 } : m.no === 4 ? { ...m, no: 5 } : m))
    expect((await del("bank@example.org")).status).toBe(204)
    expect(xrea.deleted).toEqual([[4]])
    expect(xrea.calls.slice(-2)).toEqual(["list", "delete"])
    for (const a of ["mail@example.com", "mail@example.net"]) expect((await del(a)).status).toBe(403)
    expect((await del("none@example.com")).status).toBe(404)
    expect(xrea.deleted).toHaveLength(1)
  })

  test("xrea-gateway/AC-5: 解決したアドレスと新しい転送先が渡され、受信のみは両方になり、転送のみと両方は受信方法を保ち、存在しないものは404、形式不正は400", async () => {
    const { xrea, patch, app } = setup()
    await app.request("/v1/aliases", { headers: H })
    const res = await patch("SNS@example.net", { forwardTo: " new@mail.example " })
    expect(res.status).toBe(200)
    expect((await res.json()).alias).toEqual({ address: "sns@example.net", name: "sns", domain: "example.net", forwardTo: "new@mail.example", mailbox: false })
    expect(xrea.changed).toEqual([{ no: 3, forwardTo: "new@mail.example", popHow: 1 }])
    const after = (await (await app.request("/v1/aliases", { headers: H })).json()).aliases
    expect(after.find((a: any) => a.address === "sns@example.net").forwardTo).toBe("new@mail.example")
    // 受信のみは転送の追加で両方になり、両方は受信方法を保つ
    const added = await patch("mail@example.com", { forwardTo: "add@mail.example" })
    expect([added.status, (await added.json()).alias]).toEqual([200, { address: "mail@example.com", name: "mail", domain: "example.com", forwardTo: "add@mail.example", mailbox: true }])
    expect(xrea.changed.at(-1)).toEqual({ no: 1, forwardTo: "add@mail.example", popHow: 3 })
    expect((await patch("mail@example.net", { forwardTo: "n@mail.example" })).status).toBe(200)
    expect(xrea.changed.at(-1)).toMatchObject({ no: 4, popHow: 3 })
    expect((await patch("none@example.com", { forwardTo: "n@mail.example" })).status).toBe(404)
    const n = xrea.changed.length
    for (const forwardTo of ["not-mail", "", "a b@c.d"]) expect((await patch("shop@example.com", { forwardTo })).status).toBe(400)
    expect((await patch("shop@example.com", {})).status).toBe(400)
    expect(xrea.changed).toHaveLength(n)
  })

  test("xrea-gateway/AC-16: 転送の解除で両方のアドレスが受信のみになって転送先が空で返り、転送のみと受信のみは403、存在しないものは404", async () => {
    const { xrea, app } = setup()
    const rm = (a: string) => app.request(`/v1/aliases/${encodeURIComponent(a)}/forward`, { method: "DELETE", headers: H })
    const ok = await rm("MAIL@example.net")
    expect([ok.status, (await ok.json()).alias]).toEqual([200, { address: "mail@example.net", name: "mail", domain: "example.net", forwardTo: "", mailbox: true }])
    expect(xrea.removed).toEqual([4])
    expect(xrea.mails.find(m => m.no === 4)).toMatchObject({ pop_how: 2, address_trans: "" })
    for (const a of ["shop@example.com", "mail@example.com", "mail@example.net"]) expect((await rm(a)).status, a).toBe(403)
    expect((await rm("none@example.com")).status).toBe(404)
    expect(xrea.removed).toEqual([4])
    // 解除後の一覧では、転送先が空のメールボックスになる
    const list = (await (await app.request("/v1/aliases", { headers: H })).json()).aliases
    expect(list.find((a: any) => a.address === "mail@example.net")).toMatchObject({ forwardTo: "", mailbox: true })
  })

  test("xrea-gateway/AC-13: XREAの応答を1.2秒遅らせても、発行・転送先の変更・削除の応答が5秒以内に返る", async () => {
    const { xrea, post, patch, del } = setup()
    xrea.delayMs = 1200
    for (const run of [
      async () => (await post({ name: "slow", domain: "example.com", forwardTo: "me@mail.example" })).status,
      async () => (await patch("slow@example.com", { forwardTo: "new@mail.example" })).status,
      async () => (await del("slow@example.com")).status,
    ]) {
      const start = performance.now()
      expect([200, 201, 204]).toContain(await run())
      expect(performance.now() - start).toBeLessThan(5000)
    }
  }, 30_000)
})
