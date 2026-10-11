import { afterEach, describe, expect, test, vi } from "vitest"
import { dohResolver } from "../../src/gateway/dohResolver"
import { mxCheck } from "../../src/gateway/domainCheck"

const SERVER = "s1.xrea.com"
type Rec = { type: number; data: string }
const A = (data: string): Rec => ({ type: 1, data })
const MX = (data: string): Rec => ({ type: 15, data })

/** 名前と型ごとの答えを返す偽のDoH。無い組み合わせは「記録が無い」（Status 0 で Answer なし）にする */
function doh(table: Record<string, { status?: number; answer?: Rec[] } | "http500">) {
  const calls: string[] = []
  const f = (async (input: RequestInfo | URL) => {
    const u = new URL(String(input))
    const key = `${u.searchParams.get("type")} ${u.searchParams.get("name")}`
    calls.push(key)
    const hit = table[key]
    if (hit === "http500") return new Response("error", { status: 500 })
    return Response.json({ Status: hit?.status ?? 0, ...(hit?.answer ? { Answer: hit.answer } : {}) })
  }) as typeof fetch
  return { f, calls }
}

afterEach(() => vi.useRealTimers())

describe("DNS over HTTPS", () => {
  test("gateway-durable-object/AC-5: MXがXREAのサーバのIPを指すと作成され、指さないと400、記録が無い応答は400、照会の失敗は502になる", async () => {
    const base = { [`A ${SERVER}`]: { answer: [A("203.0.113.10")] } }
    // MX の向き先がサーバのIPと一致する（CNAME の Answer は読み飛ばす）
    const ok = doh({ ...base, "MX good.example": { answer: [MX("20 backup.good.example."), MX("10 mx.good.example.")] }, "A mx.good.example": { answer: [{ type: 5, data: "x." }, A("203.0.113.10")] } })
    await expect(mxCheck(dohResolver(ok.f))("good.example", SERVER)).resolves.toBeUndefined()
    expect(ok.calls).toContain("MX good.example")
    // MX が無いときはドメイン自身のIPで判定する
    const apex = doh({ ...base, "A apex.example": { answer: [A("203.0.113.10")] } })
    await expect(mxCheck(dohResolver(apex.f))("apex.example", SERVER)).resolves.toBeUndefined()
    // 向き先が違う → 400
    const other = doh({ ...base, "MX other.example": { answer: [MX("10 mx.other.example.")] }, "A mx.other.example": { answer: [A("198.51.100.1")] } })
    await expect(mxCheck(dohResolver(other.f))("other.example", SERVER)).rejects.toMatchObject({ code: "validation_error" })
    // NXDOMAIN と記録なし → 400
    const nx = doh({ ...base, "MX gone.example": { status: 3 }, "A gone.example": { status: 3 }, "AAAA gone.example": { status: 3 } })
    await expect(mxCheck(dohResolver(nx.f))("gone.example", SERVER)).rejects.toMatchObject({ code: "validation_error" })
    // 照会の失敗（HTTP 500・SERVFAIL）→ 502 network
    for (const t of [{ [`A ${SERVER}`]: "http500" as const }, { [`A ${SERVER}`]: { status: 2 } }]) {
      await expect(mxCheck(dohResolver(doh(t).f))("x.example", SERVER)).rejects.toMatchObject({ code: "upstream_error", kind: "network" })
    }
  })

  test("gateway-durable-object/AC-8: 応答しない照会が3秒で打ち切られ、MXの確認が5秒以内に失敗として終わる", async () => {
    vi.useFakeTimers()
    const never = (() => new Promise<Response>(() => {})) as typeof fetch
    const p = mxCheck(dohResolver(never))("x.example", SERVER).then(
      () => "ok",
      e => e,
    )
    await vi.advanceTimersByTimeAsync(2_999)
    let settled = false
    void p.then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toMatchObject({ code: "upstream_error", kind: "network" })
  })
})
