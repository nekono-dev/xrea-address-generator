# XREAクライアント 設計書

## 1. 構成

| パス                               | 責務                                           |
| ---------------------------------- | ---------------------------------------------- |
| `scripts/xrea-docs/fetch.ts`       | 公式ドキュメントの取得、基準の保存、差分検知   |
| `scripts/xrea-docs/generate.ts`    | 取得したページから宣言を生成し、補正定義を適用 |
| `api/snapshot`                     | 基準として保存した公式ドキュメントのHTML       |
| `api/overlay.yaml`                 | 公式ドキュメントの誤記を訂正する補正定義       |
| `api/xrea.openapi.yaml`            | 生成した宣言（OpenAPI 3.1）                    |
| `src/xrea/generated/schema.d.ts`   | 宣言から生成した型                             |
| `src/xrea/form.ts`                 | リクエスト項目のフォーム形式への平坦化         |
| `src/xrea/queue.ts`                | エンドポイントごとの直列化と送信間隔の確保     |
| `src/xrea/client.ts`               | 認証項目の付与、送信、応答の正規化             |
| `src/xrea/errors.ts`               | 例外型とエラー応答の変換                       |
| `tests/xrea/contract.live.test.ts` | 実際のAPIに対する契約テスト                    |

## 2. 設計項目

### D-1: ドキュメントの取得と差分検知 (FR-8)

```ts
const BASE = "https://apidoc.xrea.com"
const PAGES = [
  "mail/2017/07/19/mail-list.html",
  "mail/2017/07/19/mail-edit.html",
  "mail/2017/07/19/mail-delete.html",
]
export async function fetchPages(): Promise<Map<string, string>> // ページ名 -> HTML
export function diffAgainstSnapshot(now: Map<string, string>): string[] // 差分のあるページ名
```

| コマンド                | 動作                                                        | 終了コード          |
| ----------------------- | ----------------------------------------------------------- | ------------------- |
| `npm run docs:check`    | 取得したHTMLのSHA-256を基準と比較し、差分ページ名を表示する | 差分なし 0 / あり 1 |
| `npm run docs:snapshot` | 取得したHTMLを基準として保存する                            | 0                   |

基準の比較は、HTMLから空白の連続を1つにまとめた正規化後の文字列に対して行う。

### D-2: 宣言の生成 (FR-1, NFR-2)

| 公式ドキュメントの要素                | 宣言の要素                                             |
| ------------------------------------- | ------------------------------------------------------ |
| 見出しの「POST /v1/mail/edit」        | パスのキーと operationId（v1_mail_edit）               |
| リクエストの表（key/value/type/必須） | requestBody の properties と required                  |
| 表の type 列                          | 型（string は string、int は integer、array は array） |
| 表の備考列                            | description                                            |
| レスポンスの表                        | 200応答のスキーマ                                      |

```ts
export function generate(pages: Map<string, string>, overlay: Overlay): string // YAML文字列
```

出力の決定性は次で担保する。

- パス・プロパティ・required を辞書順に整列する。
- 日時・乱数・環境依存の値を出力へ含めない。
- 改行は LF、末尾に改行を1つ置く。

生成対象のエンドポイントは、固定の許可リスト（メール一覧・作成・削除）に限定する。

### D-3: 補正定義 (FR-2)

補正定義は、生成した宣言に対する JSON Merge Patch（RFC 7386）を YAML で書いたものとし、生成の最終段で適用する。

```yaml
# api/overlay.yaml（抜粋）。グループの項目は「操作名_項目名」の部品として生成される
paths:
  /v1/mail/list:
    post:
      responses:
        "200":
          content:
            application/json:
              schema:
                properties:
                  result:
                    $ref: null
                    type: object
                    additionalProperties:
                      $ref: "#/components/schemas/v1_mail_list_response_result"
components:
  schemas:
    v1_mail_list_response_result:
      properties:
        no: { type: integer }
        quota: { type: string }
        quota_use_byte: { type: [string, integer] }
        pop_how: { enum: [1, 2, 3, 4] }
```

| 補正する内容                                                                              | 理由（実際のAPIで確認した挙動）                                      |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 一覧の result を番号をキーとするオブジェクトにする                                        | 応答は配列でなく {"1": {...}, "2": {...}} の形                       |
| quota を文字列、quota_use_byte・quota_use_per・mail_num を文字列か数値にする              | 応答は数値を文字列で返し、一部は数値と混在する                       |
| 一覧の項目に no と address を加える                                                       | 実際の応答に含まれるが、ドキュメントに記載がない                     |
| 編集の項目に no を加える                                                                  | 番号を省くと新規作成として扱われ、同じアドレスは重複として拒否される |
| reset_flg と box_reset_flg を 0 だけに限る                                                | 1 は送信した値以外の全件削除を引き起こす                             |
| pop_how の意味を 1 転送のみ・2 受信のみ・3 両方・4 破棄に固定する                         | 実アカウントの値と転送先の有無が一致する                             |
| 送信形式をインデックス付きフォームにする                                                  | 項目名は param[0][address_name] の形でのみ受理される                 |
| フィルタの conditions を条件の配列にする                                                  | 単一の条件のオブジェクトは形式不正として拒否される                   |
| 一覧のフィルタを番号キーのオブジェクトか空文字にし、no・header_match・body_match を加える | 応答は {"1": {...}} の形で、未設定のときは空文字を返す               |
| 編集の customd_body に、一覧と同じ番号キーのオブジェクトと空文字を許す                    | 一覧の値をそのまま再送信すると受理される                             |

### D-4: 型の生成 (FR-3)

| スクリプト              | コマンド                                                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run docs:generate` | `tsx scripts/xrea-docs/generate.ts` で宣言を生成する                                                                                            |
| `npm run docs:types`    | `openapi-typescript api/xrea.openapi.yaml --default-non-nullable false -o src/xrea/generated/schema.d.ts`（既定値を持つ項目を必須扱いにしない） |
| `npm run docs:all`      | 生成と型の生成を順に実行する                                                                                                                    |

```ts
import type { paths } from "./generated/schema"
export type MailEditBody =
  paths["/v1/mail/edit"]["post"]["requestBody"]["content"]["application/x-www-form-urlencoded"]
```

### D-5: リクエスト形成 (FR-4)

```ts
// 配列とオブジェクトを再帰的に展開し、インデックス付きの項目名を作る
export function flatten(
  obj: object,
  prefix = "",
  out: [string, string][] = [],
): [string, string][]

// 認証3項目は全リクエストの先頭に付ける
const auth = { account, server_name, api_secret_key }
```

| 呼び出し   | 送信する項目名の例                                                              |
| ---------- | ------------------------------------------------------------------------------- |
| メール作成 | `param[0][address_name]`, `param[0][address_domain]`, `param[0][pop_pass_rand]` |
| メール削除 | `param[no][0]` に削除対象の番号を指定する                                       |
| 全般       | `reset_flg` は 0 を明示して送信し、1 は送信できない型にする                     |

メール作成の既定値は、転送のみ（pop_how=1）、容量0、自動返信・ウイルス・スパム・カスタムの各フィルタ0、パスワードはランダム生成（pop_pass_rand=1）とする。

### D-6: 直列化とタイムアウト (FR-5, NFR-1, NFR-3)

```ts
const MIN_GAP_MS = 1100
const TIMEOUT_MS = 15000
// エンドポイントごとの Promise チェーンに積み、前回送信完了から MIN_GAP_MS 空けて実行する
export class EndpointQueue {
  run<T>(endpoint: string, task: () => Promise<T>): Promise<T>
}
// 送信は AbortSignal.timeout(TIMEOUT_MS) を渡す
```

| 事象                          | 動作                                                     |
| ----------------------------- | -------------------------------------------------------- |
| 同一エンドポイントへ同時に2件 | 2件目は1件目の送信から1100ミリ秒後に送信する             |
| 別エンドポイントへ同時に送信  | 互いに待たず並行して送信する                             |
| 15秒以内に応答が返らない      | 例外 TimeoutError を送出し、次のタスクの待機に影響しない |

### D-7: エラー変換と応答の正規化 (FR-6, FR-7)

```ts
export class XreaError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly kind: "api" | "rate_limit" | "timeout" | "network",
  ) {}
}
// status_code が 200 以外ならエラー。message が空のときは rate_limit として扱う
export function toResult<T>(res: {
  status_code: number
  message?: string
  result?: T
}): T

export type MailEntry = Omit<RawMailEntry, "pop_pass">
export function normalizeList(raw: Record<string, RawMailEntry>): MailEntry[] // 番号の昇順の配列
```

| 応答                            | 変換                                            |
| ------------------------------- | ----------------------------------------------- |
| status_code 200                 | 結果を返す                                      |
| status_code 500 で message あり | kind=api の XreaError（message をそのまま保持） |
| status_code 500 で message なし | kind=rate_limit の XreaError                    |
| 一覧の pop_pass 項目            | 正規化時に削除し、ログにも出力しない            |

### D-8: 契約テスト (FR-9)

```ts
// XREA_LIVE=1 のときだけ実行する
test("xrea-client/AC-9: 作成と削除の後に検証用アドレスが残らない", async () => {
  const name = `poc-${Date.now().toString(36)}`
  try {
    await client.mailCreate({
      name,
      domain: env.XREA_POC_DOMAIN,
      forwardTo: env.XREA_POC_FORWARD_TO,
    })
    expect((await client.mailList()).some((m) => m.address_name === name)).toBe(
      true,
    )
  } finally {
    await deleteByPrefix("poc-") // 直前に取得した一覧の番号で、poc- で始まるものだけ削除する
  }
  expect(
    (await client.mailList()).some((m) => m.address_name.startsWith("poc-")),
  ).toBe(false)
})
```

| 安全装置   | 内容                                   |
| ---------- | -------------------------------------- |
| 実行条件   | XREA_LIVE が 1 のときだけ実行する      |
| 削除の対象 | 名前が poc- で始まるアドレスだけに限る |
| reset_flg  | 常に 0                                 |

転送先の変更の契約テストは、自動返信・ウイルス・スパムの各フィルタを1にし、カスタムフィルタを2件（条件2件と1件）設定した検証用アドレスを作成して行う。変更の前後で一覧の全項目（パスワードはSHA-256の値）を比べ、転送先だけが異なることを確かめる。

### D-9: 転送先の変更 (FR-10)

```ts
// 一覧専用の項目。編集の要求には含めない
const LIST_ONLY = ["mail_num", "quota_use_byte", "quota_use_per"] as const

/** 一覧の項目（番号・パスワード・フィルタを含む）をそのまま使い、転送先だけを差し替える */
export function changeForwardParam(
  raw: RawMailEntry,
  forwardTo: string,
): MailEditParam {
  const param = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !LIST_ONLY.includes(k)),
  )
  return { ...param, address_trans: forwardTo } as MailEditParam
}

class XreaClient {
  /** 一覧を取り直してアドレスを解決し、check の検査を通ったものだけ転送先を変更する */
  async mailChangeForward(
    address: string,
    forwardTo: string,
    check: (entry: MailEntry | undefined) => asserts entry is MailEntry,
  ): Promise<void> {
    const raw = await this.rawList() // パスワード項目を含む。クラスの外へは出さない
    // 名前@ドメインの小文字で照合する
    const entry = raw.find((m) => addressOf(m) === address.toLowerCase())
    check(entry && omitSecret(entry))
    await this.mailEdit({
      reset_flg: 0,
      param: [changeForwardParam(entry, forwardTo)],
    })
  }
}
```

| 実機で確かめた挙動                                 | 設計への反映                                     |
| -------------------------------------------------- | ------------------------------------------------ |
| 番号なしで同じアドレスを送ると「重複しています」   | 一覧の番号を必ず含める                           |
| 必須項目のうち一部だけの送信は拒否される           | 一覧の項目を一覧専用の項目以外すべて送る         |
| パスワードを省くと受理されない                     | 一覧のパスワード（暗号化済みの値）をそのまま送る |
| 一覧の値の再送信で、転送先以外の項目は変わらない   | フィルタ・自動返信は一覧の値をそのまま送る       |
| 削除や変更の後に、ほかのアドレスの番号が変わり得る | 一覧の取得の直後に変更を送信する                 |

## 3. エラー処理

| 事象                                            | 処理                                                       |
| ----------------------------------------------- | ---------------------------------------------------------- |
| 認証情報の環境変数が未設定                      | 起動時に不足している変数名を示して異常終了する             |
| 公式ドキュメントの取得に失敗                    | 失敗したページ名を表示し、基準を上書きせずに異常終了する   |
| ページの表が読み取れない                        | 該当ページ名を示して生成を中止し、出力ファイルを変更しない |
| 重複または形式不正による status_code 500 の応答 | message を保持した XreaError を送出する                    |
| ネットワーク障害                                | kind=network の XreaError を送出し、再送はしない           |
