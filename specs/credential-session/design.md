# 認証情報セッション 設計書

## 1. 構成

| パス                                | 責務                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| `src/credentials/types.ts`          | 認証情報の型と保持方式のインターフェース              |
| `src/credentials/seal.ts`           | 鍵の導出、暗号化、復号（WebCrypto）                   |
| `src/credentials/cookieStore.ts`    | cookie方式の保持                                      |
| `src/credentials/sqliteStore.ts`    | SQLite方式の保持                                      |
| `src/credentials/sqliteClient.ts`   | Node.js組み込みSQLiteによるSQLクライアントの実装      |
| `src/credentials/config.ts`         | 秘密値・保持方式・Secure属性の読み込みと検証          |
| `src/credentials/routes.ts`         | 登録と問い合わせのルート、保護対象の要求の検査        |
| `tests/credentials/seal.test.ts`    | 暗号化・復号・改ざん・鍵違いの単体テスト              |
| `tests/credentials/store.test.ts`   | 2つの保持方式の登録・取り出し・期限・置き換えのテスト |
| `tests/credentials/routes.test.ts`  | 登録・問い合わせ・401・秘匿値の非出力のテスト         |
| `tests/credentials/workers.test.ts` | Workersの実行環境でのcookie方式のテスト               |

## 2. 設計項目

### D-1: 型と保持方式 (FR-1, FR-7, FR-10)

```ts
export type XreaCredentials = {
  account: string
  serverName: string
  apiSecretKey: string
}
export type Credentials = { xrea: XreaCredentials; protonToken: string | null }
export type Registration = { credentials: Credentials; expiresAt: number } // 期限はUNIX秒

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
```

| 入力の検査                       | 結果                              |
| -------------------------------- | --------------------------------- |
| 3項目のいずれかが空              | 400 validation_error              |
| 項目が LIMITS の長さを超える     | 400 validation_error              |
| protonToken が空文字または未指定 | null として保持（連携を使わない） |

### D-2: 暗号化と復号 (FR-2, FR-3, FR-5, FR-8, FR-9, NFR-1)

```ts
export type Keyring = {
  current: { kid: string; key: CryptoKey } // 暗号化に使う鍵
  byKid: Map<string, CryptoKey> // 復号に使える鍵（現行と直前）
}

/**
 * HKDF-SHA256（salt: "xag-v1"）で、秘密値ごとに次の2つを導出する。
 *   info: "credentials" → AES-GCM 256 ビットの鍵
 *   info: "kid"         → 48ビットを base64url にした8文字の鍵の識別子
 * secrets[0] が現行、secrets[1] が直前。識別子が同じ鍵は1つにまとめる
 */
export async function deriveKey(
  ...secrets: [current: string, previous?: string]
): Promise<Keyring>

/** "v1." + kid + "." + base64url(iv 12バイト + 暗号文 + 認証タグ) */
export async function seal(
  ring: Keyring,
  payload: unknown,
  context?: string,
): Promise<string>

/** 形式の不一致・未知のkid・認証タグの不一致（改ざん・鍵違い・contextの違い）は例外を出さず null を返す */
export async function open<T>(
  ring: Keyring,
  sealed: string,
  context?: string,
): Promise<T | null>
```

| 項目           | 内容                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| iv             | 暗号化のたびに crypto.getRandomValues で12バイトを生成する                                                |
| 追加認証データ | "xag-credentials-v1"。context があるときは "xag-credentials-v1:" + context（SQLite方式ではセッションID）  |
| 平文           | JSON。cookie方式では { c: Credentials, e: 期限のUNIX秒 }                                                  |
| 鍵の保持       | 起動時に1回だけ導出し、プロセスの変数にのみ保持する（ログに出さない）                                     |
| 直前の鍵       | 復号にだけ使う。取り出した認証情報を直前の鍵で再暗号化しない（期限の7日で自然に新しい鍵の暗号文へ替わる） |

### D-3: cookie方式 (FR-2, FR-4, FR-5, FR-11, NFR-2)

```ts
export function createCookieStore(
  ring: Keyring,
  opts: { secure: boolean },
): CredentialStore {
  return {
    async save(credentials, o) {
      const exp = (o?.now ?? nowSec()) + LIFETIME_SEC
      const value = await seal(ring, { c: credentials, e: exp })
      return cookieHeader(value, opts.secure)
    },
    async load(header, now = nowSec()) {
      const raw = readCookie(header, COOKIE_NAME)
      const p = raw
        ? await open<{ c: Credentials; e: number }>(ring, raw)
        : null
      return p && p.e > now ? { credentials: p.c, expiresAt: p.e } : null
    },
  }
}

// Set-Cookie: xag_session=<値>; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict[; Secure]
function cookieHeader(value: string, secure: boolean): string
// ログアウト: xag_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict[; Secure]
function clearCookieHeader(secure: boolean): string

// cookie方式の remove は clearCookieHeader を返すだけで、サーバ側に何も持たない。
// そのため、ログアウト前に複製された cookie は、期限（7日）まで取り出せる
```

入力の上限長を最大にした認証情報（合計772文字）を暗号化したcookieの値は、約1200バイトで、4096バイト以下に収まる。Node.jsとWorkersの両方で動かすため、Node.js固有のAPIを使わない（globalThis.crypto と btoa のみ）。

### D-4: SQLite方式とSQLクライアント (FR-3, FR-7, NFR-3)

```sql
-- SQLiteの標準の構文のみを使う。標準のsqlite3コマンドで開け、Cloudflare D1（SQLite互換）でも同じ文が通る
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,          -- 32バイトの乱数のbase64url（cookieの値）
  sealed TEXT NOT NULL,         -- seal で暗号化した { c, e }
  expires_at INTEGER NOT NULL   -- UNIX秒
);
```

```ts
/** SQL文とバインド変数だけで操作する最小の境界。保持方式はこのインターフェース以外のDB APIを使わない */
export interface SqlClient {
  execute(sql: string, params?: ReadonlyArray<string | number>): Promise<void>
  query<T>(sql: string, params?: ReadonlyArray<string | number>): Promise<T[]>
}

// Node.jsの実装。同期APIを非同期に包む
import { DatabaseSync } from "node:sqlite"
export function createNodeSqliteClient(dbPath: string): SqlClient

// 保持方式。SqlClient にのみ依存する
export function createSqlStore(
  ring: Keyring,
  db: SqlClient,
  opts: { secure: boolean },
): CredentialStore
// save: 先にセッションIDを生成し、seal(ring, payload, id) で暗号化する。①DELETE FROM sessions WHERE expires_at < ? ②前のcookieのIDの行を削除 ③INSERT ④Set-Cookie を返す
// load: SELECT sealed, expires_at FROM sessions WHERE id = ? で引き、期限内なら open(ring, sealed, id) で復号して返す。行が無い・期限切れ・復号失敗は null
// remove: cookie のIDの行を DELETE FROM sessions WHERE id = ? で削除し、clearCookieHeader を返す。IDが無い・行が無いときも成功する
```

| 項目               | 内容                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| データベースの場所 | CREDENTIAL_DB_PATH（既定 /var/lib/xrea-address-generator/sessions.db）           |
| 暗号化鍵           | cookie方式と同じ秘密値から導出した鍵（セッションIDを追加認証データに含める）     |
| 行の内容           | 暗号文のみ。平文の認証情報を列に持たない                                         |
| 差し替え           | 別の SqlClient（D1のバインディング）を渡せば、保持方式の変更なしに動く           |
| 疎通               | 標準のsqlite3コマンドや一般的なSQLクライアントで、ファイルを開いて表を参照できる |

### D-5: ルートと保護対象の検査 (FR-1, FR-6, FR-8, FR-10, FR-12)

```ts
export type Verify = (x: XreaCredentials) => Promise<boolean> // XREAの一覧を1回取得できれば true

/** 連携の利用可否を最新の状態で確認する。"available" のときだけトークンを保持する */
export type ProtonCheck = () => Promise<
  "disabled" | "available" | "unavailable"
>

export function credentialRoutes(deps: {
  store: CredentialStore
  verify: Verify
  protonCheck: ProtonCheck
  log: Logger
}): Hono
// PUT /api/credentials  本文: { xrea: XreaCredentials; protonToken?: string }
//   検査 → verify → （protonToken があれば protonCheck）→ store.save → Set-Cookie
//   verify が false なら 400 invalid_credentials
//   protonCheck が "available"、または protonToken なし → 204
//   protonCheck が "available" 以外 → protonToken を null にして保存し、200 { proton: <protonCheck の結果> }
//   protonCheck の例外は "unavailable" として扱う
// DELETE /api/credentials  store.remove → Set-Cookie（cookieを消す）→ 204。未登録でも204。本文も検査も要らない
//   （SameSite=Strict により他サイトからの送信では cookie が付かず、DELETE は他サイトのフォームから送れない）
// GET /api/credentials  200 { registered: false } または
//                       { registered: true, proton: boolean, expiresAt: "<ISO 8601>" }

/** 保護対象のルートの前段。未登録なら 401 credentials_required。登録済みなら c.set("registration", ...) */
export function requireCredentials(store: CredentialStore): MiddlewareHandler
```

| 事象                                      | 応答                                             |
| ----------------------------------------- | ------------------------------------------------ |
| Content-Type が application/json でない   | 400 validation_error（他サイトからの送信を拒む） |
| verify の例外（XREAまたは中継の到達不能） | 502 upstream_error                               |
| verify が false                           | 400 invalid_credentials                          |
| protonToken あり・連携が利用可能でない    | XREAの認証情報のみ保存して 200 { proton }        |

ログに載せる項目はルート名・状態コード・所要時間のみとする。

### D-6: 設定 (FR-4, FR-9)

| 環境変数               | 必須 | 既定値                                      | 内容                                              |
| ---------------------- | ---- | ------------------------------------------- | ------------------------------------------------- |
| COOKIE_SECRET          | 必須 | なし                                        | 32文字以上。鍵の導出に使う                        |
| COOKIE_SECRET_PREVIOUS | 任意 | なし                                        | 直前の秘密値。32文字以上。復号にだけ使う          |
| CREDENTIAL_STORE       | 任意 | cookie                                      | cookie または sqlite                              |
| CREDENTIAL_DB_PATH     | 任意 | /var/lib/xrea-address-generator/sessions.db | sqlite のときのファイル                           |
| COOKIE_SECURE          | 任意 | 1                                           | 0 のとき Secure 属性を付けない（LANのHTTP公開用） |

```ts
export function loadCredentialConfig(
  env: Record<string, string | undefined>,
): CredentialConfig {
  const secret = env.COOKIE_SECRET ?? ""
  if (secret.length < 32)
    throw new ConfigError("COOKIE_SECRET は32文字以上で設定してください")
  const previous = env.COOKIE_SECRET_PREVIOUS || undefined
  if (previous !== undefined && previous.length < 32)
    throw new ConfigError(
      "COOKIE_SECRET_PREVIOUS は32文字以上で設定してください",
    )
  const store = env.CREDENTIAL_STORE ?? "cookie"
  if (store !== "cookie" && store !== "sqlite")
    throw new ConfigError("CREDENTIAL_STORE は cookie か sqlite です")
  return {
    secret,
    previousSecret: previous,
    store,
    dbPath: env.CREDENTIAL_DB_PATH || DEFAULT_DB_PATH,
    secure: env.COOKIE_SECURE !== "0",
  }
}
```

SQLクライアントの実装が無い実行環境（Workers）では sqlite を選べない（CREDENTIAL_STORE=sqlite の場合は起動時に ConfigError）。

## 3. エラー処理

| 事象                                                                         | 処理                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------ |
| COOKIE_SECRET または COOKIE_SECRET_PREVIOUS が未設定（前者）または32文字未満 | 変数名を示して起動を拒否する                     |
| 復号の失敗（改ざん・鍵違い）                                                 | 未登録として扱い、理由を応答にもログにも出さない |
| SQLiteの書き込みの失敗                                                       | 500 を返し、cookie を発行しない                  |
| 未登録での保護対象の要求                                                     | 401 credentials_required                         |
