// Cloudflare Workersの入口。node: の組み込みモジュールとファイルに依存しない。
import { durableFetcher, type GatewayNamespace } from "../gateway/durableRouter"
import { buildApi } from "./api"
import { loadAppConfig } from "./config"

export { GatewayTenant } from "../gateway/durableObject"

type Env = Record<string, string | undefined> & { ASSETS: { fetch(req: Request): Promise<Response> }; GATEWAY: GatewayNamespace }

let cached: Promise<{ fetch(req: Request): Response | Promise<Response> }> | null = null

/** 環境の束縛から設定を読み、isolate ごとに1回だけ組み立てる */
function getApi(env: Env) {
  cached ??= buildApi(loadAppConfig(env as Record<string, string | undefined>, { allowSqlite: false, httpPolicy: "all" }), { gateway: durableFetcher(env.GATEWAY) }).catch(e => {
    cached = null
    throw e
  })
  return cached
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path.startsWith("/api/") || path === "/healthz") {
      try {
        return await (await getApi(env)).fetch(req)
      } catch (e) {
        console.error(JSON.stringify({ level: "error", error: (e as Error).name, detail: (e as Error).message }))
        return Response.json({ error: { code: "internal_error", message: "サーバの設定を確認してください" } }, { status: 500 })
      }
    }
    const res = await env.ASSETS.fetch(req)
    if (res.status !== 404) return res
    // 存在しない /assets/ は 404 のまま。それ以外は入口ファイルを返す
    return path.startsWith("/assets/") ? res : env.ASSETS.fetch(new Request(new URL("/index.html", req.url)))
  },
}
