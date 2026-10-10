// 実際のXREA APIに対する発行と削除。XREA_LIVE=1 のときだけ実行する。
// 作成するのは poc で始まる名前だけで、作成したアドレスは名前を指定して必ず削除する。
import { describe, expect, test } from "vitest"
import { AliasService } from "../../src/server/aliasService"
import { loadXreaConfig, XreaClient } from "../../src/xrea/client"
import { FakeProton } from "./fakes"

const domain = process.env.XREA_POC_DOMAIN ?? ""
const forwardTo = process.env.XREA_POC_FORWARD_TO ?? ""

describe.runIf(process.env.XREA_LIVE === "1")("実際のAPIに対する発行と削除", () => {
  test("指定した名前とランダムな名前で発行し、削除すると検証用アドレスが残らない", async () => {
    const xrea = new XreaClient(loadXreaConfig())
    const service = new AliasService({ xrea, proton: new FakeProton(), words: ["poc"] })
    const before = (await xrea.mailList()).length
    const made: string[] = []
    try {
      const named = await service.createAlias({ name: `poc-${Date.now().toString(36)}`, domain, forwardTo })
      made.push(named.address)
      const random = await service.createAlias({ domain, forwardTo }) // 単語を poc に固定したランダム名（poc.poc10〜99）
      made.push(random.address)
      expect(random.name).toMatch(/^poc\.poc[1-9]\d$/)
      const { aliases } = await service.listAliases()
      for (const a of made) expect(aliases.map(x => x.address)).toContain(a)
      expect(aliases.find(x => x.address === named.address)!.forwardTo).toBe(forwardTo)
      // 同名の発行は 409 相当（作成の呼び出し前に拒否される）
      await expect(service.createAlias({ name: named.name, domain, forwardTo })).rejects.toMatchObject({ code: "conflict" })
    } finally {
      for (const a of made) await service.deleteAlias(a)
    }
    const after = await xrea.mailList()
    expect(after.some(m => m.address_name.startsWith("poc"))).toBe(false)
    expect(after.length).toBe(before)
  }, 90_000)
})
