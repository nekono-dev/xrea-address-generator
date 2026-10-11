import http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, test } from "vitest"
import { checkReader, probe } from "../../scripts/cloud/check"

const ok = { maxInstances: 1, https: true, hasInternalToken: true }
const servers: http.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})
async function listen(handler: http.RequestListener): Promise<string> {
  const s = http.createServer(handler)
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r))
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`
}
/** 共有シークレットの検査つきの偽の内部サービス */
const internal =
  (healthy = true): http.RequestListener =>
  (req, res) => {
    const path = req.url ?? ""
    if (path === "/health")
      return void res.writeHead(healthy ? 200 : 503).end("{}")
    res.writeHead(401).end("{}") // 共有シークレットなし
  }
/** 偽のアプリ。誤った認証情報の登録の結果を、指定の状態で返す */
const app =
  (
    status: number,
    code = "invalid_credentials",
    cookie = false,
  ): http.RequestListener =>
  (req, res) => {
    if (req.url === "/healthz") return void res.writeHead(200).end("{}")
    res
      .writeHead(status, {
        "content-type": "application/json",
        ...(cookie ? { "set-cookie": "xag_session=x" } : {}),
      })
      .end(JSON.stringify({ error: { code } }))
  }

describe("コンテナ基盤の要件", () => {
  test("cloud-deploy/AC-3: 最大インスタンス数が2以上、またはHTTPで公開されている構成を失敗にする", () => {
    expect(checkReader(ok)).toEqual([])
    expect(checkReader({ ...ok, maxInstances: 2 })).toHaveLength(1)
    expect(checkReader({ ...ok, maxInstances: 0 })).toHaveLength(1)
    expect(checkReader({ ...ok, https: false })[0]).toContain("HTTPS")
    expect(checkReader({ ...ok, hasInternalToken: false })[0]).toContain("INTERNAL_TOKEN")
    expect(checkReader({ maxInstances: 3, https: false, hasInternalToken: false })).toHaveLength(3)
  })
})

describe("疎通確認", () => {
  test("アプリの前段が転送（Cloudflare Access のログインなど）を返すと、成功と誤判定せず失敗にする", async () => {
    const login = await listen((_req, res) => void res.writeHead(302, { location: "/login" }).end())
    const results = await probe({ app: login })
    expect(results.filter((r) => !r.ok).map((r) => r.name)).toEqual([
      "Workers の死活確認",
      "XREAへの到達（誤った認証情報の登録が400になる）",
    ])
    expect(results[0]!.detail).toContain("転送")
  })

  test("cloud-deploy/AC-6: Workersの死活確認と、偽の認証情報がXREAに拒否されたこと、読み取りサービスの死活確認と共有シークレットの一致を報告する", async () => {
    const rd = await listen(internal())
    const a = await listen(app(400))
    const results = await probe({ app: a, reader: rd })
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true])
    expect(results.map((r) => r.name).join("\n")).toContain("XREAへの到達")
    // 読み取りサービスを配備しない構成では、その検査を行わない
    expect((await probe({ app: a })).length).toBe(2)
  })

  test("cloud-deploy/AC-6: XREAへ到達できない（502）・読み取りサービスの死活確認の失敗・cookieの発行は失敗として報告される", async () => {
    const unreachable502 = await probe({ app: await listen(app(502, "upstream_error")) })
    expect(unreachable502.filter((r) => !r.ok).map((r) => r.name)).toEqual([expect.stringContaining("XREAへの到達")])
    const down = await probe({ app: await listen(app(400)), reader: await listen(internal(false)) })
    expect(down.filter((r) => !r.ok).map((r) => r.name)).toEqual(["読み取りサービスの死活確認"])
    const cookie = await probe({ app: await listen(app(400, "invalid_credentials", true)) })
    expect(cookie.some((r) => !r.ok)).toBe(true)
    const unreachable = await probe({ app: "http://127.0.0.1:1", reader: "http://127.0.0.1:1" })
    expect(unreachable.every((r) => !r.ok)).toBe(true)
  })

  test("cloud-deploy/AC-11: 疎通確認が60秒以内に完了し、締め切りを超えたときは打ち切られる", async () => {
    const a = await listen(app(400))
    const start = performance.now()
    await probe({ app: a, reader: await listen(internal()) })
    expect(performance.now() - start).toBeLessThan(60_000)
    // 応答しない相手でも、締め切りで打ち切る
    const hang = await listen(() => undefined)
    const t0 = performance.now()
    const r = await probe({ app: hang }, { deadlineMs: 300 })
    expect(performance.now() - t0).toBeLessThan(3000)
    expect(r.every((x) => !x.ok)).toBe(true)
    expect(r[0]!.detail).toContain("60秒")
  })
})
