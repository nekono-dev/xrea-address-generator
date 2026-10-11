// アプリのテスト用の部品。ゲートウェイは実物のHTTPアプリに偽のXREAを載せ、fetch で直接つなぐ。
import { createGatewayApp } from "../../src/gateway/app"
import { Registry } from "../../src/gateway/registry"
import { buildApi } from "../../src/app/api"
import { loadAppConfig } from "../../src/app/config"
import { silentLogger, type Logger } from "../../src/shared/logger"
import { vaultsJson } from "../reader/helpers"
import { FakeXrea, sampleMails } from "../gateway/fakes"

export const INTERNAL = "i".repeat(32)
export const ENV = {
  XREA_GATEWAY_URL: "https://gateway.test",
  INTERNAL_TOKEN: INTERNAL,
  COOKIE_SECRET: "c".repeat(40),
  PROTON_READER_URL: "https://reader.test",
}
export const XREA = { account: "acct", serverName: "s1.xrea.com", apiSecretKey: "XREA-SECRET-KEY" }
export const BODY = { xrea: XREA, protonToken: "PROTON-PAT-VALUE" }

export type Seen = { url: string; method: string; headers: Record<string, string>; body: string }

/** gatewayHandler / readerHandler を差し替えられる fetch。呼び出しは seen に記録する */
export function makeFetch(opts: {
  xrea?: FakeXrea
  reader?: (req: Request) => Response | Promise<Response>
  health?: (req: Request) => Response | Promise<Response> // 死活確認（既定は200）
  gatewayDelayMs?: number
}) {
  const xrea = opts.xrea ?? new FakeXrea(sampleMails())
  const gateway = createGatewayApp({ registry: new Registry(100, 600_000, Date.now, () => xrea), internalToken: INTERNAL, logger: silentLogger })
  const seen: { gateway: Seen[]; reader: Seen[]; health: Seen[] } = { gateway: [], reader: [], health: [] }
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init)
    // 実物の fetch と同じく、中断の信号で待機を打ち切る
    const aborted = new Promise<never>((_r, rej) => req.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))
    return Promise.race([handle(req), aborted])
  }) as typeof fetch
  const handle = async (req: Request): Promise<Response> => {
    const rec: Seen = { url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: await req.clone().text() }
    const u = new URL(req.url)
    if (u.host === "gateway.test") {
      seen.gateway.push(rec)
      if (opts.gatewayDelayMs) await new Promise(r => setTimeout(r, opts.gatewayDelayMs))
      return gateway.fetch(req)
    }
    if (u.pathname === "/health") {
      seen.health.push(rec)
      return opts.health ? opts.health(req) : Response.json({ ok: true })
    }
    seen.reader.push(rec)
    return opts.reader ? opts.reader(req) : defaultReader()
  }
  return { fetch: f, seen, xrea }
}

export const defaultReader = () =>
  Response.json({
    status: { state: "ready", updatedAt: "2026-10-11T00:00:00.000Z", reloginAt: null, itemCount: 3, error: null },
    entries: { "shop@example.com": ["Zeta", "Alpha"].sort(), "sns@example.net": ["Bluesky", "X (Twitter)"] },
  })

export async function makeApp(opts: Parameters<typeof makeFetch>[0] & { env?: Record<string, string>; log?: Logger } = {}) {
  const fx = makeFetch(opts)
  const app = await buildApi(loadAppConfig({ ...ENV, ...opts.env }), { fetch: fx.fetch, log: opts.log ?? silentLogger })
  const json = { "content-type": "application/json" }
  const register = async (body: object = BODY) => {
    const res = await app.request("/api/credentials", { method: "PUT", headers: json, body: JSON.stringify(body) })
    return res.headers.get("set-cookie")?.split(";")[0] ?? ""
  }
  return { ...fx, app, register, json, vaultsJson }
}

export function recorder() {
  const lines: string[] = []
  const log: Logger = {
    info: o => lines.push(JSON.stringify(o)),
    warn: o => lines.push(JSON.stringify(o)),
    error: o => lines.push(JSON.stringify(o)),
  }
  return { lines, log }
}
