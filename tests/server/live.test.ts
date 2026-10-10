// 実際のXREA APIに対する発行・転送先の変更・削除。XREA_LIVE=1 のときだけ実行する。
// 作成するのは poc で始まる名前だけで、作成したアドレスは名前を指定して必ず削除する。
import { describe, expect, test } from "vitest"
import { AliasService } from "../../src/server/aliasService"
import { loadXreaConfig, XreaClient } from "../../src/xrea/client"
import { FakeProton } from "./fakes"

const domain = process.env.XREA_POC_DOMAIN ?? ""
const forwardTo = process.env.XREA_POC_FORWARD_TO ?? ""

describe.runIf(process.env.XREA_LIVE === "1")("実際のAPIに対する発行と削除", () => {
  test("指定した名前とランダムな名前で発行し、転送先を変更して削除すると検証用アドレスが残らない", async () => {
    await new Promise(r => setTimeout(r, 1500)) // 直前に実行した別のテストの送信から間隔を空ける
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
      // 転送先の変更
      const forwardTo2 = forwardTo.replace("@", "+poctest@")
      expect((await service.changeForward(named.address, forwardTo2)).forwardTo).toBe(forwardTo2)
      expect((await service.listAliases()).aliases.find(x => x.address === named.address)!.forwardTo).toBe(forwardTo2)
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
