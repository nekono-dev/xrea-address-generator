// 画面の単体テスト用の補助（偽のサーバ）。
import { setFetch, type Alias, type ProtonStatus } from "../../web/src/api"

export const alias = (address: string, protonEntries: string[] = [], forwardTo = "me@mail.example", mailbox = false): Alias => {
  const [name, domain] = address.split("@") as [string, string]
  return { address, name, domain, forwardTo, protonEntries, mailbox }
}
export const ready = (o: Partial<ProtonStatus> = {}): ProtonStatus => ({ state: "ready", updatedAt: "2026-10-10T01:23:00.000Z", reloginAt: null, itemCount: 315, error: null, ...o })

type Handler = (req: { method: string; url: string; body: any }) => { status: number; body?: unknown } | Promise<{ status: number; body?: unknown }>

/** 経路ごとの応答を差し替えられる偽のサーバ。要求は requests に記録する */
export function fakeServer(init: { aliases?: Alias[]; proton?: ProtonStatus; domains?: string[]; forwardTargets?: string[] } = {}) {
  globalThis.localStorage?.clear() // 前のテストで保存した選択を持ち越さない
  const state = {
    aliases: init.aliases ?? [alias("shop@example.com", ["Amazon.co.jp"]), alias("sns@example.net", ["Bluesky", "X (Twitter)"]), alias("bank@example.org")],
    proton: init.proton ?? ready(),
    domains: init.domains ?? ["example.com", "example.net", "example.org"],
    forwardTargets: init.forwardTargets ?? ["me@mail.example", "sub@mail.example"],
  }
  const requests: { method: string; url: string; body: any }[] = []
  const overrides: Record<string, Handler> = {}
  const handle: Handler = ({ method, url, body }) => {
    const key = `${method} ${url.replace(/\/api\/aliases\/.+$/, "/api/aliases/:address")}`
    if (overrides[key]) return overrides[key]!({ method, url, body })
    switch (key) {
      case "GET /api/aliases":
        return { status: 200, body: { aliases: state.aliases, proton: state.proton } }
      case "GET /api/options":
        return { status: 200, body: { domains: state.domains, forwardTargets: state.forwardTargets } }
      case "POST /api/aliases": {
        const name = body.name ?? "quiet.river42"
        const a = alias(`${name}@${body.domain}`, [], body.forwardTo)
        state.aliases.push(a)
        return { status: 201, body: { alias: a } }
      }
      case "PATCH /api/aliases/:address": {
        const address = decodeURIComponent(url.split("/").pop()!)
        const a = state.aliases.find(x => x.address === address)
        if (!a) return { status: 404, body: { error: { code: "not_found", message: `${address} は存在しません` } } }
        a.forwardTo = body.forwardTo
        return { status: 200, body: { alias: { ...a } } }
      }
      case "DELETE /api/aliases/:address": {
        const address = decodeURIComponent(url.split("/").pop()!)
        state.aliases = state.aliases.filter(a => a.address !== address)
        return { status: 204 }
      }
      case "GET /api/proton/status":
        return { status: 200, body: state.proton }
      case "POST /api/proton/refresh":
        return { status: 202 }
    }
    return { status: 404, body: { error: { code: "not_found", message: "なし" } } }
  }
  setFetch(async (input, init2) => {
    const method = init2?.method ?? "GET"
    const url = String(input)
    const body = init2?.body ? JSON.parse(String(init2.body)) : undefined
    requests.push({ method, url, body })
    const r = await handle({ method, url, body })
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } })
  })
  return { state, requests, overrides }
}
