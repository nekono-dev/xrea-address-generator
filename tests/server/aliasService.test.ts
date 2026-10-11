import { describe, expect, test } from "vitest"
import { AliasService, AppError } from "../../src/server/aliasService"
import { createApp } from "../../src/server/app"
import { randomName } from "../../src/server/randomName"
import { WORDS } from "../../src/server/words"
import { FakeProton, FakeXrea, mail, sampleMails } from "./fakes"

const silent = { info: () => undefined, warn: () => undefined, error: () => undefined }
const entries = new Map([
  ["shop@example.com", ["Amazon.co.jp"]],
  ["sns@example.net", ["Bluesky", "X (Twitter)"]],
])
function setup(opts: { proton?: FakeProton; rnd?: () => number } = {}) {
  const xrea = new FakeXrea(sampleMails())
  const proton = opts.proton ?? new FakeProton(entries)
  const service = new AliasService({ xrea, proton, rnd: opts.rnd })
  return { xrea, proton, service }
}

describe("一覧・候補・照合状態", () => {
  test("alias-service/AC-1: 転送のみ・受信のみ・両方・破棄のアドレスを含む一覧から、破棄を除くアドレスが返り、メールボックスを持つものに印が付く", async () => {
    const service = new AliasService({ xrea: new FakeXrea([...sampleMails(), mail(6, "gone", "example.org", 4)]), proton: new FakeProton(entries) })
    const { aliases } = await service.listAliases()
    expect(aliases.map(a => [a.address, a.mailbox])).toEqual([
      ["bank@example.org", false],
      ["mail@example.com", true],
      ["mail@example.net", true],
      ["shop@example.com", false],
      ["sns@example.net", false],
    ])
    expect(aliases.find(a => a.address === "mail@example.net")!.forwardTo).toBe("me@mail.example")
  })

  test("alias-service/AC-2: エントリ名を持つアドレスの一覧の項目に、そのエントリ名が昇順で含まれる", async () => {
    const { service } = setup()
    const { aliases } = await service.listAliases()
    expect(aliases.find(a => a.address === "sns@example.net")).toEqual({
      address: "sns@example.net",
      name: "sns",
      domain: "example.net",
      forwardTo: "sub@mail.example",
      protonEntries: ["Bluesky", "X (Twitter)"],
      mailbox: false,
    })
    expect(aliases.find(a => a.address === "bank@example.org")!.protonEntries).toEqual([])
  })

  test("alias-service/AC-3: Proton Passの取得が完了していない状態でも一覧が返り、照合の状態が取得中になる", async () => {
    const loading = new FakeProton(new Map(), { state: "loading", updatedAt: null, reloginAt: null, itemCount: null, error: null })
    const { service } = setup({ proton: loading })
    const r = await service.listAliases()
    expect(r.aliases).toHaveLength(5)
    expect(r.proton.state).toBe("loading")
  })

  test("alias-service/AC-10: 複数のアドレスから、ドメインと転送先がそれぞれ重複なく昇順で返る", async () => {
    const { service } = setup()
    expect(await service.options()).toEqual({
      domains: ["example.com", "example.net", "example.org"],
      forwardTargets: ["me@mail.example", "sub@mail.example"],
    })
  })

  test("alias-service/AC-11: 再取得の要求が受け付けられ、照合状態が取得中に変わる", async () => {
    const { service, proton } = setup()
    const app = createApp({ service, logger: silent })
    const res = await app.request("/api/proton/refresh", { method: "POST" })
    expect(res.status).toBe(202)
    expect(proton.refreshed).toBe(1)
    expect((await (await app.request("/api/proton/status")).json()).state).toBe("loading")
  })
})

describe("発行", () => {
  test("alias-service/AC-4: 発行の要求で、転送のみ・指定のドメイン・指定の転送先のアドレスが作成される", async () => {
    const { service, xrea } = setup()
    const alias = await service.createAlias({ name: "Travel", domain: "example.net", forwardTo: "sub@mail.example" })
    expect(xrea.created).toEqual([{ name: "travel", domain: "example.net", forwardTo: "sub@mail.example" }])
    expect(alias).toEqual({ address: "travel@example.net", name: "travel", domain: "example.net", forwardTo: "sub@mail.example", protonEntries: [], mailbox: false })
    expect(xrea.mails.find(m => m.address_name === "travel")!.pop_how).toBe(1)
  })

  test("alias-service/AC-5: 名前が空の発行要求で、単語2つのピリオド区切りに数字2桁を直結した名前が作成される", async () => {
    const { service, xrea } = setup()
    for (const name of [undefined, "", "  "]) await service.createAlias({ name, domain: "example.com", forwardTo: "me@mail.example" })
    expect(xrea.created).toHaveLength(3)
    for (const c of xrea.created) {
      expect(c.name).toMatch(/^[a-z]+\.[a-z]+[1-9]\d$/)
      const [w1, rest] = c.name.split(".")
      expect(WORDS).toContain(w1)
      expect(WORDS).toContain(rest!.replace(/\d+$/, ""))
    }
    expect(randomName(["quiet", "river"], (() => { const v = [0, 0.9, 0.355]; let i = 0; return () => v[i++]! })())).toBe("quiet.river41")
  })

  test("alias-service/AC-6: 空白を含む名前、候補にないドメイン、形式不正の転送先のそれぞれで400が返り、作成されない", async () => {
    const { service, xrea } = setup()
    const app = createApp({ service, logger: silent })
    const post = (b: object) => app.request("/api/aliases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })
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
    // 49文字は受理される（XREAの上限）
    expect((await post({ name: "x".repeat(49), domain: "example.com", forwardTo: "me@mail.example" })).status).toBe(201)
  })

  test("alias-service/AC-7: 一覧に存在する名前とドメインの組での発行要求が409になり、作成の呼び出しが行われない", async () => {
    const { service, xrea } = setup()
    const app = createApp({ service, logger: silent })
    const res = await app.request("/api/aliases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "SHOP", domain: "example.com", forwardTo: "me@mail.example" }) })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe("conflict")
    expect(xrea.calls).not.toContain("create")
  })

  test("ランダムな名前が既存と衝突したときは再生成し、5回続けて衝突したら409にする", async () => {
    const { service, xrea } = setup()
    xrea.mails.push({ ...xrea.mails[1]!, no: 99, address_name: "a.a10", address_domain: "example.com" })
    const fixedRnd = () => 0 // 常に a.a10
    const s = new AliasService({ xrea, proton: new FakeProton(), words: ["a"], rnd: fixedRnd })
    await expect(s.createAlias({ domain: "example.com", forwardTo: "me@mail.example" })).rejects.toMatchObject({ code: "conflict" })
    const seq = [0, 0, 0, 0.5, 0.5, 0.5]
    let i = 0
    const s2 = new AliasService({ xrea, proton: new FakeProton(), words: ["a", "b"], rnd: () => seq[i++] ?? 0 })
    expect((await s2.createAlias({ domain: "example.com", forwardTo: "me@mail.example" })).name).toBe("b.b55")
  })
})

describe("削除", () => {
  test("alias-service/AC-8: 削除の要求で、直前の一覧から解決した番号が削除の呼び出しに渡される", async () => {
    const { service, xrea } = setup()
    await service.listAliases()
    // 一覧の取得後に番号が振り直された状況を作る（他の削除で no がずれる）
    xrea.mails = xrea.mails.map(m => (m.address_name === "bank" ? { ...m, no: 4 } : m.no === 4 ? { ...m, no: 5 } : m))
    const app = createApp({ service, logger: silent })
    const res = await app.request(`/api/aliases/${encodeURIComponent("bank@example.org")}`, { method: "DELETE" })
    expect(res.status).toBe(204)
    expect(xrea.deleted).toEqual([[4]])
    expect(xrea.calls.slice(-2)).toEqual(["list", "delete"])
  })

  test("alias-service/AC-9: 受信方法が転送のみでないアドレスの削除要求が403になり、削除の呼び出しが行われない", async () => {
    const { service, xrea } = setup()
    const app = createApp({ service, logger: silent })
    for (const address of ["mail@example.com", "mail@example.net"]) {
      const res = await app.request(`/api/aliases/${encodeURIComponent(address)}`, { method: "DELETE" })
      expect(res.status).toBe(403)
    }
    expect(xrea.calls).not.toContain("delete")
    expect((await app.request("/api/aliases/none%40example.com", { method: "DELETE" })).status).toBe(404)
  })
})

describe("転送先の変更", () => {
  const patch = (app: ReturnType<typeof createApp>, address: string, body: unknown) =>
    app.request(`/api/aliases/${encodeURIComponent(address)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

  test("alias-service/AC-18: 転送先の変更の要求で、一覧から解決したアドレスと新しい転送先が変更の呼び出しに渡され、新しい転送先を持つ項目が返る", async () => {
    const { service, xrea } = setup()
    const app = createApp({ service, logger: silent })
    await service.listAliases() // キャッシュを作る
    const res = await patch(app, "SNS@example.net", { forwardTo: " new@mail.example " })
    expect(res.status).toBe(200)
    expect((await res.json()).alias).toEqual({ address: "sns@example.net", name: "sns", domain: "example.net", forwardTo: "new@mail.example", protonEntries: ["Bluesky", "X (Twitter)"], mailbox: false })
    expect(xrea.changed).toEqual([{ no: 3, forwardTo: "new@mail.example" }])
    // 変更の成功時にキャッシュを破棄する
    const after = (await service.listAliases()).aliases.find(a => a.address === "sns@example.net")
    expect(after?.forwardTo).toBe("new@mail.example")
  })

  test("alias-service/AC-19: 存在しないアドレスは404、転送のみでないアドレスは403、形式不正の転送先は400になり、変更の呼び出しが行われない", async () => {
    const { service, xrea } = setup()
    const app = createApp({ service, logger: silent })
    expect((await patch(app, "none@example.com", { forwardTo: "new@mail.example" })).status).toBe(404)
    expect((await patch(app, "mail@example.net", { forwardTo: "new@mail.example" })).status).toBe(403)
    expect((await patch(app, "mail@example.com", { forwardTo: "new@mail.example" })).status).toBe(403)
    for (const forwardTo of ["not-mail", "", "a b@c.d"]) {
      const res = await patch(app, "shop@example.com", { forwardTo })
      expect(res.status).toBe(400)
      expect((await res.json()).error.code).toBe("validation_error")
    }
    expect((await patch(app, "shop@example.com", {})).status).toBe(400)
    expect(xrea.calls).not.toContain("change")
    expect(xrea.changed).toEqual([])
  })
})

describe("秘匿情報と応答時間", () => {
  test("alias-service/AC-12: 一覧の応答とログに、パスワード項目の文字列が含まれない", async () => {
    const xrea = new FakeXrea(sampleMails().map(m => ({ ...m, pop_pass: "XREA-SECRET-PASSWORD" }) as never))
    const lines: string[] = []
    const logger = { info: (o: object) => lines.push(JSON.stringify(o)), warn: (o: object) => lines.push(JSON.stringify(o)), error: (o: object) => lines.push(JSON.stringify(o)) }
    const app = createApp({ service: new AliasService({ xrea, proton: new FakeProton() }), logger })
    const body = await (await app.request("/api/aliases")).text()
    expect(body).not.toContain("XREA-SECRET-PASSWORD")
    expect(body).not.toContain("pop_pass")
    expect(lines.join("\n")).not.toContain("XREA-SECRET-PASSWORD")
    expect(lines.join("\n")).not.toContain("shop@example.com")
  })

  test("alias-service/AC-15: XREAの応答を1.2秒遅らせた状態で、発行・転送先の変更・削除の応答が5秒以内に返る", async () => {
    const { service, xrea } = setup()
    xrea.delayMs = 1200
    const app = createApp({ service, logger: silent })
    let start = performance.now()
    const created = await app.request("/api/aliases", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "slow", domain: "example.com", forwardTo: "me@mail.example" }) })
    expect(created.status).toBe(201)
    expect(performance.now() - start).toBeLessThan(5000)
    start = performance.now()
    const changed = await app.request("/api/aliases/slow%40example.com", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ forwardTo: "new@mail.example" }) })
    expect(changed.status).toBe(200)
    expect(performance.now() - start).toBeLessThan(5000)
    start = performance.now()
    const deleted = await app.request("/api/aliases/slow%40example.com", { method: "DELETE" })
    expect(deleted.status).toBe(204)
    expect(performance.now() - start).toBeLessThan(5000)
  }, 20_000)

  test("AppError はコードとメッセージを持つ", () => {
    const e = new AppError("forbidden", "x")
    expect(e.code).toBe("forbidden")
  })
})
