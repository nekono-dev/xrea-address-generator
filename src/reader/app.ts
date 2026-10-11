// ルーティング、共有シークレットの検査、応答の組み立て。
import { Hono } from "hono"
import { STATUS, AppError, errorBody } from "../shared/errors"
import { internalAuth } from "../shared/internalAuth"
import { consoleLogger, type Logger } from "../shared/logger"
import type { Status } from "./cache"
import type { AddressMap } from "./projection"
import type { Tenants } from "./tenants"

export type EntriesResponse = { status: Status; entries: Record<string, string[]> } // アドレス -> エントリ名の昇順

/** 新しいオブジェクトに許可した項目だけを写す */
export function toResponse(map: AddressMap, status: Status): EntriesResponse {
  return {
    status: {
      state: status.state,
      updatedAt: status.updatedAt,
      reloginAt: status.reloginAt,
      itemCount: status.itemCount,
      error: status.error ? { kind: status.error.kind, message: status.error.message } : null,
    },
    entries: Object.fromEntries([...map].map(([a, names]) => [a, [...names]])),
  }
}

export function createReaderApp(opts: { tenants: Tenants; internalToken: string; logger?: Logger }) {
  const log = opts.logger ?? consoleLogger
  const app = new Hono()

  app.use("*", async (c, next) => {
    const start = performance.now()
    await next()
    log.info({ route: `${c.req.method} ${c.req.routePath}`, status: c.res.status, durationMs: Math.round(performance.now() - start) })
  })

  app.onError((e, c) => {
    if (e instanceof AppError) return c.json(errorBody(e.code, e.message), STATUS[e.code])
    log.error({ route: `${c.req.method} ${c.req.routePath}`, error: (e as Error).name })
    return c.json(errorBody("internal_error", "サーバでエラーが発生しました"), 500)
  })

  app.get("/healthz", c => c.json({ ok: true }))

  app.use("/v1/*", internalAuth(opts.internalToken))
  app.use("/v1/*", async (c, next) => {
    if (!c.req.header("x-proton-token")) throw new AppError("unauthorized", "アクセストークンが指定されていません")
    await next()
  })

  app.get("/v1/entries", c => {
    const reader = opts.tenants.get(c.req.header("x-proton-token")!)
    const map = reader.getMap() // 待たずに現在の状態と対応表を返す
    return c.json(toResponse(map, reader.getStatus()))
  })

  app.post("/v1/refresh", c => {
    void opts.tenants.get(c.req.header("x-proton-token")!).refresh() // 完了を待たない
    return c.body(null, 202)
  })

  app.all("/v1/*", c => c.json(errorBody("not_found", "APIが見つかりません"), 404))

  return app
}
