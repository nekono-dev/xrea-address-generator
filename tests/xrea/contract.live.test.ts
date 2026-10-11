// 実際のXREA APIに対する契約テスト。XREA_LIVE=1 のときだけ実行する（vitest.config.ts で除外している）。
// 作成・削除するのは名前が poc- で始まるアドレスだけ。reset_flg は常に 0。
import crypto from "node:crypto"
import { afterAll, describe, expect, test } from "vitest"
import { BASE_URL, createParam, loadXreaConfig, XreaClient } from "../../src/xrea/client"
import { XreaError, type RawMailEntry } from "../../src/xrea/errors"
import { toFormBody } from "../../src/xrea/form"

const env = process.env
const domain = env.XREA_POC_DOMAIN ?? ""
const forwardTo = env.XREA_POC_FORWARD_TO ?? ""
const config = loadXreaConfig()
const client = new XreaClient(config)
const wait = (ms: number) => new Promise(r => setTimeout(r, ms))
const sha = (s: unknown) => crypto.createHash("sha256").update(String(s)).digest("hex")

/** パスワードの比較のために、クライアントを通さずに一覧を取得する（値はハッシュにしてから比べる） */
async function rawEntry(name: string): Promise<RawMailEntry | undefined> {
  await wait(1200)
  const body = toFormBody({ account: config.account, server_name: config.serverName, api_secret_key: config.apiSecretKey })
  const json = (await (await fetch(`${BASE_URL}/v1/mail/list`, { method: "POST", body })).json()) as { result?: Record<string, RawMailEntry> }
  await wait(1200) // クライアントの送信間隔の管理の外で送ったため、次の送信まで間隔を空ける
  return Object.values(json.result ?? {}).find(m => m.address_name === name && m.address_domain === domain)
}

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

  test("xrea-client/AC-14: 自動返信とフィルタを設定したアドレスで転送先を変更しても、転送先以外の全項目とパスワードが変わらない", async () => {
    const name = `poc-fwd-${Date.now().toString(36)}`
    const forwardTo2 = forwardTo.replace("@", "+poctest@")
    const customd_body = [
      { action_type: "change_subject", action_body: "[poc]", allow_stringcase: 1 as const, save_mail: 0 as const, conditions: [{ target: "subject", condition: "match", body: "poctest" }, { target: "from", condition: "notmatch", body: "x@example.com" }] },
      { action_type: "forward", action_body: forwardTo2, allow_stringcase: 0 as const, save_mail: 1 as const, conditions: [{ target: "japanese", condition: "none" }] },
    ]
    try {
      await client.mailEdit({
        reset_flg: 0,
        param: [{ ...createParam({ name, domain, forwardTo }), autorespond: 1, autorespond_body: "poc 自動返信\n2行目", clamd: 1, spamd: 1, customd: 1, customd_body }],
      })
      const before = await rawEntry(name)
      expect(before).toBeDefined()
      expect(Object.keys(before!.customd_body as object)).toHaveLength(2)
      await client.mailChangeForward(`${name}@${domain}`, forwardTo2, e => {
        if (!e) throw new Error("作成したアドレスが見つからない")
      })
      const after = await rawEntry(name)
      expect(after!.address_trans).toBe(forwardTo2)
      const { address_trans: _a, pop_pass: p1, ...restBefore } = before!
      const { address_trans: _b, pop_pass: p2, ...restAfter } = after!
      expect(restAfter).toEqual(restBefore)
      expect(sha(p2)).toBe(sha(p1))
    } finally {
      await deleteByPrefix("poc-")
    }
    expect((await client.mailList()).some(m => m.address_name.startsWith("poc-"))).toBe(false)
  }, 90_000)

  test("xrea-client/AC-15: 受信のみの検証用メールボックスに転送を追加・解除しても、パスワードと受信方法・転送先以外の全項目が変わらない", async () => {
    const name = `poc-mbx-${Date.now().toString(36)}`
    const mailboxParam = { ...createParam({ name, domain, forwardTo }), pop_how: 2 as const, address_trans: "", pop_pass: "Poc-Pass-12345", pop_pass_rand: 0 as const, quota: 10, clamd: 1 as const }
    const strip = (m: RawMailEntry) => {
      const { address_trans, pop_how, ...rest } = m as RawMailEntry & Record<string, unknown>
      return { rest, address_trans, pop_how }
    }
    try {
      await client.mailEdit({ reset_flg: 0, param: [mailboxParam] })
      const base = await rawEntry(name)
      expect(base).toMatchObject({ pop_how: 2, address_trans: "" })
      const ok = (e: unknown) => {
        if (!e) throw new Error("作成したアドレスが見つからない")
      }
      await client.mailChangeForward(`${name}@${domain}`, forwardTo, ok)
      const added = await rawEntry(name)
      expect(strip(added!)).toMatchObject({ pop_how: 3, address_trans: forwardTo })
      expect(strip(added!).rest).toEqual(strip(base!).rest)
      expect(sha(added!.pop_pass)).toBe(sha(base!.pop_pass))
      await client.mailChangeForward(`${name}@${domain}`, forwardTo.replace("@", "+poctest@"), ok)
      expect(strip((await rawEntry(name))!)).toMatchObject({ pop_how: 3 })
      await client.mailRemoveForward(`${name}@${domain}`, ok)
      const removed = await rawEntry(name)
      expect(strip(removed!)).toMatchObject({ pop_how: 2, address_trans: "" })
      expect(strip(removed!).rest).toEqual(strip(base!).rest)
      expect(sha(removed!.pop_pass)).toBe(sha(base!.pop_pass))
    } finally {
      await deleteByPrefix("poc-")
    }
    expect((await client.mailList()).some(m => m.address_name.startsWith("poc-"))).toBe(false)
  }, 120_000)
})
