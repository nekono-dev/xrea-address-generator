// ルーティング、共有シークレットの検査、エラー応答。
import { Hono, type Context } from "hono"
import { AppError, STATUS, errorBody } from "../shared/errors"
import { internalAuth } from "../shared/internalAuth"
import { consoleLogger, type Logger } from "../shared/logger"
import { XreaError } from "../xrea/errors"
import type { DomainCheck } from "./domainCheck"
import type { Registry } from "./registry"
import * as svc from "./service"

// Workers からの呼び出しでは、Cloudflare が 5xx の応答を本文ごと "error code: 502" に置き換える。
// 本文の code を届けるため、ゲートウェイは XREA・ネットワーク由来の異常を 5xx ではなく 4xx で返す
const WIRE_STATUS: Partial<Record<AppError["code"], 424 | 429>> = { upstream_error: 424, rate_limited: 429 }

function toAppError(e: unknown): AppError | null {
  if (e instanceof AppError) return e
  if (e instanceof XreaError) {
    if (e.kind === "rate_limit") return new AppError("rate_limited", "XREAへのリクエストが集中しています。少し待ってから再度お試しください")
    return new AppError("upstream_error", e.message, e.kind === "api" ? "api" : "network")
  }
  return null
}

export function createGatewayApp(opts: { registry: Registry; internalToken: string; logger?: Logger; words?: readonly string[]; rnd?: () => number; domainCheck?: DomainCheck }) {
  const log = opts.logger ?? consoleLogger
  const app = new Hono()

  app.use("*", async (c, next) => {
    const start = performance.now()
    await next()
    log.info({ route: `${c.req.method} ${c.req.routePath}`, status: c.res.status, durationMs: Math.round(performance.now() - start) })
  })

  app.onError((e, c) => {
    const appErr = toAppError(e)
    if (appErr) {
      log.warn({ route: `${c.req.method} ${c.req.routePath}`, code: appErr.code })
      return c.json(errorBody(appErr.code, appErr.message, appErr.kind), WIRE_STATUS[appErr.code] ?? STATUS[appErr.code])
    }
    // 例外の詳細に認証情報が含まれ得るため、名前だけを記録する
    log.error({ route: `${c.req.method} ${c.req.routePath}`, error: (e as Error).name })
    return c.json(errorBody("internal_error", "サーバでエラーが発生しました"), 500)
  })

  // Cloud Run は z で終わるパス（/healthz）を予約しているため、/health も同じ応答にする
  app.get("/healthz", c => c.json({ ok: true }))
  app.get("/health", c => c.json({ ok: true }))

  const auth = internalAuth(opts.internalToken)
  app.use("/v1/*", auth)

  const tenantOf = (c: Context) => {
    const account = c.req.header("x-xrea-account")
    const serverName = c.req.header("x-xrea-server")
    const apiSecretKey = c.req.header("x-xrea-secret")
    if (!account || !serverName || !apiSecretKey) throw new AppError("unauthorized", "XREAの認証情報が指定されていません")
    return opts.registry.get({ account, serverName, apiSecretKey })
  }
  const readJson = async (c: Context): Promise<Record<string, unknown>> => {
    try {
      const body = await c.req.json()
      if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>
    } catch {
      // 下で 400 にする
    }
    throw new AppError("validation_error", "要求の本文が不正なJSONです")
  }

  app.get("/v1/aliases", async c => {
    const aliases = await svc.listAliases(tenantOf(c))
    log.info({ route: "GET /v1/aliases", count: aliases.length })
    return c.json({ aliases })
  })

  app.post("/v1/aliases", async c => {
    const t = tenantOf(c)
    const b = await readJson(c)
    const alias = await svc.createAlias(
      t,
      {
        name: typeof b.name === "string" ? b.name : undefined,
        domain: typeof b.domain === "string" ? b.domain : "",
        forwardTo: typeof b.forwardTo === "string" ? b.forwardTo : "",
      },
      { words: opts.words, rnd: opts.rnd, domainCheck: opts.domainCheck },
    )
    return c.json({ alias }, 201)
  })

  app.patch("/v1/aliases/:address", async c => {
    const t = tenantOf(c)
    const b = await readJson(c)
    const alias = await svc.changeForward(t, c.req.param("address"), typeof b.forwardTo === "string" ? b.forwardTo : "")
    return c.json({ alias })
  })

  app.delete("/v1/aliases/:address/forward", async c => {
    return c.json({ alias: await svc.removeForward(tenantOf(c), c.req.param("address")) })
  })

  app.delete("/v1/aliases/:address", async c => {
    await svc.deleteAlias(tenantOf(c), c.req.param("address"))
    return c.body(null, 204)
  })

  app.get("/v1/options", async c => c.json(await svc.options(tenantOf(c))))

  app.all("/v1/*", c => c.json(errorBody("not_found", "APIが見つかりません"), 404))

  return app
}
