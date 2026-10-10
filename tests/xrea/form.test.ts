import { describe, expect, test } from "vitest"
import { createParam, XreaClient, type MailEditParam } from "../../src/xrea/client"
import { flatten } from "../../src/xrea/form"
import { EndpointQueue } from "../../src/xrea/queue"

/** 送信内容を記録する疑似の fetch */
function recorder(response: object = { status_code: 200 }) {
  const calls: { url: string; body: URLSearchParams }[] = []
  const fetch = async (url: string, init: { body: URLSearchParams }) => {
    calls.push({ url, body: init.body })
    return { status: 200, text: async () => JSON.stringify(response) }
  }
  return { calls, fetch }
}
const config = { account: "acc", serverName: "s1.xrea.com", apiSecretKey: "secret" }
const noWait = () => new EndpointQueue(0)

describe("フォーム形式への平坦化", () => {
  test("配列とオブジェクトをインデックス付きの項目名に展開する", () => {
    expect(flatten({ param: [{ address_name: "a", quota: 0 }] })).toEqual([
      ["param[0][address_name]", "a"],
      ["param[0][quota]", "0"],
    ])
    expect(flatten({ param: { no: [3, 7] } })).toEqual([
      ["param[no][0]", "3"],
      ["param[no][1]", "7"],
    ])
  })

  test("undefined と null の項目は送信しない", () => {
    expect(flatten({ a: undefined, b: null, c: "x" })).toEqual([["c", "x"]])
  })
})

describe("メール作成・削除の送信内容", () => {
  test("xrea-client/AC-4: メール作成の送信内容に、認証3項目とインデックス付きの項目名が含まれる", async () => {
    const r = recorder()
    await new XreaClient(config, { fetch: r.fetch, queue: noWait() }).mailCreate({ name: "shop", domain: "example.com", forwardTo: "me@mail.example" })
    expect(r.calls).toHaveLength(1)
    const { url, body } = r.calls[0]!
    expect(url).toBe("https://api.xrea.com/v1/mail/edit")
    expect(body.get("account")).toBe("acc")
    expect(body.get("server_name")).toBe("s1.xrea.com")
    expect(body.get("api_secret_key")).toBe("secret")
    expect(body.get("reset_flg")).toBe("0")
    expect(body.get("param[0][address_name]")).toBe("shop")
    expect(body.get("param[0][address]")).toBe("shop@example.com")
    expect(body.get("param[0][address_trans]")).toBe("me@mail.example")
    expect(body.get("param[0][pop_how]")).toBe("1")
    expect(body.get("param[0][pop_pass_rand]")).toBe("1")
    expect(body.get("param[0][quota]")).toBe("0")
  })

  test("メール削除は、削除対象の番号を param[no][n] で送信する", async () => {
    const r = recorder()
    await new XreaClient(config, { fetch: r.fetch, queue: noWait() }).mailDelete([12])
    expect(r.calls[0]!.url).toBe("https://api.xrea.com/v1/mail/delete")
    expect(r.calls[0]!.body.get("param[no][0]")).toBe("12")
  })

  test("xrea-client/AC-3: 生成した型で、メール作成の必須項目を欠いた呼び出しが型チェックで失敗する", () => {
    // この関数は型チェック（npx tsc --noEmit）でのみ評価する。必須項目の欠落を型エラーとして検出できること自体を確かめる
    const typeOnly = () => {
      // @ts-expect-error address_name（必須項目）を欠いている
      const missing: MailEditParam = { address_domain: "d", address: "a@d", pop_how: 1, quota: 0, autorespond: 0, clamd: 0, spamd: 0, customd: 0 }
      // @ts-expect-error reset_flg は 0 以外を指定できない
      const reset: Parameters<XreaClient["mailEdit"]>[0] = { reset_flg: 1, param: [] }
      return [missing, reset]
    }
    expect(typeof typeOnly).toBe("function")
    // 正しい作成内容は、生成した型をそのまま満たす
    const ok: MailEditParam = createParam({ name: "n", domain: "d", forwardTo: "f@d" })
    expect(ok.pop_how).toBe(1)
  })
})

describe("転送先の変更の送信内容", () => {
  const filters = {
    "1": { no: 1, header_match: 1, body_match: 0, allow_stringcase: 1, save_mail: 0, conditions: [{ target: "subject", body: "x", condition: "match" }], action_body: "[x]", action_type: "change_subject" },
  }
  const raw = {
    no: 7, address_name: "shop", address_domain: "example.com", address: "shop@example.com", pop_how: 1, address_trans: "old@mail.example",
    pop_pass: "ENCRYPTED-PASS", quota: "0", quota_use_byte: 0, quota_use_per: 0, mail_num: 3,
    autorespond: 1, autorespond_body: "不在です", clamd: 1, spamd: 0, customd: 1, customd_body: filters,
  }
  const other = { ...raw, no: 8, address_name: "other", address: "other@example.com", pop_pass: "OTHER" }

  /** 一覧の要求には疑似の一覧を、編集の要求には成功を返す */
  function listThenEdit() {
    const calls: { url: string; body: URLSearchParams }[] = []
    const fetch = async (url: string, init: { body: URLSearchParams }) => {
      calls.push({ url, body: init.body })
      const res = url.endsWith("/list") ? { status_code: 200, result: { "1": other, "2": raw } } : { status_code: 200 }
      return { status: 200, text: async () => JSON.stringify(res) }
    }
    return { calls, fetch }
  }

  test("xrea-client/AC-13: 送信内容に一覧の番号・パスワード・フィルタ・自動返信と新しい転送先が含まれ、一覧専用の項目が含まれない", async () => {
    const r = listThenEdit()
    const seen: unknown[] = []
    await new XreaClient(config, { fetch: r.fetch, queue: noWait() }).mailChangeForward("SHOP@example.com", "new@mail.example", e => {
      seen.push(e)
      if (!e) throw new Error("not found")
    })
    expect(r.calls.map(c => c.url.replace("https://api.xrea.com", ""))).toEqual(["/v1/mail/list", "/v1/mail/edit"])
    const b = r.calls[1]!.body
    expect(b.get("reset_flg")).toBe("0")
    expect(b.get("param[0][no]")).toBe("7")
    expect(b.get("param[0][address_trans]")).toBe("new@mail.example")
    expect(b.get("param[0][pop_pass]")).toBe("ENCRYPTED-PASS")
    expect(b.get("param[0][pop_how]")).toBe("1")
    expect(b.get("param[0][autorespond]")).toBe("1")
    expect(b.get("param[0][autorespond_body]")).toBe("不在です")
    expect(b.get("param[0][customd_body][1][conditions][0][target]")).toBe("subject")
    expect(b.get("param[0][customd_body][1][action_type]")).toBe("change_subject")
    for (const k of ["mail_num", "quota_use_byte", "quota_use_per"]) expect(b.has(`param[0][${k}]`)).toBe(false)
    // 検査へ渡す項目と、呼び出し元にはパスワードを渡さない
    expect(seen[0]).toMatchObject({ no: 7, address_trans: "old@mail.example" })
    expect(seen[0]).not.toHaveProperty("pop_pass")
  })

  test("検査が例外を送出したときは、編集の要求を送らない", async () => {
    const r = listThenEdit()
    const c = new XreaClient(config, { fetch: r.fetch, queue: noWait() })
    await expect(
      c.mailChangeForward("none@example.com", "new@mail.example", e => {
        if (!e) throw new Error("not found")
      }),
    ).rejects.toThrow("not found")
    expect(r.calls).toHaveLength(1)
  })
})
