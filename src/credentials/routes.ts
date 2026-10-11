// 登録と問い合わせのルート、保護対象の要求の検査。
import { Hono, type MiddlewareHandler } from "hono"
import { AppError, STATUS, errorBody } from "../shared/errors"
import type { Logger } from "../shared/logger"
import { nowSec } from "./cookieStore"
import { LIFETIME_SEC, LIMITS, type CredentialStore, type Credentials, type Registration, type XreaCredentials } from "./types"

/** XREAの一覧を1回取得できれば true */
export type Verify = (x: XreaCredentials) => Promise<boolean>

/** 連携の利用可否を最新の状態で確認する。"available" のときだけトークンを保持する */
export type ProtonCheck = () => Promise<"disabled" | "available" | "unavailable">

export type CredentialEnv = { Variables: { registration: Registration } }

function str(v: unknown, name: keyof typeof LIMITS, required: boolean): string {
  if (v === undefined || v === null || v === "") {
    if (required) throw new AppError("validation_error", `${name} は必須です`)
    return ""
  }
  if (typeof v !== "string") throw new AppError("validation_error", `${name} は文字列で指定してください`)
  if (v.length > LIMITS[name]) throw new AppError("validation_error", `${name} は${LIMITS[name]}文字以内で指定してください`)
  return v
}

export function parseCredentials(body: unknown): Credentials {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>
  const x = (b.xrea && typeof b.xrea === "object" ? b.xrea : {}) as Record<string, unknown>
  const token = str(b.protonToken, "protonToken", false)
  return {
    xrea: {
      account: str(x.account, "account", true),
      serverName: str(x.serverName, "serverName", true),
      apiSecretKey: str(x.apiSecretKey, "apiSecretKey", true),
    },
    protonToken: token === "" ? null : token,
  }
}

/** ログと例外の応答を含む単独のルート。他のルートと同居させるときは registerCredentialRoutes を使う */
export function credentialRoutes(deps: { store: CredentialStore; verify: Verify; protonCheck: ProtonCheck; log: Logger }) {
  const app = new Hono<CredentialEnv>()
  const { log } = deps

  app.use("*", async (c, next) => {
    const start = performance.now()
    await next()
    log.info({ route: `${c.req.method} ${c.req.routePath}`, status: c.res.status, durationMs: Math.round(performance.now() - start) })
  })

  app.onError((e, c) => {
    if (e instanceof AppError) return c.json(errorBody(e.code, e.message), STATUS[e.code])
    // 例外の詳細は秘匿値を含み得るため、名前だけを記録する
    log.error({ route: `${c.req.method} ${c.req.routePath}`, error: (e as Error).name })
    return c.json(errorBody("internal_error", "サーバでエラーが発生しました"), 500)
  })

  registerCredentialRoutes(app, deps)
  return app
}

/** PUT・GET・DELETE /api/credentials を登録する */
export function registerCredentialRoutes<E extends CredentialEnv>(app: Hono<E>, deps: { store: CredentialStore; verify: Verify; protonCheck: ProtonCheck }) {
  const { store, verify, protonCheck } = deps

  app.put("/api/credentials", async c => {
    if (!(c.req.header("content-type") ?? "").toLowerCase().startsWith("application/json"))
      throw new AppError("validation_error", "Content-Type は application/json にしてください")
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      throw new AppError("validation_error", "要求の本文が不正なJSONです")
    }
    const credentials = parseCredentials(body)
    let ok: boolean
    try {
      ok = await verify(credentials.xrea)
    } catch {
      throw new AppError("upstream_error", "XREAに接続できませんでした")
    }
    if (!ok) throw new AppError("invalid_credentials", "XREAの認証情報を確認してください")
    // トークンがあるときだけ利用可否を最新の状態で確認し、利用可能でなければトークンを保持しない
    let proton: "disabled" | "available" | "unavailable" = "available"
    if (credentials.protonToken !== null) {
      try {
        proton = await protonCheck()
      } catch {
        proton = "unavailable"
      }
      if (proton !== "available") credentials.protonToken = null
    }
    const cookie = await store.save(credentials, { previousCookieHeader: c.req.header("cookie") ?? null })
    c.header("Set-Cookie", cookie)
    return proton === "available" ? c.body(null, 204) : c.json({ proton }, 200)
  })

  // ログアウト。未登録でも成功する。SameSite=Strict により、他サイトからの送信には cookie が付かない
  app.delete("/api/credentials", async c => {
    c.header("Set-Cookie", await store.remove(c.req.header("cookie") ?? null))
    return c.body(null, 204)
  })

  app.get("/api/credentials", async c => {
    const cookie = c.req.header("cookie") ?? null
    const reg = await store.load(cookie)
    c.header("Cache-Control", "no-store")
    if (!reg) return c.json({ registered: false })
    // ダッシュボードを開いたときの問い合わせで、有効期間を7日へ延長する（同じ認証情報で発行し直す）
    const now = nowSec()
    c.header("Set-Cookie", await store.save(reg.credentials, { previousCookieHeader: cookie, now }))
    return c.json({
      registered: true,
      proton: reg.credentials.protonToken !== null,
      expiresAt: new Date((now + LIFETIME_SEC) * 1000).toISOString(),
    })
  })
}

/** 保護対象のルートの前段。未登録なら 401 credentials_required。登録済みなら c.set("registration", ...) */
export function requireCredentials(store: CredentialStore): MiddlewareHandler<CredentialEnv> {
  return async (c, next) => {
    const reg = await store.load(c.req.header("cookie") ?? null)
    if (!reg) return c.json(errorBody("credentials_required", "認証情報を登録してください"), 401)
    c.set("registration", reg)
    await next()
  }
}
