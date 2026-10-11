import { describe, expect, test } from "vitest"
import { loadXreaConfig, XreaClient } from "../../src/xrea/client"
import { normalizeList, toResult, XreaError, type RawMailEntry } from "../../src/xrea/errors"
import { EndpointQueue } from "../../src/xrea/queue"

const entry = (no: number, name: string): RawMailEntry =>
  ({ no, address_name: name, address_domain: "example.com", address: `${name}@example.com`, pop_pass: `pw-${name}-SECRET`, pop_how: 1, address_trans: "me@example.com", quota: "0" }) as RawMailEntry

describe("エラー応答の変換", () => {
  test("xrea-client/AC-6: ステータスコード500の応答で、応答のメッセージを持つ例外が送出される", () => {
    const run = () => toResult({ status_code: 500, message: "shop@example.com:重複しています。" })
    expect(run).toThrow(XreaError)
    try {
      run()
    } catch (e) {
      expect((e as XreaError).message).toBe("shop@example.com:重複しています。")
      expect((e as XreaError).kind).toBe("api")
      expect((e as XreaError).statusCode).toBe(500)
    }
  })

  test("メッセージが空の500は、送信間隔の超過として扱う", () => {
    expect(() => toResult({ status_code: 500, message: "" })).toThrow(expect.objectContaining({ kind: "rate_limit" }))
    expect(() => toResult({ status_code: 500 })).toThrow(expect.objectContaining({ kind: "rate_limit" }))
  })

  test("認証の誤りは error_message で返り、送信間隔の超過ではなく api の例外になる", () => {
    expect(() => toResult({ status_code: 500, error_target: "server_name", error_message: "invalid" })).toThrow(expect.objectContaining({ kind: "api", message: "invalid" }))
  })

  test("ネットワーク障害は kind=network、解釈できない応答は kind=api の例外になる", async () => {
    const down = new XreaClient({ account: "a", serverName: "s", apiSecretKey: "k" }, { fetch: async () => Promise.reject(new TypeError("fetch failed")), queue: new EndpointQueue(0) })
    await expect(down.mailList()).rejects.toMatchObject({ kind: "network" })
    const html = new XreaClient({ account: "a", serverName: "s", apiSecretKey: "k" }, { fetch: async () => ({ status: 502, text: async () => "<html>" }), queue: new EndpointQueue(0) })
    await expect(html.mailList()).rejects.toMatchObject({ kind: "api", statusCode: 502 })
  })

  test("認証情報の環境変数が未設定なら、不足している変数名を示す", () => {
    expect(() => loadXreaConfig({ XREA_ACCOUNT: "a" })).toThrow("XREA_SERVER_NAME, XREA_API_SECRET_KEY")
  })
})

describe("一覧応答の正規化", () => {
  test("xrea-client/AC-7: パスワード項目を含む一覧応答から、パスワード項目を持たない配列が返る", async () => {
    const raw = { "2": entry(2, "b"), "1": entry(1, "a") }
    const list = normalizeList(raw)
    expect(list.map(m => m.no)).toEqual([1, 2])
    for (const m of list) expect(m).not.toHaveProperty("pop_pass")
    expect(JSON.stringify(list)).not.toContain("SECRET")
    // クライアント経由でも同じ
    const client = new XreaClient(
      { account: "a", serverName: "s", apiSecretKey: "k" },
      { fetch: async () => ({ status: 200, text: async () => JSON.stringify({ status_code: 200, result: raw }) }), queue: new EndpointQueue(0) },
    )
    const viaClient = await client.mailList()
    expect(JSON.stringify(viaClient)).not.toContain("SECRET")
  })
})
