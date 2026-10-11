import { describe, expect, test } from "vitest"
import { createGatewayApp } from "../../src/gateway/app"
import { Registry } from "../../src/gateway/registry"
import { randomName } from "../../src/gateway/randomName"
import { WORDS } from "../../src/gateway/words"
import { AppError } from "../../src/shared/errors"
import { mxCheck, type DomainCheck, type Resolver } from "../../src/gateway/domainCheck"
import { silentLogger } from "../../src/shared/logger"
import { FakeXrea, mail, sampleMails } from "./fakes"

const H = { "x-xrea-account": "acct", "x-xrea-server": "s1.xrea.com", "x-xrea-secret": "SECRET" }
const JSON_H = { ...H, "content-type": "application/json" }

function setup(mails = sampleMails(), opts: { rnd?: () => number; words?: readonly string[]; domainCheck?: DomainCheck } = {}) {
  const xrea = new FakeXrea(mails)
  const registry = new Registry(100, 600_000, Date.now, () => xrea)
  const app = createGatewayApp({ registry, logger: silentLogger, domainCheck: async () => { throw new AppError("validation_error", "テストではMXを確認しません") }, ...opts })
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

  test("xrea-gateway/AC-3: 空白を含む名前・形式不正のドメイン・形式不正の転送先は400で、作成されない", async () => {
    const { post, xrea } = setup()
    for (const body of [
      { name: "has space", domain: "example.com", forwardTo: "me@mail.example" },
      { name: "ok", domain: "not a domain", forwardTo: "me@mail.example" },
      { name: "ok", domain: "localhost", forwardTo: "me@mail.example" },
      { name: "ok", domain: "-bad-.example", forwardTo: "me@mail.example" },
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

  test("xrea-gateway/AC-17: 候補にないドメインは、確認を通ったときだけ作成され、確認はXREAのサーバ名で行われ、候補にあるドメインでは行われない", async () => {
    const checked: string[] = []
    const domainCheck: DomainCheck = async (domain, server) => {
      checked.push(`${domain}@${server}`)
      if (domain === "denied.example") throw new AppError("validation_error", "MXが指していません")
    }
    const { post, xrea } = setup(sampleMails(), { domainCheck })
    expect((await post({ name: "a", domain: "example.com", forwardTo: "me@mail.example" })).status).toBe(201)
    expect(checked).toEqual([])
    const ok = await post({ name: "b", domain: "New.Example", forwardTo: "me@mail.example" })
    expect(ok.status).toBe(201)
    expect((await ok.json()).alias.address).toBe("b@new.example")
    expect(checked).toEqual(["new.example@s1.xrea.com"])
    const ng = await post({ name: "c", domain: "denied.example", forwardTo: "me@mail.example" })
    expect(ng.status).toBe(400)
    expect(xrea.created.map(c => c.domain)).toEqual(["example.com", "new.example"])
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

describe("候補にないドメインのMXの確認", () => {
  const SERVER = "m1.xrea.test"
  const records: Record<string, { mx?: { exchange: string; priority: number }[]; a?: string[]; aaaa?: string[] }> = {
    [SERVER]: { a: ["192.0.2.10"] },
    "ok.example": { mx: [{ exchange: "mail.ok.example", priority: 10 }] },
    "mail.ok.example": { a: ["192.0.2.10"] },
    "other.example": { mx: [{ exchange: "mx.other.example", priority: 10 }] },
    "mx.other.example": { a: ["198.51.100.1"] },
    "nomx.example": { a: ["192.0.2.10"] },
    "v6.example": { mx: [{ exchange: "v6mx.example", priority: 10 }] },
    "v6mx.example": { aaaa: ["2001:db8::1"] },
    [SERVER + "6"]: { aaaa: ["2001:db8::1"] },
  }
  const err = (code: string) => Object.assign(new Error(code), { code })
  const resolver: Resolver = {
    resolveMx: async n => records[n]?.mx ?? Promise.reject(err("ENODATA")),
    resolve4: async n => records[n]?.a ?? Promise.reject(err(records[n] ? "ENODATA" : "ENOTFOUND")),
    resolve6: async n => records[n]?.aaaa ?? Promise.reject(err(records[n] ? "ENODATA" : "ENOTFOUND")),
  }
  const check = mxCheck(resolver)

  test("xrea-gateway/AC-17: MXの向き先がXREAのサーバのIPと一致すると通り、MXが無いときはドメイン自身のアドレスで判定する", async () => {
    await expect(check("ok.example", SERVER)).resolves.toBeUndefined()
    await expect(check("nomx.example", SERVER)).resolves.toBeUndefined()
  })

  test("xrea-gateway/AC-3: MXが他のサーバを指すとき、存在しないドメインのとき、400になる", async () => {
    for (const d of ["other.example", "missing.example"]) {
      await expect(check(d, SERVER)).rejects.toMatchObject({ code: "validation_error" })
    }
  })

  test("xrea-gateway/AC-17: IPv6の一致も通り、DNSの失敗は400ではなく502になる", async () => {
    await expect(mxCheck(resolver)("v6.example", SERVER + "6")).resolves.toBeUndefined()
    const down: Resolver = { ...resolver, resolveMx: async () => Promise.reject(err("ETIMEOUT")) }
    await expect(mxCheck(down)("ok.example", SERVER)).rejects.toMatchObject({ code: "upstream_error", kind: "network" })
  })
})
