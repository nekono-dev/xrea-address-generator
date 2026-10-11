// 実際のXREA APIに対する、Durable Object（GatewayTenant）経由の同時要求。XREA_LIVE=1 のときだけ実行する。
// 作成するのは poc で始まる名前だけで、作成したアドレスは必ず削除する。
import { describe, expect, test } from "vitest"
import { GatewayTenant } from "../../src/gateway/durableObject"
import { loadXreaConfig, XreaClient } from "../../src/xrea/client"

const domain = process.env.XREA_POC_DOMAIN ?? ""
const forwardTo = process.env.XREA_POC_FORWARD_TO ?? ""

describe.runIf(process.env.XREA_LIVE === "1")("実際のAPIに対する同時要求", () => {
  test("gateway-durable-object/AC-3: 一覧と発行を同時に送っても、レート制限の応答が出ず、検証用アドレスが残らない", async () => {
    await new Promise(r => setTimeout(r, 1500)) // 直前の別のテストの送信から間隔を空ける
    const cfg = loadXreaConfig()
    const headers = { "content-type": "application/json", "x-xrea-account": cfg.account, "x-xrea-server": cfg.serverName, "x-xrea-secret": cfg.apiSecretKey }
    const tenant = new GatewayTenant() // MX の確認も実物（DNS over HTTPS）
    const call = (method: string, path: string, body?: object) => tenant.fetch(new Request(`http://gateway.internal${path}`, { method, headers, body: body && JSON.stringify(body) }))
    const direct = new XreaClient(cfg)
    const before = (await direct.mailList()).length
    await new Promise(r => setTimeout(r, 1500)) // 別のクライアントとは送信間隔が共有されないため空ける
    const made: string[] = []
    try {
      const name = `poc-${Date.now().toString(36)}`
      // 一覧・候補・発行を一度に送る。同一エンドポイントへの要求は、Durable Object が 1.1 秒以上空けて送る
      const rs = await Promise.all([call("GET", "/v1/aliases"), call("GET", "/v1/options"), call("POST", "/v1/aliases", { name, domain, forwardTo }), call("GET", "/v1/aliases")])
      expect(rs.map(r => r.status)).toEqual([200, 200, 201, 200])
      made.push(`${name}@${domain}`)
      // 候補にないドメインは、MX を DNS over HTTPS で確認して拒否する（example.invalid はXREAを指さない）
      const refused = await call("POST", "/v1/aliases", { name: `${name}x`, domain: "example.invalid", forwardTo })
      expect(refused.status).toBe(400)
    } finally {
      for (const a of made) await call("DELETE", `/v1/aliases/${encodeURIComponent(a)}`)
    }
    await new Promise(r => setTimeout(r, 1500))
    const after = await direct.mailList()
    expect(after.some(m => m.address_name.startsWith("poc"))).toBe(false)
    expect(after.length).toBe(before)
  }, 120_000)
})
