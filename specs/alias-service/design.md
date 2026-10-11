# エイリアスサービス 設計書

## 1. 構成

| パス                                | 責務                                             |
| ----------------------------------- | ------------------------------------------------ |
| `src/server/main.ts`                | 設定の読み込み、各部品の組み立て、起動           |
| `src/server/config.ts`              | 環境変数の読み込みと検証                         |
| `src/server/app.ts`                 | ルーティング、エラー応答、画面ファイルの配信     |
| `src/server/aliasService.ts`        | 一覧の合成、発行、転送先の変更、削除、候補の導出 |
| `src/server/validate.ts`            | 発行の入力の検証                                 |
| `src/server/randomName.ts`          | ランダムな名前の生成                             |
| `src/server/words.ts`               | ランダム名に使う単語の辞書                       |
| `src/server/listCache.ts`           | XREAの一覧のキャッシュ                           |
| `src/server/mutex.ts`               | 変更要求の直列化                                 |
| `tests/server/aliasService.test.ts` | 一覧・発行・転送先の変更・削除の単体テスト       |
| `tests/server/http.test.ts`         | HTTPの入出力と配信のテスト                       |
| `tests/server/live.test.ts`         | 実際のAPIに対する発行と削除のテスト              |

## 2. 設計項目

### D-1: HTTP API (FR-2, FR-11)

| メソッドとパス               | 要求                            | 成功応答                             |
| ---------------------------- | ------------------------------- | ------------------------------------ |
| GET /api/aliases             | なし                            | 200 { aliases, proton }              |
| POST /api/aliases            | { name?, domain, forwardTo }    | 201 { alias }                        |
| PATCH /api/aliases/:address  | { forwardTo }                   | 200 { alias }                        |
| DELETE /api/aliases/:address | アドレスをURLエンコードしたパス | 204                                  |
| GET /api/options             | なし                            | 200 { domains, forwardTargets }      |
| GET /api/proton/status       | なし                            | 200 ProtonStatus                     |
| POST /api/proton/refresh     | なし                            | 202                                  |
| GET /healthz                 | なし                            | 200 { ok: true }                     |
| GET /（その他のパス）        | なし                            | 画面ファイル（存在しなければ index） |

```ts
export type Alias = {
  address: string
  name: string
  domain: string
  forwardTo: string
  protonEntries: string[]
}
export type ApiError = { error: { code: ErrorCode; message: string } }
export type ErrorCode =
  | "validation_error"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "upstream_error"
  | "rate_limited"
```

| ErrorCode        | HTTP | 発生条件                     |
| ---------------- | ---- | ---------------------------- |
| validation_error | 400  | 入力が規則に反する           |
| forbidden        | 403  | 転送のみ以外の変更・削除     |
| not_found        | 404  | 変更・削除の対象が存在しない |
| conflict         | 409  | 同一アドレスがすでに存在する |
| rate_limited     | 503  | XREAが送信間隔の超過を返した |
| upstream_error   | 502  | XREAまたはネットワークの異常 |

画面ファイルは、サーバの実行ファイルの位置から見た `../web`（ビルド後の `dist/web`）から配信する。作業ディレクトリには依存しない。`/api` と `/healthz` 以外で該当ファイルが無いパスは、画面の入口ファイルを返す。

```ts
// 設定の読み込み。トークン未設定のProton Pass連携は null（無効）にし、待ち受けアドレスの既定値をトンネルの有無で決める
proton: loadProtonConfig(env), // PROTON_PASS_PERSONAL_ACCESS_TOKEN が未設定または空なら null
bindAddress: env.BIND_ADDRESS || (env.TUNNEL_TOKEN ? "127.0.0.1" : "0.0.0.0"),
```

| 環境変数                                            | 必須 | 既定値                                                  |
| --------------------------------------------------- | ---- | ------------------------------------------------------- |
| XREA_ACCOUNT・XREA_SERVER_NAME・XREA_API_SECRET_KEY | 必須 | なし                                                    |
| PROTON_PASS_PERSONAL_ACCESS_TOKEN                   | 任意 | なし（未設定または空ならProton Pass連携を無効にする）   |
| TUNNEL_TOKEN                                        | 任意 | なし（BIND_ADDRESS の既定値を決めるためだけに参照する） |
| BIND_ADDRESS                                        | 任意 | TUNNEL_TOKEN があれば 127.0.0.1、無ければ 0.0.0.0       |
| PORT                                                | 任意 | 3000                                                    |
| SESSION_DIR                                         | 任意 | /var/lib/xrea-address-generator/session                 |
| LOG_LEVEL                                           | 任意 | info                                                    |

### D-2: 一覧の合成 (FR-1, FR-2, FR-3)

```ts
export async function listAliases(): Promise<{
  aliases: Alias[]
  proton: ProtonStatus
}> {
  const mails = await listCache.get() // XREAの一覧（正規化済み）
  const entries = proton.getMap() // 待たずに現在の対応表を取る
  const aliases = mails
    .filter((m) => [1, 2, 3].includes(m.pop_how)) // 破棄以外を残す
    .map((m) => {
      const address = `${m.address_name}@${m.address_domain}`.toLowerCase()
      return {
        address,
        name: m.address_name,
        domain: m.address_domain,
        forwardTo: m.address_trans,
        protonEntries: [...(entries.get(address) ?? [])],
        mailbox: m.pop_how === 2 || m.pop_how === 3, // メールボックスを持つ（表示のみで、変更・削除はできない）
      }
    })
  return { aliases, proton: proton.getStatus() }
}
```

| 受信方法の値 | 意味             | 一覧への掲載 | mailbox |
| ------------ | ---------------- | ------------ | ------- |
| 1            | 転送のみ         | 掲載する     | false   |
| 2            | 受信のみ         | 掲載する     | true    |
| 3            | 転送と受信の両方 | 掲載する     | true    |
| 4            | 破棄             | 掲載しない   | -       |

### D-3: 発行 (FR-4, FR-5, FR-6, FR-7)

```ts
export type CreateInput = { name?: string; domain: string; forwardTo: string }

export function validate(input: CreateInput, domains: string[]): string[] // 違反の説明の配列
const NAME_RE = /^[a-z0-9]([a-z0-9._-]{0,47}[a-z0-9])?$/ // 1〜49文字。XREAは50文字以上を拒否する
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// 追加の規則: 連続するピリオドを含まない。名前は小文字に正規化してから検証する（XREAも小文字で保存する）

export function randomName(
  words: readonly string[],
  rnd: () => number,
): string {
  const w = () => words[Math.floor(rnd() * words.length)]
  return `${w()}.${w()}${10 + Math.floor(rnd() * 90)}`
}
```

発行の手順を次に示す。

| 手順 | 処理                                                        |
| ---- | ----------------------------------------------------------- |
| 1    | 変更要求の排他を取得する                                    |
| 2    | XREAの一覧を取り直し、ドメインの候補を導出する              |
| 3    | 入力を検証する。違反があれば400                             |
| 4    | 名前が空なら生成する。一覧と衝突したら最大5回まで再生成する |
| 5    | 同名のアドレスがあれば409                                   |
| 6    | XREAへ転送のみのアドレスの作成を要求する                    |
| 7    | 一覧のキャッシュを破棄し、作成したアドレスを201で返す       |

単語の辞書は、小文字の英単語256語を `words.ts` に固定で持つ。

### D-4: 削除 (FR-8)

```ts
export async function deleteAlias(address: string): Promise<void> {
  return mutex.run(async () => {
    const mails = await listCache.fresh() // 取り直した一覧
    const target = mails.find(
      (m) =>
        `${m.address_name}@${m.address_domain}`.toLowerCase() ===
        address.toLowerCase(),
    )
    if (!target) throw new AppError("not_found")
    if (target.pop_how !== 1) throw new AppError("forbidden")
    await xrea.mailDelete([target.no]) // 直前の一覧の番号だけを使う
    listCache.invalidate()
  })
}
```

| 事象                             | 応答                                                 |
| -------------------------------- | ---------------------------------------------------- |
| 一覧に存在しない                 | 404                                                  |
| 受信方法が転送のみ以外           | 403                                                  |
| 番号が一覧の取得後に変わっていた | 削除は一覧の取得直後に行うため、番号のずれは起きない |

### D-5: 候補の導出 (FR-9)

```ts
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

ドメインの候補は、受信方法を問わずすべてのアドレスのドメインから導出する。転送先の候補は、転送先が空でないすべてのアドレスから導出する。

### D-6: Proton Passの状態 (FR-3)

```ts
// GET /api/proton/status
return proton.getStatus()
// POST /api/proton/refresh
void proton.refresh() // 完了を待たずに 202 を返す
```

| 状態     | 画面へ伝える意味                           |
| -------- | ------------------------------------------ |
| loading  | 取得中                                     |
| relogin  | セッション失効による再ログイン中           |
| ready    | 照合結果が利用できる                       |
| error    | 取得に失敗した。種別とメッセージを伴う     |
| disabled | アクセストークンが未設定で、連携を使わない |

### D-7: キャッシュ・排他・応答時間 (NFR-1, NFR-2, NFR-3, NFR-4)

```ts
export class ListCache {
  constructor(private ttlMs = 30_000) {}
  get(): Promise<MailEntry[]> // 有効期間内はメモリから返す
  fresh(): Promise<MailEntry[]> // 常にXREAから取り直す
  invalidate(): void // 発行・転送先の変更・削除の成功時に呼ぶ
}
export class Mutex {
  run<T>(task: () => Promise<T>): Promise<T>
} // 到着順に1件ずつ実行する
```

| 区間                       | 時間の予算 |
| -------------------------- | ---------- |
| 一覧の取り直し             | 1.5秒      |
| 作成・変更・削除の呼び出し | 2.0秒      |
| 排他の待ち（1件の待機）    | 1.0秒      |
| 合計                       | 4.5秒      |

### D-8: 秘匿情報とデータ保存 (FR-10)

```ts
// 応答に載せる項目は Alias の5項目のみ。MailEntry を直接返さない
const toAlias = (m: MailEntry, entries: AddressMap): Alias => ({
  /* D-2 と同じ5項目 */
})
logger.info({ route: "GET /api/aliases", count }) // 本文・アドレスの一覧は出さない
```

| 対象                 | 取り扱い                                           |
| -------------------- | -------------------------------------------------- |
| XREAのパスワード項目 | クライアントが取り除くため、サービスには到達しない |
| 永続化               | データベースとファイルへの書き込みをしない         |
| ログ                 | ルート名・件数・所要時間・エラーコードのみ         |

### D-9: 転送先の変更 (FR-12)

```ts
export async function changeForward(
  address: string,
  forwardTo: string,
): Promise<Alias> {
  if (!MAIL_RE.test(forwardTo.trim())) throw new AppError("validation_error")
  return mutex.run(async () => {
    let target: MailEntry | undefined
    // 一覧の取り直し・アドレスの解決・送信はクライアントが続けて行う（番号のずれを防ぐ）
    await xrea.mailChangeForward(address, forwardTo.trim(), (m) => {
      if (!m) throw new AppError("not_found")
      if (m.pop_how !== 1) throw new AppError("forbidden")
      target = m
    })
    listCache.invalidate()
    return toAlias(
      { ...target, address_trans: forwardTo.trim() },
      proton.getMap(),
    )
  })
}
```

| 事象                     | 応答                          |
| ------------------------ | ----------------------------- |
| 転送先がメール形式でない | 400（排他の取得前に判定する） |
| 一覧に存在しない         | 404                           |
| 受信方法が転送のみ以外   | 403                           |
| 現在と同じ転送先         | XREAへ送信して200を返す       |

応答の項目は、解決したアドレスの項目の転送先を差し替えて組み立てる（一覧を再び取得しない）。

## 3. エラー処理

| 事象                               | 処理                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| 必須の環境変数が未設定             | 不足している変数名を示して異常終了する                   |
| 要求の本文が不正なJSON             | 400 validation_error を返す                              |
| XREAがメッセージ付きでエラーを返す | 502 upstream_error を返し、メッセージを message に載せる |
| XREAの送信間隔の超過               | 503 rate_limited を返し、再試行を促す                    |
| Proton Passの取得に失敗            | 一覧は返し、照合の状態を error にする                    |
| 想定外の例外                       | 500 を返し、詳細をログにのみ記録する                     |
