// 認証情報の型と、保持方式のインターフェース。
export type XreaCredentials = {
  account: string
  serverName: string
  apiSecretKey: string
}
export type Credentials = { xrea: XreaCredentials; protonToken: string | null }
/** 期限はUNIX秒 */
export type Registration = { credentials: Credentials; expiresAt: number }

export interface CredentialStore {
  /** Cookieヘッダから認証情報を取り出す。未登録・期限切れ・改ざん・鍵違いは null */
  load(cookieHeader: string | null, now?: number): Promise<Registration | null>
  /** 認証情報を保持し、応答へ付ける Set-Cookie の値を返す。前のcookieがあれば置き換える */
  save(
    credentials: Credentials,
    opts?: { previousCookieHeader?: string | null; now?: number },
  ): Promise<string>
  /** ログアウト。cookie を消す Set-Cookie の値を返す。SQLite方式では cookie が指す行も削除する */
  remove(cookieHeader: string | null): Promise<string>
}

export const COOKIE_NAME = "xag_session"
export const LIFETIME_SEC = 7 * 24 * 3600
export const LIMITS = {
  account: 64,
  serverName: 64,
  apiSecretKey: 128,
  protonToken: 512,
} as const
