# 発行・管理画面 設計書

## 1. 構成

| パス                               | 責務                                             |
| ---------------------------------- | ------------------------------------------------ |
| `web/index.html`                   | 画面の入口                                       |
| `web/src/main.tsx`                 | 起動と描画                                       |
| `web/src/App.tsx`                  | 画面全体の組み立て                               |
| `web/src/api.ts`                   | サーバとの通信と型                               |
| `web/src/store.ts`                 | 状態の保持（一覧、候補、絞り込み、並び順、通知） |
| `web/src/components/Dropdown.tsx`  | 独自のドロップダウン                             |
| `web/src/components/Combobox.tsx`  | 自由入力つきの候補選択                           |
| `web/src/components/Segmented.tsx` | 排他選択のボタン群                               |
| `web/src/components/Toast.tsx`     | 通知                                             |
| `web/src/components/Banner.tsx`    | 再ログインの帯                                   |
| `web/src/components/IssueForm.tsx` | 発行フォーム                                     |
| `web/src/components/AliasList.tsx` | 一覧と行の操作                                   |
| `web/src/styles.css`               | 寸法・配色の定義と全部品のスタイル               |
| `tests/web/components.test.tsx`    | 部品の単体テスト                                 |
| `tests/e2e/issue.spec.ts`          | 発行の操作のブラウザテスト                       |
| `tests/e2e/list.spec.ts`           | 一覧の操作のブラウザテスト                       |
| `tests/e2e/proton.spec.ts`         | 照合状態の通知のブラウザテスト                   |

## 2. 設計項目

### D-1: 通信と型 (FR-4, FR-11)

```ts
export type Alias = {
  address: string
  name: string
  domain: string
  forwardTo: string
  protonEntries: string[]
}
export type ProtonStatus = {
  state: "loading" | "ready" | "relogin" | "error"
  updatedAt: string | null
  reloginAt: string | null
  itemCount: number | null
  error: { kind: string; message: string } | null
}
export type ApiError = { error: { code: string; message: string } }

export const api = {
  list: (): Promise<{ aliases: Alias[]; proton: ProtonStatus }> =>
    get("/api/aliases"),
  options: (): Promise<{ domains: string[]; forwardTargets: string[] }> =>
    get("/api/options"),
  create: (b: {
    name?: string
    domain: string
    forwardTo: string
  }): Promise<{ alias: Alias }> => post("/api/aliases", b),
  remove: (address: string): Promise<void> =>
    del(`/api/aliases/${encodeURIComponent(address)}`),
  protonStatus: (): Promise<ProtonStatus> => get("/api/proton/status"),
  protonRefresh: (): Promise<void> => post("/api/proton/refresh", {}),
}
```

| 応答                        | 動作                                                       |
| --------------------------- | ---------------------------------------------------------- |
| 2xx                         | 本文を返す                                                 |
| 4xx・5xx で ApiError の本文 | message を持つ例外を送出し、呼び出し側が通知として表示する |
| 通信の失敗                  | 「サーバへ接続できません」を通知する                       |

### D-2: 発行フォームの固定表示と寸法 (FR-1, NFR-1, NFR-2, NFR-4)

```css
:root {
  --h: 38px;
  --r: 10px;
  --bg: #0f172a;
  --ctl: #1e293b;
  --line: #334155;
  --acc: #38bdf8;
}
.sticky {
  position: sticky;
  top: 0;
  z-index: 20;
  justify-self: stretch;
  background: var(--bg);
  border-bottom: 1px solid var(--line);
}
.sticky .wrap {
  padding-top: 10px;
  padding-bottom: 14px;
}
.dd-menu {
  position: absolute;
  z-index: 10;
}
.fld,
.btn,
.dd-btn {
  height: var(--h);
  box-sizing: border-box;
}
.wrap {
  width: min(680px, 100%);
  padding: 0 16px;
  margin: 0 auto;
}
@media (max-width: 520px) {
  .line {
    flex-wrap: wrap;
  }
  .btn {
    flex: 1 0 100%;
  }
}
```

| 方針               | 内容                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------- |
| 固定表示           | 全幅の帯（sticky）の中に、中央寄せの内容領域を置く。帯自身が背景を持つため、背景の拡張が不要 |
| 見切れの防止       | 候補リストを含む固定領域の祖先に、overflow の制限・clip-path・contain を指定しない           |
| 重なり順           | 固定領域を一覧より前面に置き、候補リストは固定領域の内側の重なり順で前面に出す               |
| 横スクロールの防止 | 文書の幅を広げる指定（負の余白・100vw の拡張）を使わない                                     |
| 高さ               | 入力欄・ボタン・選択の高さは、変数 --h の1か所で定義する                                     |

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
const invalid = value.trim() !== "" && !MAIL_RE.test(value.trim())
const canIssue = value.trim() !== "" && !invalid
```

| 操作                       | 動作                                                   |
| -------------------------- | ------------------------------------------------------ |
| フォーカスまたは右端の矢印 | 候補を開く                                             |
| 文字の入力                 | 候補を部分一致で絞り込み、入力値をそのまま保持する     |
| 候補の選択                 | 入力欄へ値を設定して閉じる                             |
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
  if (e.key === "Enter" && !e.isComposing) issue()
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

| 要素         | 表示内容                                                                       |
| ------------ | ------------------------------------------------------------------------------ |
| 見出し       | 「発行済み」と、絞り込み後の件数                                               |
| 絞り込み     | 「すべてのドメイン」と各ドメインを選べるドロップダウン                         |
| 並び替え     | 「A→Z」「Z→A」の2択のボタン群。既定は A→Z                                      |
| 行           | アドレス、転送先、エントリ名（複数は並べて表示）。エントリが無い行は表示を省く |
| 照合の取得中 | エントリ名の位置に読み込み表示を出す                                           |

### D-7: コピーと削除の操作 (FR-8, FR-9)

```ts
async function copy(a: Alias) {
  try {
    await navigator.clipboard.writeText(a.address)
    toast("コピーしました")
  } catch {
    toast("コピーできませんでした")
  }
}
function confirmText(a: Alias): string {
  return a.protonEntries.length
    ? `Proton Passに「${a.protonEntries.join("」「")}」があります。メールを削除しますか？`
    : "メールアドレスを削除しますか？"
}
```

| 操作             | 動作                                                 |
| ---------------- | ---------------------------------------------------- |
| 削除ボタンの押下 | 行の操作部が、確認文と「削除」「やめる」に切り替わる |
| 「削除」         | 削除を要求し、成功したら行を取り除き、通知する       |
| 「やめる」       | 確認を閉じ、何も要求しない                           |

### D-8: 照合状態とバナー (FR-10)

```ts
// 照合が loading・relogin の間は5秒間隔で状態を確認する
// 再ログインの通知は reloginAt の変化で判定し、5秒間隔の間に完了した再ログインも見逃さない
async function pollProton() {
  const prev = store.proton // 初回表示（prev が null）では、過去の再ログインを通知しない
  const s = await api.protonStatus()
  store.setProton(s)
  if (
    prev &&
    s.state === "ready" &&
    s.reloginAt &&
    s.reloginAt !== prev.reloginAt
  )
    toast("Proton Pass に再ログインしました")
  // 照合が完了したら一覧を取り直す（エントリ名は一覧の応答に含まれるため）
  if (prev && prev.state !== "ready" && s.state === "ready") await reloadList()
  if (s.state === "loading" || s.state === "relogin")
    setTimeout(pollProton, 5000)
}
```

| 状態    | 表示                                                          |
| ------- | ------------------------------------------------------------- |
| loading | 「Protonを照合中…」と回転表示                                 |
| relogin | 帯で「セッションが失効したため、再ログインしています…」を表示 |
| ready   | 「Proton照合: N件を参照・HH:MM 更新」と、更新ボタン           |
| error   | 帯で固定の文言を表示し、更新ボタンを残す                      |

## 3. エラー処理

| 事象                             | 処理                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| 一覧の取得に失敗                 | 一覧の位置に失敗の表示と再読み込みのボタンを出す           |
| 候補の取得に失敗                 | ドメインを選べないため発行ボタンを無効にし、理由を通知する |
| クリップボードへの書き込みの失敗 | 「コピーできませんでした」を通知する                       |
| 発行・削除がエラー応答           | サーバのメッセージを通知し、画面の状態は変更しない         |
| 通信の失敗                       | 「サーバへ接続できません」を通知する                       |
