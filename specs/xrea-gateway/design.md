# XREAゲートウェイ 設計書

## 1. 構成

| パス                            | 責務                                                 |
| ------------------------------- | ---------------------------------------------------- |
| `src/gateway/main.ts`           | 設定の読み込みと起動                                 |
| `src/gateway/config.ts`         | 環境変数の読み込みと検証                             |
| `src/gateway/app.ts`            | ルーティング、共有シークレットの検査、エラー応答     |
| `src/gateway/service.ts`        | 一覧、発行、転送先の変更、削除、候補の導出           |
| `src/gateway/registry.ts`       | アカウントごとのクライアント・キャッシュ・排他の保持 |
| `src/gateway/listCache.ts`      | 一覧のキャッシュ                                     |
| `src/gateway/mutex.ts`          | 変更要求の直列化                                     |
| `src/gateway/validate.ts`       | 発行の入力の検証                                     |
| `src/gateway/randomName.ts`     | ランダムな名前の生成                                 |
| `src/gateway/words.ts`          | ランダム名に使う単語の辞書                           |
| `src/shared/errors.ts`          | アプリ共通のエラーコードと状態コードの対応           |
| `src/shared/logger.ts`          | 構造化ログ                                           |
| `src/shared/internalAuth.ts`    | 内部の共有シークレットの検査                         |
| `tests/gateway/service.test.ts` | 一覧・発行・転送先の変更・削除・候補の単体テスト     |
| `tests/gateway/http.test.ts`    | 認証・排他・キャッシュ・クライアントの保持のテスト   |
| `tests/gateway/live.test.ts`    | 実際のAPIに対する発行・変更・削除のテスト            |

## 2. 設計項目

### D-1: HTTP API と認証 (FR-7, FR-11)

| メソッドとパス              | 要求                            | 成功応答                        |
| --------------------------- | ------------------------------- | ------------------------------- |
| GET /v1/aliases             | なし                            | 200 { aliases }                 |
| POST /v1/aliases            | { name?, domain, forwardTo }    | 201 { alias }                   |
| PATCH /v1/aliases/:address  | { forwardTo }                   | 200 { alias }                   |
| DELETE /v1/aliases/:address | アドレスをURLエンコードしたパス | 204                             |
| GET /v1/options             | なし                            | 200 { domains, forwardTargets } |
| GET /healthz                | なし                            | 200 { ok: true }                |

```ts
// /healthz 以外の全ルートの前段
export function internalAuth(token: string): MiddlewareHandler // Authorization: Bearer <INTERNAL_TOKEN> を定数時間で比較する

// 認証情報は要求ヘッダで受け取る
const creds = {
  account: h("x-xrea-account"),
  serverName: h("x-xrea-server"),
  apiSecretKey: h("x-xrea-secret"),
}

export type GatewayAlias = {
  address: string
  name: string
  domain: string
  forwardTo: string
  mailbox: boolean
}
export type ErrorCode =
  | "validation_error"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "upstream_error"
  | "rate_limited"
  | "unauthorized"
```

| ErrorCode        | HTTP | 発生条件                                 |
| ---------------- | ---- | ---------------------------------------- |
| unauthorized     | 401  | 共有シークレットの不一致、認証情報の欠落 |
| validation_error | 400  | 入力が規則に反する                       |
| forbidden        | 403  | 転送のみ以外の変更・削除                 |
| not_found        | 404  | 変更・削除の対象が存在しない             |
| conflict         | 409  | 同一アドレスがすでに存在する             |
| rate_limited     | 503  | XREAが送信間隔の超過を返した             |
| upstream_error   | 502  | XREAまたはネットワークの異常             |

upstream_error の本文には kind を付け、XREAが拒否したとき（認証情報の誤りを含む）は api、到達できなかったときは network にする。

### D-2: 一覧と候補 (FR-1, FR-6)

```ts
export async function listAliases(t: Tenant): Promise<GatewayAlias[]> {
  const mails = await t.cache.get()
  return mails
    .filter((m) => [1, 2, 3].includes(m.pop_how)) // 破棄以外を残す
    .map((m) => ({
      address: `${m.address_name}@${m.address_domain}`.toLowerCase(),
      name: m.address_name,
      domain: m.address_domain,
      forwardTo: m.address_trans,
      mailbox: m.pop_how === 2 || m.pop_how === 3, // 表示のみで、変更・削除はできない
    }))
}

export function deriveOptions(mails: MailEntry[]): {
  domains: string[]
  forwardTargets: string[]
} {
  const uniq = (xs: string[]) =>
    [...new Set(xs.filter(Boolean).map((s) => s.toLowerCase()))].sort()
  return {
    domains: uniq(mails.map((m) => m.address_domain)),
    forwardTargets: uniq(mails.map((m) => m.address_trans)),
  }
}
```

| 受信方法の値 | 意味             | 一覧への掲載 | mailbox |
| ------------ | ---------------- | ------------ | ------- |
| 1            | 転送のみ         | 掲載する     | false   |
| 2            | 受信のみ         | 掲載する     | true    |
| 3            | 転送と受信の両方 | 掲載する     | true    |
| 4            | 破棄             | 掲載しない   | -       |

ドメインの候補は全アドレスのドメインから、転送先の候補は転送先が空でない全アドレスから導出する。

### D-3: 発行 (FR-2, FR-3)

```ts
export type CreateInput = { name?: string; domain: string; forwardTo: string }
export function validate(input: CreateInput, domains: string[]): string[] // 違反の説明の配列
const NAME_RE = /^[a-z0-9]([a-z0-9._-]{0,47}[a-z0-9])?$/ // 1〜49文字。XREAは50文字以上を拒否する
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// 追加の規則: 連続するピリオドを含まない。名前は小文字に正規化してから検証する

export function randomName(
  words: readonly string[],
  rnd: () => number,
): string {
  const w = () => words[Math.floor(rnd() * words.length)]
  return `${w()}.${w()}${10 + Math.floor(rnd() * 90)}`
}
```

| 手順 | 処理                                                        |
| ---- | ----------------------------------------------------------- |
| 1    | アカウントの排他を取得する                                  |
| 2    | XREAの一覧を取り直し、ドメインの候補を導出する              |
| 3    | 入力を検証する。違反があれば400                             |
| 4    | 名前が空なら生成する。一覧と衝突したら最大5回まで再生成する |
| 5    | 同名のアドレスがあれば409                                   |
| 6    | XREAへ転送のみのアドレスの作成を要求する                    |
| 7    | 一覧のキャッシュを破棄し、作成したアドレスを201で返す       |

単語の辞書は、小文字の英単語256語を固定で持つ。

### D-4: 削除と転送先の変更 (FR-4, FR-5)

```ts
export async function deleteAlias(t: Tenant, address: string): Promise<void> {
  return t.mutex.run(async () => {
    const mails = await t.cache.fresh() // 取り直した一覧
    const target = mails.find(
      (m) =>
        `${m.address_name}@${m.address_domain}`.toLowerCase() ===
        address.toLowerCase(),
    )
    if (!target) throw new AppError("not_found")
    if (target.pop_how !== 1) throw new AppError("forbidden")
    await t.xrea.mailDelete([target.no]) // 直前の一覧の番号だけを使う
    t.cache.invalidate()
  })
}

export async function changeForward(
  t: Tenant,
  address: string,
  forwardTo: string,
): Promise<GatewayAlias> {
  if (!MAIL_RE.test(forwardTo.trim())) throw new AppError("validation_error") // 排他の取得前に判定する
  return t.mutex.run(async () => {
    let target: MailEntry | undefined
    // 一覧の取り直し・アドレスの解決・送信はクライアントが続けて行う（番号のずれを防ぐ）
    await t.xrea.mailChangeForward(address, forwardTo.trim(), (m) => {
      if (!m) throw new AppError("not_found")
      if (m.pop_how !== 1) throw new AppError("forbidden")
      target = m
    })
    t.cache.invalidate()
    return toGatewayAlias({ ...target!, address_trans: forwardTo.trim() }) // 一覧を再び取得しない
  })
}
```

| 事象                   | 応答                    |
| ---------------------- | ----------------------- |
| 一覧に存在しない       | 404                     |
| 受信方法が転送のみ以外 | 403                     |
| 現在と同じ転送先       | XREAへ送信して200を返す |

### D-5: アカウントごとの保持・排他・キャッシュ (FR-8, FR-10, NFR-3, NFR-4)

```ts
export type Tenant = {
  xrea: XreaClient
  cache: ListCache
  mutex: Mutex
  lastUsed: number
}

export class Registry {
  constructor(
    private max = 100,
    private idleMs = 600_000,
    private now = Date.now,
  ) {}
  /** key = sha256(account + "\0" + serverName + "\0" + apiSecretKey) の16進。無ければ作る */
  get(creds: XreaConfig): Tenant
  /** 最後の使用から idleMs を過ぎたものを破棄し、max を超えたら最も古く使われたものを破棄する */
  private evict(): void
}

export class ListCache {
  constructor(
    private fetch: () => Promise<MailEntry[]>,
    private ttlMs = 30_000,
  ) {}
  get(): Promise<MailEntry[]> // 有効期間内はメモリから返す
  fresh(): Promise<MailEntry[]> // 常にXREAから取り直す
  invalidate(): void // 発行・転送先の変更・削除の成功時に呼ぶ
}
export class Mutex {
  run<T>(task: () => Promise<T>): Promise<T>
} // 到着順に1件ずつ実行する
```

アカウントごとに別のクライアントとキュー（同一エンドポイントへの間隔の確保）を持つため、別のアカウントの要求は互いに待たない。

### D-6: 秘匿情報・データ保存・応答時間 (FR-9, NFR-1, NFR-2)

```ts
// 応答に載せる項目は GatewayAlias の5項目のみ。MailEntry を直接返さない
logger.info({ route: "GET /v1/aliases", count, durationMs }) // 本文・アドレスの一覧・認証情報は出さない
```

| 対象                 | 取り扱い                                           |
| -------------------- | -------------------------------------------------- |
| XREAのパスワード項目 | クライアントが取り除くため、サービスには到達しない |
| 認証情報             | メモリ上のクライアントにのみ保持し、ログに出さない |
| 永続化               | データベースとファイルへの書き込みをしない         |
| ログ                 | ルート名・件数・所要時間・エラーコードのみ         |

| 区間                       | 時間の予算 |
| -------------------------- | ---------- |
| 一覧の取り直し             | 1.5秒      |
| 作成・変更・削除の呼び出し | 2.0秒      |
| 排他の待ち（1件の待機）    | 1.0秒      |
| 合計                       | 4.5秒      |

### D-7: 設定 (FR-7, FR-11)

| 環境変数       | 必須 | 既定値             |
| -------------- | ---- | ------------------ |
| INTERNAL_TOKEN | 必須 | なし（32文字以上） |
| PORT           | 任意 | 8081               |
| BIND_ADDRESS   | 任意 | 0.0.0.0            |
| LOG_LEVEL      | 任意 | info               |

## 3. エラー処理

| 事象                               | 処理                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| INTERNAL_TOKEN が未設定または短い  | 変数名を示して異常終了する                               |
| 要求の本文が不正なJSON             | 400 validation_error を返す                              |
| XREAがメッセージ付きでエラーを返す | 502 upstream_error を返し、メッセージを message に載せる |
| XREAの送信間隔の超過               | 503 rate_limited を返し、再試行を促す                    |
| 想定外の例外                       | 500 を返し、詳細をログにのみ記録する                     |
