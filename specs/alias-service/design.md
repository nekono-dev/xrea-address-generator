# エイリアスサービス 設計書

## 1. 構成

| パス                        | 責務                                                  |
| --------------------------- | ----------------------------------------------------- |
| `src/app/api.ts`            | APIのルーティングとエラー応答（実行環境に依存しない） |
| `src/app/service.ts`        | 一覧の合成、中継、照合状態の組み立て                  |
| `src/app/gatewayClient.ts`  | ゲートウェイへの要求                                  |
| `src/app/readerClient.ts`   | 読み取りサービスへの要求                              |
| `src/app/config.ts`         | 環境変数の読み込みと検証                              |
| `src/app/static.ts`         | Node.jsでの画面ファイルの配信                         |
| `src/app/node.ts`           | Node.jsの入口（設定の読み込み、組み立て、起動）       |
| `src/app/worker.ts`         | Cloudflare Workersの入口                              |
| `tests/app/service.test.ts` | 一覧の合成と中継の単体テスト                          |
| `tests/app/http.test.ts`    | HTTPの入出力・401・秘匿値・配信のテスト               |
| `tests/app/worker.test.ts`  | Workersの実行環境での応答のテスト                     |
| `tests/app/bundle.test.ts`  | Workers向け成果物のサイズのテスト                     |

## 2. 設計項目

### D-1: HTTP API (FR-4, FR-5, FR-11)

| メソッドとパス               | 要求                            | 成功応答                        |
| ---------------------------- | ------------------------------- | ------------------------------- |
| GET /api/aliases             | なし                            | 200 { aliases, proton }         |
| POST /api/aliases            | { name?, domain, forwardTo }    | 201 { alias }                   |
| PATCH /api/aliases/:address  | { forwardTo }                   | 200 { alias }                   |
| DELETE /api/aliases/:address | アドレスをURLエンコードしたパス | 204                             |
| GET /api/options             | なし                            | 200 { domains, forwardTargets } |
| GET /api/proton/status       | なし                            | 200 ProtonStatus                |
| POST /api/proton/refresh     | なし                            | 202                             |
| PUT・GET /api/credentials    | 認証情報の登録と問い合わせ      | 認証情報の保持の仕様に従う      |
| GET /healthz                 | なし                            | 200 { ok: true }                |

```ts
export type Alias = {
  address: string
  name: string
  domain: string
  forwardTo: string
  mailbox: boolean
  protonEntries: string[]
}
export type ErrorCode =
  | "validation_error"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "upstream_error"
  | "rate_limited"
  | "credentials_required"
  | "invalid_credentials"

export function createApi(deps: {
  service: AppService
  store: CredentialStore
  log: Logger
}): Hono {
  const api = new Hono()
  api.route(
    "/",
    credentialRoutes({
      store: deps.store,
      verify: deps.service.verify,
      log: deps.log,
    }),
  ) // /api/credentials
  api.use("/api/*", requireCredentials(deps.store)) // 以降の /api/* は登録済みの利用者だけ
  // aliases・options・proton の各ルートは service の対応する関数を呼ぶ
  return api
}
```

ゲートウェイのエラーは、本文の code と HTTP の状態をそのまま返す。ゲートウェイの unauthorized（共有シークレットの不一致）は、利用者の認証情報の期限切れと区別するため、502 upstream_error「内部サービスの認証に失敗しました」に置き換える。

### D-2: 一覧の合成と照合状態 (FR-1, FR-2, FR-3)

```ts
export type ProtonStatus = {
  state: "loading" | "relogin" | "ready" | "error" | "disabled"
  updatedAt: string | null
  reloginAt: string | null
  itemCount: number | null
  error: { kind: string; message: string } | null
}

export async function listAliases(
  c: Credentials,
): Promise<{ aliases: Alias[]; proton: ProtonStatus }> {
  const [list, proton] = await Promise.all([
    gateway.list(c.xrea),
    readEntries(c),
  ]) // 読み取りの完了は待たない
  return {
    aliases: list.map((a) => ({
      ...a,
      protonEntries: proton.entries[a.address] ?? [],
    })),
    proton: proton.status,
  }
}

// 読み取りサービスが未設定、またはトークンが無ければ { status: disabled, entries: {} } を返し、呼び出さない
async function readEntries(
  c: Credentials,
): Promise<{ status: ProtonStatus; entries: Record<string, string[]> }>
```

| 状況                                    | 照合の状態                     | 一覧の項目の protonEntries |
| --------------------------------------- | ------------------------------ | -------------------------- |
| 読み取りサービスが未設定                | disabled                       | 空                         |
| トークンが未登録                        | disabled                       | 空                         |
| 読み取りサービスが取得中を返す          | loading                        | 空                         |
| 読み取りサービスが ready を返す         | ready                          | エントリ名（昇順）         |
| 読み取りサービスへ接続できない・2秒超過 | error（kind: cli、固定の文言） | 空                         |

### D-3: ゲートウェイへの中継 (FR-4, FR-6, FR-10, NFR-4)

```ts
export class GatewayClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}
  list(x: XreaCredentials): Promise<GatewayAlias[]>
  options(
    x: XreaCredentials,
  ): Promise<{ domains: string[]; forwardTargets: string[] }>
  create(x: XreaCredentials, b: CreateBody): Promise<GatewayAlias>
  changeForward(
    x: XreaCredentials,
    address: string,
    forwardTo: string,
  ): Promise<GatewayAlias>
  remove(x: XreaCredentials, address: string): Promise<void>
}

// 全要求に付ける。認証情報はヘッダのみで、URLと本文には載せない
const headers = (x: XreaCredentials) => ({
  authorization: `Bearer ${token}`,
  "x-xrea-account": x.account,
  "x-xrea-server": x.serverName,
  "x-xrea-secret": x.apiSecretKey,
})
```

要求は10秒（AbortSignal.timeout）で打ち切り、接続の失敗・打ち切りは 502 upstream_error「XREAゲートウェイへ接続できません」にする。

### D-4: 読み取りサービスへの中継 (FR-3, FR-6, FR-10, NFR-3)

```ts
export class ReaderClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetch: typeof globalThis.fetch = globalThis.fetch,
  ) {}
  entries(protonToken: string): Promise<EntriesResponse> // GET /v1/entries。2秒で打ち切る
  refresh(protonToken: string): Promise<void> // POST /v1/refresh。2秒で打ち切る
}
// ヘッダ: authorization: Bearer <INTERNAL_TOKEN>、x-proton-token: <アクセストークン>
```

| 要求                     | 動作                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| GET /api/proton/status   | 読み取りの entries を呼び、status だけを返す。未設定・トークン未登録は disabled を返す   |
| POST /api/proton/refresh | 読み取りの refresh を呼び、202 を返す。未設定・トークン未登録のときは呼ばずに 202 を返す |

### D-5: 秘匿情報とデータ保存 (FR-7)

```ts
// 応答に載せる項目は Alias の6項目のみ。ゲートウェイの応答をそのまま返さない
logger.info({ route: "GET /api/aliases", count, durationMs }) // 本文・アドレスの一覧・認証情報は出さない
```

| 対象                 | 取り扱い                                                         |
| -------------------- | ---------------------------------------------------------------- |
| 認証情報・トークン   | 要求の処理中だけメモリに置き、中継のヘッダ以外に書き出さない     |
| XREAのパスワード項目 | ゲートウェイの応答に含まれないため、アプリには到達しない         |
| 永続化               | 認証情報の保持方式が行うもの以外に、ファイルへの書き込みをしない |
| ログ                 | ルート名・件数・所要時間・エラーコードのみ                       |

### D-6: Node.jsの入口と画面ファイルの配信 (FR-8)

```ts
// 画面ファイルは、実行ファイルの位置から見た ../web（ビルド後の dist/web）から配信する
// /api と /healthz 以外で該当ファイルが無いパスは入口ファイルを返す。存在しない /assets/ は 404
// 名前に版を含む /assets/ は 1年（immutable）、それ以外は no-cache
const bindAddress =
  env.BIND_ADDRESS || (env.TUNNEL_TOKEN ? "127.0.0.1" : "0.0.0.0")
```

| 環境変数           | 必須 | 既定値                                                  |
| ------------------ | ---- | ------------------------------------------------------- |
| XREA_GATEWAY_URL   | 必須 | なし                                                    |
| INTERNAL_TOKEN     | 必須 | なし（32文字以上）                                      |
| COOKIE_SECRET ほか | -    | 認証情報の保持の設定に従う                              |
| PROTON_READER_URL  | 任意 | なし（未設定ならProton Pass連携を使わない）             |
| TUNNEL_TOKEN       | 任意 | なし（BIND_ADDRESS の既定値を決めるためだけに参照する） |
| BIND_ADDRESS       | 任意 | TUNNEL_TOKEN があれば 127.0.0.1、無ければ 0.0.0.0       |
| PORT               | 任意 | 3000                                                    |
| LOG_LEVEL          | 任意 | info                                                    |

### D-7: Workersの入口 (FR-9, NFR-1, NFR-2)

```ts
// src/app/worker.ts
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const api = getApi(env) // 環境の束縛から設定を読み、isolate ごとに1回だけ組み立てる
    const path = new URL(req.url).pathname
    if (path.startsWith("/api/") || path === "/healthz") return api.fetch(req)
    const res = await env.ASSETS.fetch(req)
    if (res.status !== 404) return res
    // 存在しない /assets/ は 404 のまま。それ以外は入口ファイルを返す
    return path.startsWith("/assets/")
      ? res
      : env.ASSETS.fetch(new Request(new URL("/index.html", req.url)))
  },
}
```

| 項目             | 内容                                                                                               |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| キャッシュの指示 | 配備する画面ファイルのヘッダ定義で、/assets/ を1年（immutable）、それ以外を no-cache にする        |
| 禁止             | node: の組み込みモジュール、ファイル、プロセスの環境変数に依存する部品を、このスクリプトに含めない |
| 設定             | 環境の束縛（変数と秘密）を config.ts の読み込み関数へ渡す。形式は process.env と同じ文字列の辞書   |
| 保持方式         | cookie のみ（SQLite方式の設定は起動時に拒否）                                                      |

## 3. エラー処理

| 事象                                 | 処理                                                               |
| ------------------------------------ | ------------------------------------------------------------------ |
| 必須の環境変数が未設定               | 不足している変数名を示して異常終了する（Workersでは500で応答する） |
| 要求の本文が不正なJSON               | 400 validation_error を返す                                        |
| ゲートウェイへ接続できない・超過     | 502 upstream_error を返す                                          |
| ゲートウェイの共有シークレットの拒否 | 502 upstream_error を返し、利用者の認証情報の問題と区別する        |
| 読み取りサービスの失敗               | 一覧は返し、照合の状態を error にする                              |
| 想定外の例外                         | 500 を返し、詳細をログにのみ記録する                               |
