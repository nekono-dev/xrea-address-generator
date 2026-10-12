# Proton Pass 読み取りサービス 設計書

## 1. 構成

| パス                               | 責務                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| `src/reader/main.ts`               | 設定の読み込みと起動                                  |
| `src/reader/config.ts`             | 環境変数の読み込みと検証                              |
| `src/reader/app.ts`                | ルーティング、共有シークレットの検査、応答の組み立て  |
| `src/reader/tenants.ts`            | トークンごとの読み取り部品の保持と破棄                |
| `src/reader/cli.ts`                | 公式CLIの実行（許可リスト、環境変数の限定、打ち切り） |
| `src/reader/session.ts`            | ログインと、セッション失効時の再ログイン              |
| `src/reader/projection.ts`         | アイテム一覧から対応表への変換と、秘匿情報の破棄      |
| `src/reader/cache.ts`              | キャッシュ、再取得の合流、状態の管理                  |
| `tests/reader/cli.test.ts`         | 許可リストと打ち切りの単体テスト                      |
| `tests/reader/projection.test.ts`  | 対応表の変換と秘匿情報の単体テスト                    |
| `tests/reader/cache.test.ts`       | キャッシュ・再取得・再ログインの単体テスト            |
| `tests/reader/http.test.ts`        | 認証・トークンの分離・応答の項目・破棄のテスト        |
| `tests/fixtures/proton-items.json` | 秘匿情報を含む疑似のアイテム一覧                      |

## 2. 設計項目

### D-1: 公式CLIの実行 (FR-1, FR-5, NFR-4)

```ts
const ALLOWED = [
  ["login"],
  ["info"],
  ["vault", "list"],
  ["item", "list"],
] as const
const TIMEOUT_MS = 60_000

export function createCliRunner(s: {
  token: string
  sessionDir: string
  bin?: string
}): CliRunner {
  return (args) => {
    if (!ALLOWED.some((a) => a.every((w, i) => args[i] === w)))
      return Promise.reject(new ForbiddenCommandError(args[0]))
    return execFile(s.bin ?? "pass-cli", args, {
      env: cliEnv(s),
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    })
  }
}
```

| 渡す環境変数                      | 値                                           |
| --------------------------------- | -------------------------------------------- |
| PATH、HOME                        | 実行環境の値                                 |
| PROTON_PASS_PERSONAL_ACCESS_TOKEN | 要求ヘッダのトークン（実行ごとに渡す）       |
| PROTON_PASS_KEY_PROVIDER          | fs（鍵をファイルに保存する）                 |
| PROTON_PASS_SESSION_DIR           | SESSION_DIR 配下のトークンごとのディレクトリ |
| PROTON_PASS_DISABLE_TELEMETRY     | 1                                            |
| PROTON_PASS_NO_UPDATE_CHECK       | 1                                            |

許可リストに無いサブコマンド（作成・更新・削除・移動・共有の全て）は、実行前に拒否する。セッションの保存物（session.json、pass-cli.db、鍵ファイル）は、PROTON_PASS_SESSION_DIR 直下の隠しディレクトリ .session にだけ置かれ、HOME には書かれない（検証サーバで確認済み）。保存先を分けたトークン同士は、一方のログインが他方に影響せず、並列の実行も互いに妨げない。コンテナの他の環境変数（INTERNAL_TOKEN を含む）は渡さない。

### D-2: ログインと再ログイン (FR-8, FR-10)

```ts
export type ReaderState = "loading" | "ready" | "relogin" | "error"
export type ErrorKind = "token" | "permission" | "timeout" | "cli" | "unknown"

export class Session {
  login(): Promise<void> // セッション保存先を作り（権限 0700）、トークンでログインする
  ensure(): Promise<void> // info が成功すれば何もしない。セッションが無ければ login を1回実行する
  withSession<T>(task: () => Promise<T>, onRelogin: () => void): Promise<T> // セッション失効のときだけ再ログインし、1回だけ再試行する
}
```

| 事象                     | 判定                                                                         |
| ------------------------ | ---------------------------------------------------------------------------- |
| セッションなし・失効     | 標準エラーに「requires an authenticated client」を含む（終了コード1）        |
| トークンの期限切れ・失効 | 標準エラーに「invalid, expired or has been deleted」を含む（kind は token）  |
| トークンの形式不正       | 標準エラーに「Failed to parse personal access token」を含む（kind は token） |
| 権限なし                 | 標準エラーに NotAllowed を含む                                               |
| 打ち切り                 | 実行が60秒を超える（kind は timeout）                                        |
| 上記以外                 | kind は unknown                                                              |

### D-3: 対応表への変換 (FR-2, FR-3, FR-4)

```ts
export type AddressMap = ReadonlyMap<string, readonly string[]> // 小文字のアドレス -> 昇順のエントリ名
export type Projection = { map: AddressMap; itemCount: number }

// 入力の秘匿情報は、この関数のスコープの外へ出さない
export function project(rawJson: string): Projection
export function vaultShareIds(rawJson: string): string[] // vault list の出力から share_id を取り出す
export function mergeProjections(list: readonly Projection[]): Projection // 対応表をまとめ、エントリ名を昇順に並べ、件数を合計する
```

取得は、はじめに `vault list --output json` でトークンが参照できるVaultの共有IDをすべて得て、Vaultごとに `item list --share-id <ID> --filter-state active --output json --show-secrets` を順に実行する。ユーザー名とメールアドレスは、秘匿情報を含む取得でのみ得られる。ログインアイテムのユーザー名とメールアドレスを小文字にして対応表のキーとし、値にはアイテムの題名だけを入れる。

### D-4: キャッシュと状態 (FR-6, FR-7, FR-9, FR-10, NFR-1, NFR-2, NFR-3)

```ts
export type Status = {
  state: ReaderState
  updatedAt: string | null // ISO 8601
  reloginAt: string | null
  itemCount: number | null
  error: { kind: ErrorKind; message: string } | null
}
export class CachedReader {
  getMap(): AddressMap // 有効期間内はメモリから返す。期限切れなら背景で再取得を始め、現在の対応表を返す
  getStatus(): Status
  refresh(): Promise<void> // 実行中の再取得があれば合流する
}
const TTL_MS = 600_000
```

| 状況                 | 動作                                                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| トークンの初回の要求 | 再取得を開始し、状態は loading、対応表は空                                                                                                |
| 有効期間内の取得     | 公式CLIを呼ばずに対応表を返す                                                                                                             |
| 有効期間後の取得     | 背景で再取得を開始し、直前の対応表を返す                                                                                                  |
| 再取得中の refresh   | 実行中の再取得に合流し、トークンごとに公式CLIの同時実行を1件に保つ                                                                        |
| 再取得の失敗         | 直前の対応表を保持し、状態を error にして種別とメッセージを保持する。以後は有効期間が過ぎても自動で再取得せず、更新の要求でだけ再取得する |

### D-5: 秘匿情報の取り扱い (FR-4)

```ts
// ログに出す項目は固定。取得結果の本文や標準エラーの全文は出さない
logger.info({
  cmd: "item list",
  exitCode: 0,
  durationMs,
  itemCount,
  vaultCount,
})
logger.warn({ cmd: "login", exitCode: 1, kind: "token" })

// 応答の組み立て。新しいオブジェクトに許可した項目だけを写す
export function toResponse(map: AddressMap, status: Status): EntriesResponse {
  return {
    status: pickStatus(status),
    entries: Object.fromEntries([...map].map(([a, names]) => [a, [...names]])),
  }
}
```

| 対象                                        | 取り扱い                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| パスワード、URL、メモ、ワンタイムパスワード | 変換関数の戻り値に含めず、変換後に参照を残さない                          |
| Vault名                                     | 応答に含めない                                                            |
| 取得結果の文字列                            | 変換関数の呼び出し側で変数に保持せず、戻り値だけを受け取る                |
| トークン                                    | ログ・状態・エラーメッセージ・応答に含めない。保持キーはSHA-256のハッシュ |
| 標準エラーの内容                            | 種別の判定に使い、メッセージは種別ごとの固定文言に置き換える              |

### D-6: HTTP API と認証 (FR-1, FR-9, FR-11)

| メソッドとパス        | 要求ヘッダ                            | 成功応答                |
| --------------------- | ------------------------------------- | ----------------------- |
| GET /v1/entries       | Authorization: Bearer、X-Proton-Token | 200 { status, entries } |
| POST /v1/refresh      | Authorization: Bearer、X-Proton-Token | 202                     |
| GET /healthz, /health | なし                                  | 200 { ok: true }        |

```ts
export type EntriesResponse = {
  status: Status
  entries: Record<string, string[]>
} // アドレス -> エントリ名の昇順
```

共有シークレットは INTERNAL_TOKEN と定数時間で比較する。GET /v1/entries は待たずに現在の状態と対応表を返す。

### D-7: トークンごとの保持と破棄 (FR-12, NFR-5)

```ts
export class Tenants {
  constructor(
    private max = 20,
    private baseDir: string,
  ) {}
  /** key = sha256(token) の先頭32文字の16進。無ければ作り、再取得を開始する */
  get(token: string): CachedReader
  /** max を超えたら最も古く使われたものを破棄し、そのセッション保存先 baseDir/<key> を再帰的に削除する */
  private evict(): void
}
```

| 環境変数       | 必須 | 既定値                                |
| -------------- | ---- | ------------------------------------- |
| INTERNAL_TOKEN | 必須 | なし（32文字以上）                    |
| SESSION_DIR    | 任意 | /var/lib/xrea-alias-dashboard/session |
| MAX_TENANTS    | 任意 | 20                                    |
| PORT           | 任意 | 8082                                  |
| BIND_ADDRESS   | 任意 | 0.0.0.0                               |
| LOG_LEVEL      | 任意 | info                                  |

## 3. エラー処理

| 事象                         | 処理                                                                                                                        |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| INTERNAL_TOKEN が未設定      | 変数名を示して異常終了する                                                                                                  |
| 参照できるVaultが無い        | 空の対応表で状態を ready（参照件数は 0）にする                                                                              |
| 再ログインにも失敗           | 状態を error にし、直前の対応表を保持する                                                                                   |
| 許可されていないサブコマンド | ForbiddenCommandError を送出し、公式CLIを起動しない                                                                         |
| 公式CLIの実行が60秒を超える  | プロセスを終了し、状態を error（kind は timeout）にする                                                                     |
| トークンが無効・期限切れ     | kind を token にし、メッセージは「Proton Passのアクセストークンが無効か、期限切れです。トークンを差し替えてください」にする |
