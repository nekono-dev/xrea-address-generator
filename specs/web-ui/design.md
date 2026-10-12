# 発行・管理画面 設計書

## 1. 構成

| パス                                 | 責務                                             |
| ------------------------------------ | ------------------------------------------------ |
| `web/index.html`                     | 画面の入口                                       |
| `web/src/main.tsx`                   | 起動と描画                                       |
| `web/src/App.tsx`                    | 画面全体の組み立て                               |
| `web/src/api.ts`                     | サーバとの通信と型                               |
| `web/src/store.ts`                   | 状態の保持（一覧、候補、絞り込み、並び順、通知） |
| `web/src/prefs.ts`                   | 選択した値のブラウザへの保存と復元               |
| `web/src/components/Dropdown.tsx`    | 独自のドロップダウン                             |
| `web/src/components/Combobox.tsx`    | 自由入力つきの候補選択                           |
| `web/src/components/Segmented.tsx`   | 排他選択のボタン群                               |
| `web/src/components/Toast.tsx`       | 通知                                             |
| `web/src/components/Banner.tsx`      | 再ログインの帯                                   |
| `web/src/components/IssueForm.tsx`   | 発行フォーム（ドメインは自由入力つきの候補選択） |
| `web/src/components/AliasList.tsx`   | 一覧と行の操作                                   |
| `web/src/components/ForwardEdit.tsx` | 行内の転送先の変更                               |
| `web/src/styles.css`                 | 寸法・配色の定義と全部品のスタイル               |
| `tests/web/components.test.tsx`      | 部品の単体テスト                                 |
| `tests/web/prefs.test.ts`            | 保存と復元の単体テスト                           |
| `tests/e2e/issue.spec.ts`            | 発行の操作のブラウザテスト                       |
| `tests/e2e/list.spec.ts`             | 一覧の操作のブラウザテスト                       |
| `tests/e2e/mobile.spec.ts`           | 幅ごとの寸法・文字の大きさのブラウザテスト       |
| `tests/e2e/prefs.spec.ts`            | 保存した値の復元のブラウザテスト                 |
| `tests/e2e/proton.spec.ts`           | 照合状態の通知のブラウザテスト                   |

## 2. 設計項目

### D-1: 通信と型 (FR-4, FR-11)

```ts
// 型（Alias・ProtonStatus・Options）はサーバの応答と同じ形で定義する
const enc = encodeURIComponent
export const api = {
  list: () => get<ListResponse>("/api/aliases"),
  options: () => get<Options>("/api/options"),
  create: (b: CreateBody) => post<{ alias: Alias }>("/api/aliases", b),
  removeForward: (address: string) =>
    request<{ alias: Alias }>(
      "DELETE",
      `/api/aliases/${encodeURIComponent(address)}/forward`,
    ),
  changeForward: (address: string, forwardTo: string) =>
    patch<{ alias: Alias }>(`/api/aliases/${enc(address)}`, { forwardTo }),
  remove: (address: string) => del(`/api/aliases/${enc(address)}`),
  protonStatus: () => get<ProtonStatus>("/api/proton/status"),
  protonRefresh: () => post<void>("/api/proton/refresh", {}),
}
```

| 応答                        | 動作                                                       |
| --------------------------- | ---------------------------------------------------------- |
| 2xx                         | 本文を返す                                                 |
| 4xx・5xx で ApiError の本文 | message を持つ例外を送出し、呼び出し側が通知として表示する |
| 通信の失敗                  | 「サーバへ接続できません」を通知する                       |

### D-2: 固定表示・寸法・文字の大きさ (FR-1, NFR-1, NFR-2, NFR-4, NFR-5, NFR-6)

| 変数    | 幅680ピクセル以上 | 幅680ピクセル未満 | 用途                               |
| ------- | ----------------- | ----------------- | ---------------------------------- |
| --h     | 38px              | 44px              | 入力欄・ボタン・選択の高さ         |
| --fs    | 15px              | 18px              | 本文・入力欄                       |
| --fs-m  | 14px              | 17px              | 通知・空の一覧の文言               |
| --fs-s  | 13px              | 16px              | 見出し・帯・行の操作ボタン・ラベル |
| --fs-xs | 12px              | 14px              | 照合状態・エントリ名・並び替え     |

```css
@media (max-width: 679.98px) {
  :root {
    --h: 44px;
    --fs: 18px;
    --fs-m: 17px;
    --fs-s: 16px;
    --fs-xs: 14px;
  }
  .line {
    flex-wrap: wrap;
  }
  .btn {
    flex: 1 0 100%;
  }
}
/* iOS のフォーカス時の拡大を防ぐ */
@media (pointer: coarse) {
  input {
    font-size: max(16px, var(--fs));
  }
}
```

| 方針               | 内容                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------- |
| 固定表示           | 全幅の帯（sticky）の中に中央寄せの内容領域を置き、帯自身が背景を持つ                  |
| 見切れの防止       | 候補リストを含む固定領域の祖先に、overflow の制限・clip-path・contain を指定しない    |
| 重なり順           | 固定領域を一覧より前面に置き、候補リストは固定領域の内側の重なり順で前面に出す        |
| 横スクロールの防止 | 文書の幅を広げる指定（負の余白・100vw の拡張）を使わない                              |
| 高さと文字         | 高さと文字の大きさは変数で1か所に定義し、各部品は変数だけを参照する                   |
| 拡大の防止         | 表示の拡大縮小の禁止（maximum-scale）は使わず、入力欄の文字を16ピクセル以上にする     |
| 行の操作ボタン     | 幅680ピクセル未満では、アドレスを全幅で表示するため操作ボタンをアドレスの下の行へ回す |

### D-3: 独自の選択部品 (FR-4, FR-12)

```tsx
type DropdownProps = {
  items: string[]
  value: string
  onChange: (v: string) => void
  label: string
}
// button + ul[role=listbox] で構成する。ネイティブの select は使わない
```

| キー          | 閉じているとき | 開いているとき               |
| ------------- | -------------- | ---------------------------- |
| ArrowDown     | 開く           | 次の項目へ                   |
| ArrowUp       | 開く           | 前の項目へ                   |
| Enter / Space | 開く           | 強調中の項目を選択して閉じる |
| Escape        | なし           | 閉じる                       |

領域外のクリックで閉じる。選択中の項目は aria-selected を付与し、ボタンは aria-expanded を更新する。

### D-4: 転送先の入力部品 (FR-5)

```tsx
const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// input[role=combobox] と候補の ul[role=listbox] で構成する
type Props = {
  value: string
  onInput: (v: string) => void
  candidates: string[]
  onEnter: () => void
  onEscape?: () => void
  label: string
}
const invalid = value.trim() !== "" && !MAIL_RE.test(value.trim())
```

| 操作                       | 動作                                                   |
| -------------------------- | ------------------------------------------------------ |
| フォーカスまたは右端の矢印 | 候補を開く                                             |
| 文字の入力                 | 候補を部分一致で絞り込み、入力値をそのまま保持する     |
| 候補の選択                 | 入力欄へ値を設定して閉じる                             |
| 候補が閉じた状態の Escape  | onEscape を呼ぶ                                        |
| 形式不正                   | 枠を赤くして誤りの文言を表示し、発行ボタンを無効にする |

### D-5: 発行の操作 (FR-2, FR-3, NFR-3)

```ts
async function issue() {
  if (!canIssue) return
  const { alias } = await api.create({
    name: name.trim() || undefined,
    domain,
    forwardTo: target.trim(),
  })
  store.add(alias) // 応答の受信後すぐに一覧へ反映する
  store.flash(alias.address) // 強調表示し、その行までスクロールする
  toast(`${alias.address} を発行しました`)
}
onKeyDown = (e) => {
  if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) issue()
}
```

| 事象         | 動作                                                       |
| ------------ | ---------------------------------------------------------- |
| 発行の成功   | 名前の入力欄を空にし、新しい行を強調表示してスクロールする |
| 発行の失敗   | 入力を保持し、サーバのメッセージを通知する                 |
| 発行の実行中 | 発行ボタンを無効にして二重送信を防ぐ                       |

### D-6: 一覧の表示・絞り込み・並び替え (FR-6, FR-7)

```ts
type SortOrder = "asc" | "desc"
export function view(
  aliases: Alias[],
  domain: string | null,
  order: SortOrder,
): Alias[] {
  return aliases
    .filter((a) => domain === null || a.domain === domain)
    .sort(
      (x, y) => x.address.localeCompare(y.address) * (order === "asc" ? 1 : -1),
    )
}
```

| 要素           | 表示内容                                                                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 見出し         | 「発行済み」と、絞り込み後の件数                                                                                                                                                                   |
| 絞り込み       | 「すべてのドメイン」と各ドメインを選べるドロップダウン                                                                                                                                             |
| 並び替え       | 「A→Z」「Z→A」の2択のボタン群。既定は A→Z                                                                                                                                                          |
| 行             | アドレス、転送先、エントリ名（複数は並べて表示）。エントリが無い行は表示を省く                                                                                                                     |
| メールボックス | mailbox が true の行は、アドレスの横に「メールボックス」の印を付け、転送先が空なら転送先を省く。操作はコピーと、転送先が空なら「転送を追加」、あれば「変更」「転送を解除」にする（削除は出さない） |
| 照合の取得中   | エントリ名の位置に読み込み表示を出す                                                                                                                                                               |

### D-7: コピーと削除の操作 (FR-8)

```ts
function confirmText(a: Alias): string {
  return a.protonEntries.length
    ? `Proton Passに「${a.protonEntries.join("」「")}」があります。メールを削除しますか？`
    : "メールアドレスを削除しますか？"
}
```

| 操作             | 動作                                                           |
| ---------------- | -------------------------------------------------------------- |
| コピーボタン     | クリップボードへ書き込み、成功と失敗のそれぞれを通知する       |
| 削除ボタンの押下 | 行の操作部が、確認文と「削除」「やめる」に切り替わる           |
| 「削除」         | 削除を要求し、成功したら行を取り除き、通知する                 |
| 「やめる」       | 確認を閉じ、何も要求しない。確認の表示時はここへフォーカスする |

### D-8: 照合状態とバナー (FR-10)

```ts
// 照合が loading・relogin の間は5秒間隔で状態を確認する。初回表示（prev が null）では過去の再ログインを通知しない
async function pollProton() {
  const prev = store.proton
  const s = await api.protonStatus()
  store.setProton(s)
  const relogged = s.reloginAt !== prev?.reloginAt
  if (prev && s.state === "ready" && s.reloginAt && relogged)
    toast("Proton Pass に再ログインしました")
  // エントリ名は一覧の応答に含まれるため、照合の完了時に一覧を取り直す
  if (prev && prev.state !== "ready" && s.state === "ready") await reloadList()
  if (s.state === "loading" || s.state === "relogin")
    setTimeout(pollProton, 5000)
}
```

| 状態     | 表示                                                          |
| -------- | ------------------------------------------------------------- |
| loading  | 「Protonを照合中…」と回転表示                                 |
| relogin  | 帯で「セッションが失効したため、再ログインしています…」を表示 |
| ready    | 「Proton照合: N件を参照・HH:MM 更新」と、更新ボタン           |
| error    | 帯で固定の文言を表示し、更新ボタンを残す                      |
| disabled | 照合の行と更新ボタンを出さず、状態の確認を繰り返さない        |

### D-9: 選択した値の保存と復元 (FR-4, FR-5, FR-6)

```ts
const KEY = "xrea-alias-dashboard:prefs"
type Filter = string | null
export type Prefs = {
  domain?: string
  forwardTo?: string
  filter?: Filter
  order?: SortOrder
}
// 読めなければ {} を返す
export function loadPrefs(storage?: Storage): Prefs
// 既存の値へ併合して書く。書けなければ何もしない
export function savePrefs(patch: Prefs, storage?: Storage): void
```

| 値        | 保存の契機                           | 復元の規則                                                                  |
| --------- | ------------------------------------ | --------------------------------------------------------------------------- |
| domain    | 入力値がドメイン名の形式になったとき | 候補の有無によらず初期値にする。無ければ先頭の候補にする                    |
| forwardTo | 入力値がメール形式になったとき       | 候補の有無によらず初期値にする。無ければ先頭の候補にする                    |
| filter    | 絞り込みを選んだとき                 | 一覧の取得後、一覧のドメインに無ければ全件にする                            |
| order     | 並び順を選んだとき                   | asc・desc 以外の値は asc にする。保存先が使えないときは保存せず既定で続ける |

### D-10: 行内の転送先の変更 (FR-9)

```tsx
type Props = { alias: Alias; candidates: string[]; onDone: () => void }
function ForwardEdit({ alias, candidates, onDone }: Props) {
  const [v, setV] = useState(alias.forwardTo)
  const ok = MAIL_RE.test(v.trim()) && !busy
  async function save() {
    const { alias: next } = await api.changeForward(alias.address, v.trim())
    store.add(next) // 同じアドレスの行を置き換える。成功の通知を出して onDone() で閉じる
  } // Combobox（onEnter=save, onEscape=onDone）と「保存」「やめる」のボタンを並べる
}
```

| 操作           | 動作                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 変更ボタン     | 転送先の位置に、現在の転送先を入れた入力部品を開いてフォーカスする。候補はこの時点では開かない                             |
| 保存・Enter    | 変更を要求し、成功したら行の転送先を置き換えて閉じる                                                                       |
| やめる・Escape | 要求を送らずに閉じる                                                                                                       |
| 形式不正       | 枠を赤くし、保存ボタンを無効にする                                                                                         |
| 転送を追加     | メールボックスで転送先が空の行に出す。空の入力部品を開き、保存で同じ変更の要求を送る（成功の通知は「転送を追加しました」） |
| 転送を解除     | 行内で確認し（「転送を解除しますか？受信は続きます」）、承諾で api.removeForward を呼んで、返った項目で行を置き換える      |
| 変更の失敗     | 入力を保持し、サーバのメッセージを通知する                                                                                 |

## 3. エラー処理

| 事象                             | 処理                                               |
| -------------------------------- | -------------------------------------------------- |
| 一覧の取得に失敗                 | 一覧の位置に失敗の表示と再読み込みのボタンを出す   |
| 候補の取得に失敗                 | 発行ボタンを無効にし、理由を通知する               |
| クリップボードへの書き込みの失敗 | 「コピーできませんでした」を通知する               |
| 発行・変更・削除がエラー応答     | サーバのメッセージを通知し、画面の状態は変更しない |
| 通信の失敗                       | 「サーバへ接続できません」を通知する               |
