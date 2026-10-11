// APIのルーティングとエラー応答（実行環境に依存しない）。
import { Hono, type Context } from "hono"
import type { AppConfig } from "./config"
import { createCookieStore } from "../credentials/cookieStore"
import { registerCredentialRoutes, requireCredentials, type CredentialEnv } from "../credentials/routes"
import { deriveKey } from "../credentials/seal"
import { createSqlStore, type SqlClient } from "../credentials/sqliteStore"
import type { CredentialStore } from "../credentials/types"
import { AppError, STATUS, errorBody } from "../shared/errors"
import { consoleLogger, type Logger } from "../shared/logger"
import type { GatewayFetcher } from "../gateway/app"
import { GatewayClient } from "./gatewayClient"
import { ReaderClient } from "./readerClient"
import { AppService } from "./service"

export function createApi(deps: { service: AppService; store: CredentialStore; log: Logger; servers: string[] }) {
  const { service, store, log, servers } = deps
  const api = new Hono<CredentialEnv>()

  // ログはルート名・状態・所要時間・件数・エラーコードのみ（本文や認証情報、アドレスの一覧は出さない）
  api.use("*", async (c, next) => {
    const start = performance.now()
    await next()
    if (c.req.path.startsWith("/api/") || c.req.path === "/healthz")
      log.info({ route: `${c.req.method} ${c.req.routePath}`, status: c.res.status, durationMs: Math.round(performance.now() - start) })
  })

  api.onError((e, c) => {
    if (e instanceof AppError) {
      log.warn({ route: `${c.req.method} ${c.req.routePath}`, code: e.code })
      return c.json(errorBody(e.code, e.message), STATUS[e.code])
    }
    // 例外の詳細は認証情報を含み得るため、名前だけを記録する
    log.error({ route: `${c.req.method} ${c.req.routePath}`, error: (e as Error).name })
    return c.json(errorBody("internal_error", "サーバでエラーが発生しました"), 500)
  })

  const readJson = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const body = await c.req.json()
      if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>
    } catch {
      // 下で 400 にする
    }
    throw new AppError("validation_error", "要求の本文が不正なJSONです")
  }

  api.get("/healthz", c => c.json({ ok: true }))

  api.get("/api/servers", c => c.json({ servers })) // 登録の前にも呼べる
  api.get("/api/capabilities", async c => {
    c.header("Cache-Control", "no-store")
    return c.json({ proton: await service.protonCapability() })
  }) // 登録の前にも呼べる
  registerCredentialRoutes(api, { store, verify: service.verify, protonCheck: () => service.protonCapability({ fresh: true }) }) // /api/credentials
  api.use("/api/*", requireCredentials(store)) // 以降の /api/* は登録済みの利用者だけ
  const creds = (c: Context<CredentialEnv>) => c.get("registration").credentials

  api.get("/api/aliases", async c => {
    const r = await service.listAliases(creds(c))
    log.info({ route: "GET /api/aliases", count: r.aliases.length })
    return c.json(r)
  })

  api.post("/api/aliases", async c => {
    const b = await readJson(c)
    const alias = await service.createAlias(creds(c), {
      name: typeof b.name === "string" ? b.name : undefined,
      domain: typeof b.domain === "string" ? b.domain : "",
      forwardTo: typeof b.forwardTo === "string" ? b.forwardTo : "",
    })
    return c.json({ alias }, 201)
  })

  api.patch("/api/aliases/:address", async c => {
    const b = await readJson(c)
    const alias = await service.changeForward(creds(c), c.req.param("address"), typeof b.forwardTo === "string" ? b.forwardTo : "")
    return c.json({ alias })
  })

  api.delete("/api/aliases/:address/forward", async c => {
    return c.json({ alias: await service.removeForward(creds(c), c.req.param("address")) })
  })

  api.delete("/api/aliases/:address", async c => {
    await service.deleteAlias(creds(c), c.req.param("address"))
    return c.body(null, 204)
  })

  api.get("/api/options", async c => c.json(await service.options(creds(c))))
  api.get("/api/proton/status", async c => c.json(await service.protonStatus(creds(c))))
  api.post("/api/proton/refresh", async c => {
    await service.protonRefresh(creds(c))
    return c.body(null, 202)
  })

  api.all("/api/*", c => c.json(errorBody("not_found", "APIが見つかりません"), 404))

  return api
}

/** 設定から保持方式・クライアント・APIを組み立てる。SQL方式のときは db を渡す */
export async function buildApi(config: AppConfig, opts: { gateway: GatewayFetcher; db?: SqlClient; fetch?: typeof fetch; log?: Logger }) {
  const key = await deriveKey(config.credentials.secret, config.credentials.previousSecret)
  const secure = config.credentials.secure
  let store: CredentialStore
  if (config.credentials.store === "sqlite") {
    if (!opts.db) throw new AppError("validation_error", "SQLクライアントが指定されていません")
    store = createSqlStore(key, opts.db, { secure })
  } else {
    store = createCookieStore(key, { secure })
  }
  const gateway = new GatewayClient(opts.gateway)
  const reader = config.readerUrl ? new ReaderClient(config.readerUrl, config.internalToken, opts.fetch) : null
  return createApi({ service: new AppService(gateway, reader), store, log: opts.log ?? consoleLogger, servers: config.servers })
}
