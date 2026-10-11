# Proton Pass 読み取り 設計書

## 1. 構成

| パス                               | 責務                                                  |
| ---------------------------------- | ----------------------------------------------------- |
| `src/proton/cli.ts`                | 公式CLIの実行（許可リスト、環境変数の限定、打ち切り） |
| `src/proton/session.ts`            | ログインと、セッション失効時の再ログイン              |
| `src/proton/projection.ts`         | アイテム一覧から対応表への変換と、秘匿情報の破棄      |
| `src/proton/cache.ts`              | キャッシュ、再取得の合流、状態の管理                  |
| `src/proton/index.ts`              | 外部へ公開するインターフェース                        |
| `tests/proton/cli.test.ts`         | 許可リストと打ち切りの単体テスト                      |
| `tests/proton/projection.test.ts`  | 対応表の変換と秘匿情報の単体テスト                    |
| `tests/proton/cache.test.ts`       | キャッシュ・再取得・再ログインの単体テスト            |
| `tests/fixtures/proton-items.json` | 秘匿情報を含む疑似のアイテム一覧                      |

## 2. 設計項目

### D-1: 公式CLIの実行 (FR-1, FR-6, NFR-4)

```ts
const ALLOWED = [
  ["login"],
  ["info"],
  ["vault", "list"],
  ["item", "list"],
] as const
const TIMEOUT_MS = 60_000

export async function runCli(
  args: string[],
): Promise<{ stdout: string; durationMs: number }> {
  if (!ALLOWED.some((a) => a.every((w, i) => args[i] === w)))
    throw new ForbiddenCommandError(args[0])
  return execFile("pass-cli", args, {
    env: cliEnv(),
    timeout: TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  })
}

// 公式CLIへ渡す環境変数は次の固定集合のみ
function cliEnv(): NodeJS.ProcessEnv
```

| 渡す環境変数                      | 値                                        |
| --------------------------------- | ----------------------------------------- |
| PATH、HOME                        | 実行環境の値                              |
| PROTON_PASS_PERSONAL_ACCESS_TOKEN | 設定された読み取り専用トークン            |
| PROTON_PASS_KEY_PROVIDER          | fs（鍵をファイルに保存する）              |
| PROTON_PASS_SESSION_DIR           | 設定 SESSION_DIR の値（セッション保存先） |
| PROTON_PASS_DISABLE_TELEMETRY     | 1                                         |
| PROTON_PASS_NO_UPDATE_CHECK       | 1                                         |

許可リストに無いサブコマンド（作成・更新・削除・移動・共有の全て）は、実行前に拒否する。

### D-2: ログインと再ログイン (FR-1, FR-9)

```ts
export type ReaderState = "loading" | "ready" | "relogin" | "error" | "disabled" // アクセストークンが未設定
export type ErrorKind = "token" | "permission" | "timeout" | "cli" | "unknown"

export async function ensureSession(): Promise<void> // info が成功すれば何もしない。失敗なら login を1回実行する
export async function withSession<T>(
  task: () => Promise<T>,
  onRelogin: () => void,
): Promise<T> {
  try {
    return await task()
  } catch (e) {
    if (!isSessionError(e)) throw e
    onRelogin() // 状態を relogin にする
    await login()
    return await task() // 再試行は1回だけ
  }
}
```

| 事象                     | 判定                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| セッションなし・失効     | 標準エラーに「requires an authenticated client」を含む（終了コード1）                          |
| トークンの期限切れ・失効 | ログインが失敗し、標準エラーに「invalid, expired or has been deleted」を含む                   |
| トークンの形式不正       | ログインが失敗し、標準エラーに「Failed to parse personal access token」を含む（kind は token） |
| 権限なし                 | 標準エラーに NotAllowed を含む                                                                 |
| 打ち切り                 | 実行が60秒を超える（kind は timeout）                                                          |
| 上記以外                 | kind は unknown                                                                                |

### D-3: 対応表への変換 (FR-2, FR-3, FR-4, FR-5)

```ts
export type AddressMap = ReadonlyMap<string, readonly string[]> // 小文字のアドレス -> 昇順のエントリ名
export type Projection = { map: AddressMap; itemCount: number } // itemCount は参照したアイテムの総数

// 入力の秘匿情報は、この関数のスコープの外へ出さない
export function project(rawJson: string): Projection {
  const items = (JSON.parse(rawJson).items ?? []) as RawItem[]
  const map = new Map<string, string[]>()
  for (const it of items) {
    const login = it.content?.content?.Login
    if (it.state !== "Active" || !login) continue
    for (const addr of new Set(
      [login.username, login.email]
        .filter(Boolean)
        .map((s) => s.trim().toLowerCase()),
    )) {
      map.set(addr, [...(map.get(addr) ?? []), it.content.title])
    }
  }
  for (const [k, v] of map)
    map.set(
      k,
      v.sort((a, b) => a.localeCompare(b)),
    )
  return { map, itemCount: items.length }
}
```

取得は、はじめに `vault list --output json` でトークンが参照できるVaultの共有IDをすべて得て、Vaultごとに `item list --share-id <ID> --filter-state active --output json --show-secrets` を順に実行する。Vaultの名前は指定しない。ユーザー名とメールアドレスは、秘匿情報を含む取得でのみ得られる。

```ts
export function vaultShareIds(rawJson: string): string[] // vault list の出力から share_id を取り出す
export function mergeProjections(list: readonly Projection[]): Projection // 対応表をまとめ、エントリ名を昇順に並べ、件数を合計する
```

### D-4: キャッシュと状態 (FR-7, FR-8, FR-10, FR-11, FR-12, NFR-1, NFR-2, NFR-3)

```ts
export type Status = {
  state: ReaderState
  updatedAt: string | null // ISO 8601
  reloginAt: string | null // 最後に再ログインした時刻。再ログインが無ければ null
  itemCount: number | null
  error: { kind: ErrorKind; message: string } | null
}
export interface ProtonReader {
  getMap(): AddressMap // 有効期間内はメモリから返す。期限切れなら背景で再取得を始め、現在の対応表を返す
  getStatus(): Status
  refresh(): Promise<void> // 実行中の再取得があれば合流する
}
const TTL_MS = 600_000

// アクセストークンが未設定のときの実装。公式CLIを起動しない
class DisabledReader implements ProtonReader {
  getMap(): AddressMap // 常に空
  getStatus(): Status // state が disabled で、他の項目は null
  refresh(): Promise<void> // 何もしない
}
export function loadProtonConfig(env): ProtonConfig | null // トークンが未設定または空なら null
```

| 状況               | 動作                                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 起動直後           | 再取得を開始し、状態は loading、対応表は空                                                                                                |
| 有効期間内の取得   | 公式CLIを呼ばずに対応表を返す                                                                                                             |
| 有効期間後の取得   | 背景で再取得を開始し、直前の対応表を返す                                                                                                  |
| 再取得中の refresh | 実行中の再取得に合流し、公式CLIの同時実行を1件に保つ                                                                                      |
| 再取得の失敗       | 直前の対応表を保持し、状態を error にして種別とメッセージを保持する。以後は有効期間が過ぎても自動で再取得せず、更新の要求でだけ再取得する |

### D-5: 秘匿情報の取り扱い (FR-5)

```ts
// ログに出す項目は固定。取得結果の本文や標準エラーの全文は出さない
logger.info({
  cmd: "item list",
  exitCode: 0,
  durationMs,
  itemCount,
  vaultCount,
})
logger.info({ cmd: "login", exitCode: 0, durationMs }) // ログインを実行したときだけ
logger.warn({ cmd: "login", exitCode: 1, kind: "token" })
```

| 対象                                        | 取り扱い                                                     |
| ------------------------------------------- | ------------------------------------------------------------ |
| パスワード、URL、メモ、ワンタイムパスワード | 変換関数の戻り値に含めず、変換後に参照を残さない             |
| 取得結果の文字列                            | 変換関数の呼び出し側で変数に保持せず、戻り値だけを受け取る   |
| トークン                                    | 環境変数のみで保持し、ログ・状態・エラーメッセージに含めない |
| 標準エラーの内容                            | 種別の判定に使い、メッセージは種別ごとの固定文言に置き換える |

## 3. エラー処理

| 事象                         | 処理                                                                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| トークンの環境変数が未設定   | 連携を無効にして起動し、状態を disabled にする                                                                                                    |
| 参照できるVaultが無い        | 空の対応表で状態を ready（参照件数は 0）にする                                                                                                    |
| 再ログインにも失敗           | 状態を error にし、直前の対応表を保持する                                                                                                         |
| 許可されていないサブコマンド | ForbiddenCommandError を送出し、公式CLIを起動しない                                                                                               |
| 公式CLIの実行が60秒を超える  | プロセスを終了し、状態を error（kind は timeout）にする                                                                                           |
| トークンが無効・期限切れ     | kind を token にし、メッセージは「Proton Passのアクセストークンが無効か、期限切れです。トークンを差し替えて、サービスを再起動してください」にする |
