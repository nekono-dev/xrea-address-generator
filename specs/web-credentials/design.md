# 認証情報の登録画面 設計書

## 1. 構成

| パス                                       | 責務                                           |
| ------------------------------------------ | ---------------------------------------------- |
| `web/src/credentials.ts`                   | 登録状態の保持と、問い合わせ・登録の呼び出し   |
| `web/src/components/CredentialsPanel.tsx`  | 登録画面のパネルと、入力・送信・失敗の表示     |
| `web/src/components/CredentialsButton.tsx` | ヘッダの認証情報ボタン                         |
| `web/src/components/Combobox.tsx`          | 候補つき入力部品（メール用とサーバ名用で共用） |
| `web/src/App.tsx`                          | 登録状態による主画面と登録画面の切り替え       |
| `web/src/api.ts`                           | 登録の要求と、登録を求める応答の通知           |
| `web/src/styles.css`                       | 登録画面のスタイル                             |
| `tests/web/credentials.test.tsx`           | 登録状態・入力検査・送信の単体テスト           |
| `tests/e2e/credentials.spec.ts`            | 登録・失敗・期限切れ・置き換えのブラウザテスト |

## 2. 設計項目

### D-1: 登録状態と通信 (FR-1, FR-7, FR-9)

```ts
export type CredentialState = "unknown" | "missing" | "expired" | "registered"
export type RegisterBody = {
  xrea: { account: string; serverName: string; apiSecretKey: string }
  protonToken?: string
}

export const credentialsApi = {
  status: () =>
    get<{ registered: boolean; proton?: boolean; expiresAt?: string }>(
      "/api/credentials",
    ),
  register: (b: RegisterBody) => put<void>("/api/credentials", b),
}

// api.ts の共通処理。code が credentials_required の応答を受けたら、購読者へ通知する
export function onCredentialsRequired(fn: () => void): () => void
```

| 起点                                      | 遷移                                      |
| ----------------------------------------- | ----------------------------------------- |
| 起動時の問い合わせで registered が false  | unknown → missing                         |
| 起動時の問い合わせで registered が true   | unknown → registered                      |
| 主画面のAPIが credentials_required を返す | registered → expired                      |
| 登録の成功                                | missing・expired・registered → registered |

入力した値は、パネルのコンポーネントの状態にのみ保持し、localStorage・sessionStorage・IndexedDB・URLに書き込まない。unknown の間は何も描画しない。

### D-2: 入力フォーム (FR-2, FR-3, FR-4)

```tsx
<label>
  サーバ名
  <input name="server" autoComplete="off" value={serverName} onKeyDown={enterToSubmit} required />
</label>
<form onSubmit={submit}>
  <label>
    アカウント
    <input name="username" autoComplete="username" value={account} required />
  </label>
  <label>
    シークレットキー
    <input name="password" type="password" autoComplete="current-password" value={key} required />
  </label>
  <button type="submit" disabled={!canSubmit}>登録</button>
</form>
{proton ? (
  <label>Proton Pass アクセストークン（任意）<input name="proton-token" type="password" autoComplete="off" onKeyDown={enterToSubmit} /></label>
) : (
  <button type="button" onClick={() => setProton(true)}>Proton Pass連携を使う</button>
)}
```

サーバ名の欄とトークンの欄は、パスワードマネージャの分類を崩さないよう、フォーム要素の外に置き、フォーム属性で関連づけない。この2欄で Enter を押したときは、同じ送信の処理を呼ぶ。送信時にまとめて要求へ載せる。登録ボタンは、アカウント・シークレットキー・サーバ名の3項目がすべて空白以外を含むとき有効にする。

| 欄               | 型       | autocomplete     | 備考                             |
| ---------------- | -------- | ---------------- | -------------------------------- |
| アカウント       | text     | username         | フォームの中                     |
| シークレットキー | password | current-password | フォームの中                     |
| サーバ名         | text     | off              | フォームの外                     |
| アクセストークン | password | off              | ボタン押下後に追加。フォームの外 |

パスワードマネージャによる自動入力は、実機で確認する手順を E2E の手動確認として記録する。

### D-3: 送信と失敗 (FR-5, FR-6)

```ts
async function submit(): Promise<void> {
  setBusy(true)
  setError(null)
  try {
    await credentialsApi.register({
      xrea: { account, serverName, apiSecretKey },
      ...(token ? { protonToken: token } : {}),
    })
    onRegistered() // 登録画面を閉じ、一覧と候補を取得する
  } catch (e) {
    setError((e as ApiError).message) // 入力値は消さない
  } finally {
    setBusy(false)
  }
}
```

| 応答                    | 表示                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| 204                     | パネルを閉じて主画面を表示する                                     |
| 400 invalid_credentials | メッセージ「XREAの認証情報を確認できませんでした」をパネル内に表示 |
| 400 validation_error    | サーバのメッセージをパネル内に表示                                 |
| 502 upstream_error      | サーバのメッセージをパネル内に表示                                 |
| 通信の失敗              | 「サーバへ接続できません」をパネル内に表示                         |

### D-4: 期限切れと置き換え (FR-7, FR-8)

```tsx
// App.tsx の切り替え
if (state === "unknown") return null
if (state !== "registered" || editing) {
  return (
    <CredentialsPanel
      notice={
        state === "expired"
          ? "認証情報の有効期限が切れました。もう一度登録してください"
          : null
      }
      onCancel={state === "registered" ? () => setEditing(false) : undefined}
    />
  )
}
return <Main header={<CredentialsButton onClick={() => setEditing(true)} />} />
```

| 状態                   | パネルの案内   | 取り消し |
| ---------------------- | -------------- | -------- |
| missing                | なし           | なし     |
| expired                | 期限切れの案内 | なし     |
| registered（置き換え） | なし           | あり     |

### D-5: 表示とキーボード操作 (FR-10, NFR-1, NFR-2, NFR-3)

| 項目         | 内容                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------ |
| 描画         | ダイアログ要素を使わず、main 内のパネルとして描画する                                                        |
| 寸法         | 入力欄・ボタンの高さは CSS 変数 --h（幅680ピクセル以上で38、未満で44）を使う                                 |
| 文字の大きさ | 入力欄は --fs（15または18ピクセル）。タッチ操作の端末では16ピクセル以上に固定する                            |
| 幅           | パネルの幅は min(100%, 28rem)。長い値は入力欄の中で横にスクロールさせる                                      |
| 操作         | Tab で サーバ名 → アカウント → シークレットキー → 登録 → 連携ボタンの順に移動し、いずれの欄でも Enter で送信 |

### D-6: サーバ名の選択 (FR-11)

```ts
export const credentialsApi = { servers: () => request<{ servers: string[] }>("GET", "/api/servers") /* ほか */ }
// 既存の候補つき入力部品を、メール専用の検査と文言を差し替えられる形に一般化して使う
<Combobox name="server" label="サーバ名" placeholder="検索して選択" candidates={servers}
  invalid={servers.length > 0 && serverName.trim() !== "" && !servers.includes(serverName.trim())}
  noneText="該当するサーバがありません" onEnter={submit} />
// canRegister: 一覧が空（取得に失敗）のときは、一覧への所属を問わない
```

入力部品はフォームの外に置く規則を保つ。一覧は登録画面の表示時に1回取得する。入力は部分一致（大文字小文字を区別しない）で絞り込み、候補の選択で欄に値が入る。

## 3. エラー処理

| 事象                       | 処理                                                     |
| -------------------------- | -------------------------------------------------------- |
| 登録状態の問い合わせの失敗 | 登録画面を表示し、通信の失敗のメッセージをパネル内に出す |
| 登録の要求中の再送信       | busy の間は登録ボタンを無効にして二重の送信を防ぐ        |
| 取り消し時の入力値         | 破棄する（保存しない）                                   |
| サーバ名の一覧の取得の失敗 | 自由入力にして、登録を妨げない                           |
