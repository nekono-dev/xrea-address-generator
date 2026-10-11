# クラウド配備 設計書

## 1. 構成

| パス                         | 責務                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `wrangler.toml`              | Workersの配備の定義（スクリプト、画面ファイル、変数、秘密の名前） |
| `web/public/_headers`        | 画面ファイルのキャッシュの指示                                    |
| `scripts/cloud/check.ts`     | コンテナ基盤の要件の検査と、配備後の疎通確認                      |
| `docs/cloud-deploy.md`       | 配備の手順（Workers、コンテナ基盤の要件、秘匿値の設定）           |
| `tests/cloud/config.test.ts` | 配備の定義・ヘッダ・秘匿値の非混入のテスト                        |
| `tests/cloud/check.test.ts`  | 要件の検査と疎通確認の単体テスト                                  |
| `tests/cloud/cpu.test.ts`    | 一覧の要求のCPU時間のテスト                                       |

## 2. 設計項目

### D-1: Workersの配備の定義 (FR-1, FR-2, FR-7, NFR-1)

```toml
name = "xrea-address-generator"
main = "dist/worker/index.js"
compatibility_date = "2026-08-01"

[assets]
directory = "dist/web"
binding = "ASSETS"
run_worker_first = ["/api/*", "/healthz"]
not_found_handling = "none"   # 入口への切り替えは Worker が行う

[vars]
XREA_GATEWAY_URL = ""         # ゲートウェイのHTTPSのURL（配備時に設定）
PROTON_READER_URL = ""        # 空なら Proton Pass 連携を使わない
CREDENTIAL_STORE = "cookie"
# 秘密（wrangler secret put で設定する。定義には書かない）: COOKIE_SECRET、INTERNAL_TOKEN
```

| 項目   | 内容                                                                                                                                                  |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| ビルド | worker 用の成果物を dist/worker/index.js へ単一ファイルに束ねる（node: 依存を含めない）。サーバ名の一覧（config/xrea-servers.json）は成果物へ埋め込む |
| 配備   | 手動で `npx wrangler deploy` を実行する。自動の配備の定義は置かない                                                                                   |
| 秘匿値 | 秘密は wrangler secret put で対話的に与え、リポジトリ・ログ・シェルの履歴に残さない                                                                   |
| 変数   | URL は秘匿値でないため [vars] で管理する                                                                                                              |

### D-2: 画面ファイルのキャッシュ (FR-8)

```
# web/public/_headers
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/index.html
  Cache-Control: no-cache
/manifest.webmanifest
  Cache-Control: no-cache
/sw.js
  Cache-Control: no-cache
/
  Cache-Control: no-cache
```

### D-3: コンテナ基盤の要件 (FR-3, FR-4, FR-5)

| 要件               | ゲートウェイ                                     | 読み取りサービス                        |
| ------------------ | ------------------------------------------------ | --------------------------------------- |
| イメージ           | アプリと同一のイメージ（起動コマンドだけ変える） | 公式CLIを同梱した別のイメージ           |
| 最大インスタンス数 | 1                                                | 1                                       |
| 公開               | HTTPS                                            | HTTPS                                   |
| 共有シークレット   | INTERNAL_TOKEN を環境変数で設定                  | INTERNAL_TOKEN を環境変数で設定         |
| 永続ボリューム     | 不要                                             | 不要（セッションは一時領域）            |
| 配備の要否         | 必須                                             | 任意（配備しないときは URL を空にする） |

```ts
// scripts/cloud/check.ts
export type PlatformSpec = {
  maxInstances: number
  https: boolean
  hasInternalToken: boolean
}
export function checkGateway(p: PlatformSpec): string[] // 違反の説明の配列。maxInstances が 1 以外、https が false、hasInternalToken が false で違反
export function checkReader(p: PlatformSpec): string[] // 同じ規則
```

読み取りサービスのセッションの保存先は一時領域とする。再作成でセッションを失っても、次の要求のログインで取得が再開する（読み取りサービスが自動で再ログインする）。

### D-4: 配備後の疎通確認 (FR-6, NFR-3)

```ts
export type Probe = { name: string; ok: boolean; detail: string }

/** 60秒の締め切りの中で、次を順に確認する */
export async function probe(env: {
  app: string
  gateway: string
  reader?: string
}): Promise<Probe[]> {
  return [
    await get(`${env.app}/healthz`), // Workers
    await get(`${env.gateway}/healthz`), // ゲートウェイの死活
    await expect401(`${env.gateway}/v1/aliases`), // 共有シークレットなしは 401
    ...(env.reader
      ? [
          await get(`${env.reader}/healthz`),
          await expect401(`${env.reader}/v1/entries`),
        ]
      : []),
    await expect400(`${env.app}/api/credentials`, { xrea: bad }), // 誤った認証情報は 400 で、cookie が発行されない
  ]
}
```

| 検査                                 | 成功の条件                                                        |
| ------------------------------------ | ----------------------------------------------------------------- |
| Workers の死活確認                   | 200                                                               |
| ゲートウェイ・読み取りサービスの死活 | 200                                                               |
| 共有シークレットなしの要求           | 401                                                               |
| 共有シークレットの一致               | 偽の認証情報の登録が 400 invalid_credentials（401 や 502 でない） |

秘匿値は検査の出力に含めず、成功と失敗の別だけを報告する。

### D-5: CPU時間の予算 (NFR-2)

| 区間                           | 予算     |
| ------------------------------ | -------- |
| cookie の復号（AES-GCM）       | 2ミリ秒  |
| 要求と応答のJSONの処理         | 3ミリ秒  |
| ルーティングとヘッダの組み立て | 2ミリ秒  |
| 余裕                           | 3ミリ秒  |
| 合計                           | 10ミリ秒 |

ゲートウェイと読み取りサービスの応答の待ちは、CPU時間に数えない。レスポンスの本文は逐次の変換を行わず、そのまま中継する。

## 3. エラー処理

| 事象                   | 処理                                              |
| ---------------------- | ------------------------------------------------- |
| ゲートウェイのURLが空  | Workersが500で応答し、設定の不足を示す            |
| 要件の検査で違反       | 違反の説明を表示して終了コード1で終了する         |
| 疎通確認の失敗         | 失敗した検査の名前を表示して終了コード1で終了する |
| 疎通確認が60秒を超える | 打ち切って終了コード1で終了する                   |
