// 内部の共有シークレットの検査。コンテナ間の呼び出しだけを受け付ける。
import type { MiddlewareHandler } from "hono"
import { errorBody } from "./errors"

export const MIN_TOKEN_LENGTH = 32

/** 長さに依存せず全桁を比較する（比較時間から一致桁数を推測させない） */
export function safeEqual(a: string, b: string): boolean {
  const n = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/** Authorization: Bearer <token> を定数時間で比較する */
export function internalAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const m = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")
    if (!m || !safeEqual(m[1]!, token)) return c.json(errorBody("unauthorized", "認証に失敗しました"), 401)
    await next()
  }
}
