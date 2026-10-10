// 実際のXREA APIに対する契約テスト。XREA_LIVE=1 のときだけ実行する（vitest.config.ts で除外している）。
// 作成・削除するのは名前が poc- で始まるアドレスだけ。reset_flg は常に 0。
import { afterAll, describe, expect, test } from "vitest"
import { loadXreaConfig, XreaClient } from "../../src/xrea/client"
import { XreaError } from "../../src/xrea/errors"

const env = process.env
const domain = env.XREA_POC_DOMAIN ?? ""
const forwardTo = env.XREA_POC_FORWARD_TO ?? ""
const client = new XreaClient(loadXreaConfig())

/** 直前に取得した一覧の番号で、poc- で始まるアドレスだけを削除する */
async function deleteByPrefix(prefix: string): Promise<void> {
  if (!prefix.startsWith("poc-")) throw new Error("poc- で始まる接頭辞以外は削除しない")
  for (;;) {
    const target = (await client.mailList()).find(m => m.address_name.startsWith(prefix))
    if (!target) return
    await client.mailDelete([target.no])
  }
}

describe.runIf(env.XREA_LIVE === "1")("実際のAPIに対する契約", () => {
  afterAll(async () => {
    await deleteByPrefix("poc-")
  })

  test("xrea-client/AC-9: 作成と削除の後に、検証用の接頭辞を持つアドレスが一覧に残らない", async () => {
    expect(domain).not.toBe("")
    expect(forwardTo).not.toBe("")
    const before = (await client.mailList()).length
    const name = `poc-${Date.now().toString(36)}`
    try {
      await client.mailCreate({ name, domain, forwardTo })
      const created = (await client.mailList()).find(m => m.address_name === name && m.address_domain === domain)
      expect(created).toBeDefined()
      expect(created!.pop_how).toBe(1)
      expect(created!.address_trans).toBe(forwardTo)
      expect(created).not.toHaveProperty("pop_pass")
      // 同名の作成は上書きされず、メッセージ付きのエラーになる
      const dup = await client.mailCreate({ name, domain, forwardTo }).catch(e => e)
      expect(dup).toBeInstanceOf(XreaError)
      expect((dup as XreaError).kind).toBe("api")
      expect((dup as XreaError).message).toContain("重複")
    } finally {
      await deleteByPrefix("poc-")
    }
    const after = await client.mailList()
    expect(after.some(m => m.address_name.startsWith("poc-"))).toBe(false)
    expect(after.length).toBe(before)
  }, 60_000)
})
