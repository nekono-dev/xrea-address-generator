// 実際のXREA APIに対する、ゲートウェイ経由の発行・転送先の変更・削除。XREA_LIVE=1 のときだけ実行する。
// 作成するのは poc で始まる名前だけで、作成したアドレスは必ず削除する。
import { describe, expect, test } from "vitest"
import { createGatewayApp } from "../../src/gateway/app"
import { Registry } from "../../src/gateway/registry"
import { silentLogger } from "../../src/shared/logger"
import { loadXreaConfig, XreaClient } from "../../src/xrea/client"

const domain = process.env.XREA_POC_DOMAIN ?? ""
const forwardTo = process.env.XREA_POC_FORWARD_TO ?? ""
const TOKEN = "t".repeat(32)

describe.runIf(process.env.XREA_LIVE === "1")("実際のAPIに対する発行と削除", () => {
  test("xrea-gateway/AC-4: 発行し、転送先を変更して削除すると、検証用アドレスが残らない", async () => {
    await new Promise(r => setTimeout(r, 1500)) // 直前に実行した別のテストの送信から間隔を空ける
    const cfg = loadXreaConfig()
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-xrea-account": cfg.account, "x-xrea-server": cfg.serverName, "x-xrea-secret": cfg.apiSecretKey }
    const app = createGatewayApp({ registry: new Registry(), internalToken: TOKEN, logger: silentLogger, words: ["poc"] })
    const direct = new XreaClient(cfg)
    const before = (await direct.mailList()).length
    const made: string[] = []
    const call = (method: string, path: string, body?: object) => app.request(path, { method, headers, body: body && JSON.stringify(body) })
    try {
      const named = (await (await call("POST", "/v1/aliases", { name: `poc-${Date.now().toString(36)}`, domain, forwardTo })).json()).alias
      made.push(named.address)
      const random = (await (await call("POST", "/v1/aliases", { domain, forwardTo })).json()).alias
      made.push(random.address)
      expect(random.name).toMatch(/^poc\.poc[1-9]\d$/)
      const { aliases } = await (await call("GET", "/v1/aliases")).json()
      for (const a of made) expect(aliases.map((x: any) => x.address)).toContain(a)
      const forwardTo2 = forwardTo.replace("@", "+poctest@")
      const changed = await call("PATCH", `/v1/aliases/${encodeURIComponent(named.address)}`, { forwardTo: forwardTo2 })
      expect((await changed.json()).alias.forwardTo).toBe(forwardTo2)
      expect((await call("POST", "/v1/aliases", { name: named.name, domain, forwardTo })).status).toBe(409)
    } finally {
      for (const a of made) await call("DELETE", `/v1/aliases/${encodeURIComponent(a)}`)
    }
    const after = await direct.mailList()
    expect(after.some(m => m.address_name.startsWith("poc"))).toBe(false)
    expect(after.length).toBe(before)
  }, 90_000)
})
