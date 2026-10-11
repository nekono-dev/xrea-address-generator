# PWA対応 設計書

## 1. 構成

| パス                              | 責務                                                     |
| --------------------------------- | -------------------------------------------------------- |
| `web/public/manifest.webmanifest` | アプリの宣言                                             |
| `web/public/icons`                | アイコン（192・512・180ピクセル）                        |
| `web/icon.svg`                    | アイコンの原画                                           |
| `scripts/icons.ts`                | 原画からアイコンを書き出すスクリプト                     |
| `web/src/sw/core.ts`              | 要求の振り分け、通信優先の取得、参照ファイルの抽出       |
| `web/src/sw/sw.ts`                | Service Worker の本体（導入・有効化・要求の処理）        |
| `web/src/pwa.tsx`                 | Service Worker の登録と、オフラインの帯                  |
| `vite.config.ts`                  | Service Worker を版のない固定の名前で書き出すビルド設定  |
| `src/app/static.ts`               | 配信時のキャッシュの指示                                 |
| `tests/web/sw.test.ts`            | 振り分け・通信優先の取得・参照ファイルの抽出の単体テスト |
| `tests/app/http.test.ts`          | 配信時のキャッシュの指示のテスト                         |
| `tests/e2e/pwa.spec.ts`           | 宣言・保存・オフライン表示のブラウザテスト               |

## 2. 設計項目

### D-1: 宣言とアイコン (FR-1, FR-2, NFR-2)

```json
{
  "name": "XREA Alias Generator",
  "short_name": "Alias",
  "start_url": "/",
  "scope": "/",
  "display": "standalone",
  "background_color": "#0f172a",
  "theme_color": "#0f172a",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png" },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ]
}
```

```html
<!-- 外部のアクセス制御の認証情報を付けて取得させるため、crossorigin に use-credentials を指定する -->
<link
  rel="manifest"
  href="/manifest.webmanifest"
  crossorigin="use-credentials"
/>
<meta name="theme-color" content="#0f172a" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-title" content="Alias" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black" />
```

| アイコン                     | 大きさ  | 作り方                                                      |
| ---------------------------- | ------- | ----------------------------------------------------------- |
| `icons/icon-192.png`         | 192×192 | 原画をヘッドレスブラウザで描画して書き出す                  |
| `icons/icon-512.png`         | 512×512 | 同上。図柄を中央の80%に収め、マスクで切り抜かれても欠けない |
| `icons/apple-touch-icon.png` | 180×180 | 同上。背景を塗りつぶし、透過を含めない                      |

書き出したアイコンはリポジトリに含め、ビルド時には生成しない。

### D-2: 要求の振り分けと保存 (FR-3, FR-4, FR-5, FR-6, NFR-1, NFR-3)

```ts
export const CACHE = "xrea-address-generator-shell"
export const SHELL = "/" // 画面の入口は、パスによらずこのキーで保存する
export const NAV_TIMEOUT_MS = 3000
export type Route = "network" | "navigate" | "asset" | "static"
export function route(
  url: URL,
  method: string,
  mode: RequestMode,
  origin: string,
): Route
export function referencedAssets(html: string): string[] // 入口が参照する /assets/ のパス
export async function networkFirst(
  fetchShell: () => Promise<Response>,
  cached: () => Promise<Response | undefined>,
  timeoutMs = NAV_TIMEOUT_MS,
): Promise<Response>
```

| 振り分け | 条件                                  | 処理                                                                    |
| -------- | ------------------------------------- | ----------------------------------------------------------------------- |
| network  | GET 以外・別オリジン・/api/・/healthz | 横取りせず、ブラウザの通常の通信に任せる                                |
| navigate | 画面の遷移（mode が navigate）        | 通信を優先する。3秒以内に応答が無いか通信に失敗したら保存した入口を返す |
| asset    | /assets/ で始まるパス                 | 保存したもの（Vary を無視して照合）を返し、無ければ取得して保存する     |
| static   | 上記以外（アイコン・宣言）            | 保存したものを返しつつ、裏で取得して保存を更新する                      |

| 入口の応答                       | 処理                                                       |
| -------------------------------- | ---------------------------------------------------------- |
| 200 で本文が HTML                | 入口として保存し、参照されない /assets/ の保存を削除する   |
| 転送（opaqueredirect）・401・403 | 保存せずにそのまま返す（アクセス制御の認証画面へ進ませる） |
| 3秒以内に応答が無い              | 保存した入口を返し、後から届いた応答で保存を更新する       |
| 通信の失敗で、保存した入口が無い | ブラウザの通信の失敗をそのまま返す                         |

```ts
// sw.ts の導入と有効化
self.addEventListener("install", (e) => e.waitUntil(precache())) // 入口と参照ファイルを保存し、skipWaiting する
self.addEventListener("activate", (e) => e.waitUntil(cleanup())) // CACHE 以外の保存領域を消し、clients.claim する
```

### D-3: 登録とオフラインの帯 (FR-7)

```tsx
export function registerServiceWorker(nav = navigator): void {
  if (!import.meta.env.PROD || !("serviceWorker" in nav)) return // 開発用サーバでは登録しない
  void nav.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {})
}
export function OfflineBanner({ onOnline }: { onOnline: () => void }) {
  const [online, setOnline] = useState(navigator.onLine)
  // online・offline の事象で切り替え、オンラインへ戻ったときに onOnline を呼ぶ
  return online ? null : (
    <Banner
      kind="offline"
      text="オフラインです。接続が戻ると一覧を取り直します"
    />
  )
}
```

| 場所     | 内容                                                     |
| -------- | -------------------------------------------------------- |
| 起動     | 描画の直後に登録する                                     |
| 帯の位置 | 発行フォームを含む固定の帯の中、再ログインの帯と同じ位置 |
| 一覧     | オンラインへ戻ったとき、一覧と候補を取り直す             |

### D-4: ビルドと配信時のキャッシュの指示 (FR-8)

```ts
// vite.config.ts。Service Worker は版を含まない固定の名前で、入口と同じ階層に置く
rollupOptions: {
  input: { main: "web/index.html", sw: "web/src/sw/sw.ts" },
  output: { entryFileNames: (c) => (c.name === "sw" ? "sw.js" : "assets/[name]-[hash].js") },
}
```

| パス                      | Cache-Control                       | Content-Type              |
| ------------------------- | ----------------------------------- | ------------------------- |
| /assets/ で始まるパス     | public, max-age=31536000, immutable | 拡張子から決める          |
| /manifest.webmanifest     | no-cache                            | application/manifest+json |
| /sw.js                    | no-cache                            | text/javascript           |
| 画面の入口・その他        | no-cache                            | 拡張子から決める          |
| /assets/ で存在しないパス | no-cache（404 を返す）              | text/plain                |

## 3. エラー処理

| 事象                              | 処理                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| Service Worker を使えないブラウザ | 登録せず、通常の画面として動作する                               |
| Service Worker の登録に失敗       | 何も表示せず、通常の画面として動作する                           |
| 導入時の画面ファイルの保存に失敗  | 導入を失敗させ、次回の表示で導入をやり直す                       |
| 保存領域の容量の不足              | 保存せずに通信の応答を返す                                       |
| オフラインでのAPIの要求           | 通信の失敗として扱い、画面が「サーバへ接続できません」を通知する |
