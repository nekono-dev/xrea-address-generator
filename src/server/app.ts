// ルーティング、エラー応答、画面ファイルの配信。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Hono, type Context } from "hono"
import { XreaError } from "../xrea/errors"
import { AppError, type AliasService, type ErrorCode } from "./aliasService"

export type Logger = { info(o: object): void; warn(o: object): void; error(o: object): void }
export const consoleLogger: Logger = {
  info: o => console.log(JSON.stringify({ level: "info", ...o })),
  warn: o => console.warn(JSON.stringify({ level: "warn", ...o })),
  error: o => console.error(JSON.stringify({ level: "error", ...o })),
}

/** サーバの実行ファイルの位置から見た ../web（ビルド後の dist/web）。作業ディレクトリに依存しない */
export const DEFAULT_WEB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web")

const STATUS: Record<ErrorCode, 400 | 403 | 404 | 409 | 502 | 503> = {
  validation_error: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  upstream_error: 502,
  rate_limited: 503,
}
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
}

function toAppError(e: unknown): AppError | null {
  if (e instanceof AppError) return e
  if (e instanceof XreaError) {
    if (e.kind === "rate_limit") return new AppError("rate_limited", "XREAへのリクエストが集中しています。少し待ってから再度お試しください")
    if (e.kind === "api") return new AppError("upstream_error", e.message)
    return new AppError("upstream_error", e.message)
  }
  return null
}

export function createApp(opts: { service: AliasService; webDir?: string; logger?: Logger }) {
  const { service } = opts
  const log = opts.logger ?? consoleLogger
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR
  const app = new Hono()

  // ログはルート名・件数・所要時間・エラーコードのみ（本文やアドレスの一覧は出さない）
  app.use("*", async (c, next) => {
    const start = performance.now()
    await next()
    if (c.req.path.startsWith("/api/") || c.req.path === "/healthz")
      log.info({ route: `${c.req.method} ${c.req.routePath}`, status: c.res.status, durationMs: Math.round(performance.now() - start) })
  })

  app.onError((e, c) => {
    const appErr = toAppError(e)
    if (appErr) {
      log.warn({ route: `${c.req.method} ${c.req.routePath}`, code: appErr.code })
      return c.json({ error: { code: appErr.code, message: appErr.message } }, STATUS[appErr.code])
    }
    log.error({ route: `${c.req.method} ${c.req.routePath}`, error: (e as Error).name, detail: (e as Error).message })
    return c.json({ error: { code: "internal_error", message: "サーバでエラーが発生しました" } }, 500)
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

  app.get("/healthz", c => c.json({ ok: true }))

  app.get("/api/aliases", async c => {
    const r = await service.listAliases()
    log.info({ route: "GET /api/aliases", count: r.aliases.length })
    return c.json(r)
  })

  app.post("/api/aliases", async c => {
    const b = await readJson(c)
    const alias = await service.createAlias({
      name: typeof b.name === "string" ? b.name : undefined,
      domain: typeof b.domain === "string" ? b.domain : "",
      forwardTo: typeof b.forwardTo === "string" ? b.forwardTo : "",
    })
    return c.json({ alias }, 201)
  })

  app.patch("/api/aliases/:address", async c => {
    const b = await readJson(c)
    const alias = await service.changeForward(c.req.param("address"), typeof b.forwardTo === "string" ? b.forwardTo : "")
    return c.json({ alias })
  })

  app.delete("/api/aliases/:address", async c => {
    await service.deleteAlias(c.req.param("address"))
    return c.body(null, 204)
  })

  app.get("/api/options", async c => c.json(await service.options()))
  app.get("/api/proton/status", c => c.json(service.protonStatus()))
  app.post("/api/proton/refresh", c => {
    service.protonRefresh()
    return c.body(null, 202)
  })

  app.all("/api/*", c => c.json({ error: { code: "not_found", message: "APIが見つかりません" } }, 404))

  // 画面ファイル。該当ファイルが無いパスは入口ファイルを返す
  // 名前に版を含む /assets/ は1年間キャッシュさせ、それ以外（入口・宣言・Service Worker）は毎回検証させる
  const assetsDir = path.join(webDir, "assets")
  app.get("*", c => {
    const rel = decodeURIComponent(c.req.path).replace(/^\/+/, "")
    const file = path.resolve(webDir, rel)
    const inside = file === webDir || file.startsWith(webDir + path.sep)
    const exists = inside && rel !== "" && fs.existsSync(file) && fs.statSync(file).isFile()
    // 存在しない /assets/ に入口を返すと、端末に入口が画面ファイルとして保存されるため 404 にする
    if (!exists && rel.startsWith("assets/")) return c.text("画面ファイルが見つかりません", 404, { "cache-control": "no-cache" })
    const target = exists ? file : path.join(webDir, "index.html")
    if (!fs.existsSync(target)) return c.text("画面ファイルが見つかりません", 404)
    const immutable = target.startsWith(assetsDir + path.sep)
    return c.body(fs.readFileSync(target), 200, {
      "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
      "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    })
  })

  return app
}
