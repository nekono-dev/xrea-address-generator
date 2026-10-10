import { describe, expect, test } from "vitest"
import { TIMEOUT_MS, XreaClient } from "../../src/xrea/client"
import { XreaError } from "../../src/xrea/errors"
import { EndpointQueue, MIN_GAP_MS } from "../../src/xrea/queue"

const config = { account: "acc", serverName: "s", apiSecretKey: "k" }

/** 送信時刻を記録する疑似の fetch */
function timedFetch() {
  const sent: { url: string; at: number }[] = []
  const fetch = async (url: string) => {
    sent.push({ url, at: performance.now() })
    return { status: 200, text: async () => JSON.stringify({ status_code: 200, result: {} }) }
  }
  return { sent, fetch }
}

describe("エンドポイントごとの直列化", () => {
  test("xrea-client/AC-5: 同一エンドポイントへの同時2リクエストが、1.1秒以上の間隔で送信される", async () => {
    const t = timedFetch()
    const client = new XreaClient(config, { fetch: t.fetch })
    await Promise.all([client.mailDelete([1]), client.mailDelete([2])])
    expect(t.sent).toHaveLength(2)
    expect(t.sent[1]!.at - t.sent[0]!.at).toBeGreaterThanOrEqual(MIN_GAP_MS - 5)
  })

  test("xrea-client/AC-10: 連続2回の一覧取得で、2回目の送信が1回目から1.1秒以上後になる", async () => {
    const t = timedFetch()
    const client = new XreaClient(config, { fetch: t.fetch })
    await client.mailList()
    await client.mailList()
    expect(t.sent[1]!.at - t.sent[0]!.at).toBeGreaterThanOrEqual(MIN_GAP_MS - 5)
  })

  test("別エンドポイントへの送信は互いに待たない", async () => {
    const t = timedFetch()
    const client = new XreaClient(config, { fetch: t.fetch })
    await Promise.all([client.mailList(), client.mailDelete([1])])
    expect(Math.abs(t.sent[1]!.at - t.sent[0]!.at)).toBeLessThan(200)
  })

  test("失敗したタスクの後も、後続のタスクは実行される", async () => {
    const q = new EndpointQueue(0)
    await expect(q.run("e", async () => Promise.reject(new Error("x")))).rejects.toThrow("x")
    await expect(q.run("e", async () => "ok")).resolves.toBe("ok")
  })
})

describe("応答待ちの打ち切り", () => {
  test("xrea-client/AC-12: 応答が打ち切り時間を超えて返らないとき、その時点でタイムアウトの例外が送出される", async () => {
    expect(TIMEOUT_MS).toBe(15000)
    // 応答を返さず、中断の合図でのみ終わる fetch。テストでは打ち切り時間を短くして同じ経路を確かめる
    const hang = (_url: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))
    const client = new XreaClient(config, { fetch: hang, timeoutMs: 100 })
    const start = performance.now()
    const err = await client.mailList().catch(e => e)
    const elapsed = performance.now() - start
    expect(err).toBeInstanceOf(XreaError)
    expect((err as XreaError).kind).toBe("timeout")
    expect(elapsed).toBeGreaterThanOrEqual(95)
    expect(elapsed).toBeLessThan(1000)
  })
})
