// E2E用の疑似API。ブラウザからの /api への要求を横取りして応答する。
import type { Page } from "@playwright/test"

export type Alias = { address: string; name: string; domain: string; forwardTo: string; protonEntries: string[]; mailbox: boolean }
export type ProtonStatus = { state: string; updatedAt: string | null; reloginAt: string | null; itemCount: number | null; error: null | { kind: string; message: string } }

export const alias = (address: string, protonEntries: string[] = [], forwardTo = "me@mail.example", mailbox = false): Alias => {
  const [name, domain] = address.split("@") as [string, string]
  return { address, name, domain, forwardTo, protonEntries, mailbox }
}
export const ready = (o: Partial<ProtonStatus> = {}): ProtonStatus => ({ state: "ready", updatedAt: "2026-10-10T01:23:00.000Z", reloginAt: null, itemCount: 315, error: null, ...o })

/** スクロールを試せる件数の一覧（3ドメイン） */
export const manyAliases = (): Alias[] => {
  const list = [alias("shop@example.com", ["Amazon.co.jp"]), alias("sns@example.net", ["Bluesky", "X (Twitter)"]), alias("bank@example.org")]
  for (let i = 0; i < 24; i++) list.push(alias(`user${String(i).padStart(2, "0")}@${["example.com", "example.net", "example.org"][i % 3]}`))
  return list
}

export async function mockApi(page: Page, init: { aliases?: Alias[]; proton?: ProtonStatus; protonSequence?: ProtonStatus[]; registered?: boolean } = {}) {
  const state = {
    aliases: init.aliases ?? manyAliases(),
    proton: init.proton ?? ready(),
    protonSequence: init.protonSequence ?? [],
    registered: init.registered ?? true,
    /** 連携の利用可否 */
    capability: "available" as "disabled" | "available" | "unavailable",
    /** 登録の応答で返す proton。null なら 204 */
    putProton: null as null | "disabled" | "unavailable",
    servers: ["s1.xrea.com", "s10.xrea.com", "s100.xrea.com", "s2.xrea.com"],
    /** 登録の要求が返す失敗。null なら成功（204） */
    putFailure: null as null | { status: number; code: string; message: string },
    domains: ["example.com", "example.net", "example.org"],
    forwardTargets: ["family@mail.example", "me@mail.example", "sub@mail.example"],
  }
  const requests: { method: string; path: string; body: any }[] = []
  // ブラウザ標準のダイアログが使われたら記録する
  page.on("dialog", d => {
    requests.push({ method: "DIALOG", path: d.type(), body: d.message() })
    void d.dismiss()
  })
  await page.route("**/api/**", async route => {
    const req = route.request()
    const url = new URL(req.url())
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined
    requests.push({ method: req.method(), path: url.pathname, body })
    const json = (status: number, b?: unknown) => route.fulfill({ status, contentType: "application/json", body: b === undefined ? "" : JSON.stringify(b) })
    const key = `${req.method()} ${url.pathname.endsWith("/forward") ? "/api/aliases/:address/forward" : url.pathname.startsWith("/api/aliases/") ? "/api/aliases/:address" : url.pathname}`
    // 保護対象のAPIは、未登録（期限切れを含む）なら登録を求める
    if (!state.registered && !url.pathname.startsWith("/api/credentials") && url.pathname !== "/api/servers" && url.pathname !== "/api/capabilities")
      return json(401, { error: { code: "credentials_required", message: "認証情報を登録してください" } })
    switch (key) {
      case "GET /api/capabilities":
        return json(200, { proton: state.capability })
      case "GET /api/servers":
        return json(200, { servers: state.servers })
      case "GET /api/credentials":
        return json(200, state.registered ? { registered: true, proton: true, expiresAt: "2026-10-18T00:00:00.000Z" } : { registered: false })
      case "DELETE /api/credentials":
        state.registered = false
        return route.fulfill({ status: 204, body: "" })
      case "PUT /api/credentials":
        if (state.putFailure) return json(state.putFailure.status, { error: { code: state.putFailure.code, message: state.putFailure.message } })
        state.registered = true
        if (state.putProton) return json(200, { proton: state.putProton })
        return route.fulfill({ status: 204, body: "" })
      case "GET /api/aliases":
        return json(200, { aliases: state.aliases, proton: state.proton })
      case "GET /api/options":
        return json(200, { domains: state.domains, forwardTargets: state.forwardTargets })
      case "POST /api/aliases": {
        const name = body.name ?? "quiet.river42"
        const address = `${name}@${body.domain}`
        if (state.aliases.some(a => a.address === address)) return json(409, { error: { code: "conflict", message: `${address} はすでに存在します` } })
        const a = alias(address, [], body.forwardTo)
        state.aliases.push(a)
        return json(201, { alias: a })
      }
      case "PATCH /api/aliases/:address": {
        const address = decodeURIComponent(url.pathname.split("/").pop()!)
        const a = state.aliases.find(x => x.address === address)
        if (!a) return json(404, { error: { code: "not_found", message: `${address} は存在しません` } })
        a.forwardTo = body.forwardTo
        return json(200, { alias: a })
      }
      case "DELETE /api/aliases/:address/forward": {
        const address = decodeURIComponent(url.pathname.split("/").at(-2)!)
        const a = state.aliases.find(x => x.address === address)
        if (!a || !a.mailbox || !a.forwardTo) return json(403, { error: { code: "forbidden", message: "転送を解除できません" } })
        a.forwardTo = ""
        return json(200, { alias: a })
      }
      case "DELETE /api/aliases/:address": {
        const address = decodeURIComponent(url.pathname.split("/").pop()!)
        state.aliases = state.aliases.filter(a => a.address !== address)
        return route.fulfill({ status: 204, body: "" })
      }
      case "GET /api/proton/status": {
        if (state.protonSequence.length) state.proton = state.protonSequence.shift()!
        return json(200, state.proton)
      }
      case "POST /api/proton/refresh":
        return route.fulfill({ status: 202, body: "" })
    }
    return json(404, { error: { code: "not_found", message: "なし" } })
  })
  return { state, requests }
}
