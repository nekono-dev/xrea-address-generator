# クラウド配備 設計書

## 1. 構成

| パス                          | 責務                                                               |
| ----------------------------- | ------------------------------------------------------------------ |
| `wrangler.jsonc`              | Workersの配備の定義（スクリプト、画面ファイル、変数、秘密の名前）  |
| `web/public/_headers`         | 画面ファイルのキャッシュの指示                                     |
| `scripts/cloud/check.ts`      | コンテナ基盤の要件の検査と、配備後の疎通確認                       |
| `scripts/cloud/deploy.ts`     | 構成例の一括配備（`npm run deploy:cloud`）                         |
| `scripts/cloud/destroy.ts`    | 構成例の一括撤去（`npm run destroy:cloud`）                        |
| `docs/cloud-deploy.md`        | 構成の図と配備の手順（Workers、Cloud Run、秘匿値の設定）           |
| `docs/cloud-operations.md`    | 配備後の運用の手順（保持方式、秘密値の更新、失効、インスタンス数） |
| `tests/cloud/config.test.ts`  | 配備の定義・ヘッダ・秘匿値の非混入のテスト                         |
| `tests/cloud/check.test.ts`   | 要件の検査と疎通確認の単体テスト                                   |
| `tests/cloud/deploy.test.ts`  | 一括配備の順序・冪等性・秘匿値の扱いのテスト                       |
| `tests/cloud/destroy.test.ts` | 一括撤去の順序・冪等性のテスト                                     |
| `tests/cloud/cpu.test.ts`     | 一覧の要求のCPU時間のテスト                                        |
| `tests/cloud/doc.test.ts`     | 手順書の図と手順の内容のテスト                                     |

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
PROTON_READER_URL = ""        # 空なら Proton Pass 連携を使わない
CREDENTIAL_STORE = "cookie"
# ゲートウェイは同じ Worker の Durable Object として動かす
[[durable_objects.bindings]]
name = "GATEWAY"
class_name = "GatewayTenant"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GatewayTenant"]
# 秘密（wrangler secret put で設定する。定義には書かない）: COOKIE_SECRET。INTERNAL_TOKEN は読み取りサービスを使うときだけ
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

| 要件               | 読み取りサービス                        |
| ------------------ | --------------------------------------- |
| イメージ           | 公式CLIを同梱した専用のイメージ         |
| 最大インスタンス数 | 1                                       |
| 公開               | HTTPS                                   |
| 共有シークレット   | INTERNAL_TOKEN を環境変数で設定         |
| 永続ボリューム     | 不要（セッションは一時領域）            |
| 配備の要否         | 任意（配備しないときは URL を空にする） |

```ts
// scripts/cloud/check.ts
export type PlatformSpec = {
  maxInstances: number
  https: boolean
  hasInternalToken: boolean
}
export function checkReader(p: PlatformSpec): string[] // 違反の説明の配列。maxInstances が 1 以外、https が false、hasInternalToken が false で違反
```

読み取りサービスのセッションの保存先は一時領域とする。再作成でセッションを失っても、次の要求のログインで取得が再開する（読み取りサービスが自動で再ログインする）。

### D-4: 配備後の疎通確認 (FR-6, NFR-3)

```ts
export type Probe = { name: string; ok: boolean; detail: string }

/** 60秒の締め切りの中で、次を順に確認する */
export async function probe(env: {
  app: string
  reader?: string
}): Promise<Probe[]> {
  return [
    await get(`${env.app}/healthz`), // Workers
    ...(env.reader
      ? [
          await get(`${env.reader}/health`),
          await expect401(`${env.reader}/v1/entries`),
        ]
      : []),
    await expect400(`${env.app}/api/credentials`, { xrea: bad }), // 誤った認証情報は 400 で、cookie が発行されない
  ]
}
```

| 検査                       | 成功の条件                                                        |
| -------------------------- | ----------------------------------------------------------------- |
| Workers の死活確認         | 200                                                               |
| 読み取りサービスの死活     | 200                                                               |
| 共有シークレットなしの要求 | 401                                                               |
| XREAへの到達               | 偽の認証情報の登録が 400 invalid_credentials（401 や 502 でない） |

秘匿値は検査の出力に含めず、成功と失敗の別だけを報告する。

### D-5: CPU時間の予算 (NFR-2)

| 区間                           | 予算     |
| ------------------------------ | -------- |
| cookie の復号（AES-GCM）       | 2ミリ秒  |
| 要求と応答のJSONの処理         | 3ミリ秒  |
| ルーティングとヘッダの組み立て | 2ミリ秒  |
| 余裕                           | 3ミリ秒  |
| 合計                           | 10ミリ秒 |

ゲートウェイのDurable Objectの処理も、1回の呼び出しごとにCPU時間10ミリ秒以内とする。XREAと読み取りサービスの応答の待ちは、CPU時間に数えない。レスポンスの本文は逐次の変換を行わず、そのまま中継する。

### D-6: 構成の図と Cloud Run の手順 (FR-9, FR-10)

手順書は次の順に構成する。図は Mermaid で書く。

| 節               | 内容                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| 構成             | 構成図（利用者・Workers（ゲートウェイを内蔵）・読み取りサービス・外部サービス） |
| 配備の順序       | シーケンス図（読み取りサービス → Workers → 疎通確認）                           |
| 共通の前提       | 秘匿値の作り方と、コンテナ基盤に求める条件                                      |
| Cloud Run の手順 | プロジェクト、API の有効化、Artifact Registry、Secret Manager、ビルド、デプロイ |
| Workers の手順   | ビルド、変数、秘密、デプロイ                                                    |

Cloud Run の設定値:

| 項目               | 読み取りサービス                                          |
| ------------------ | --------------------------------------------------------- |
| イメージ           | `--target reader` のイメージ                              |
| 起動コマンド       | 既定（イメージの CMD）                                    |
| 最大インスタンス数 | `--max-instances 1`                                       |
| 公開               | `--allow-unauthenticated`（共有シークレットが認可を担う） |
| INTERNAL_TOKEN     | `--set-secrets INTERNAL_TOKEN=<名前>:latest`              |
| PORT               | 指定しない（Cloud Run が設定し、予約されている）          |
| 最小インスタンス数 | 0                                                         |

```sh
# 秘匿値は標準出力に出さず、標準入力から Secret Manager へ渡す
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create xrea-internal-token --data-file=-
```

読み取りサービスは環境変数 PORT を読むため、Cloud Run が設定する値でそのまま待ち受ける。

### D-7: 運用の手順書 (FR-11)

運用の手順書は `docs/cloud-operations.md` に置き、次の順に構成する。

| 節                 | 内容                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 保持方式           | クラウドは cookie 方式に固定する。複数インスタンスと Workers でローカルのSQLiteを共有できないため                                               |
| 秘密値の保管       | COOKIE_SECRET の控えを Secret Manager に置く。Workers の秘密は読み戻せないため、更新の旧値の出どころになる                                      |
| 秘密値の更新       | 直前の秘密値を設定してから現行を差し替え、7日後に直前の秘密値を削除する。利用者は再登録しない                                                   |
| 全利用者の失効     | 直前の秘密値を設定せずに現行を差し替える。盗まれたcookieを個別には失効できない                                                                  |
| インスタンス数     | 読み取りサービスはセッションの保存先を持つため、最大インスタンス数を1にする。ゲートウェイはDurable Objectが直列化するため、台数の制約を持たない |
| 共有ストアの採用時 | 失効とログアウトが必要になった時点の選択肢（D1、Postgres）と、本アプリの対象外であること                                                        |

```sh
# 更新: 旧値を直前の秘密値へ、新しい値を現行へ。順序を守ると、途中の状態でも全員の cookie が有効なままになる
gcloud secrets versions access latest --secret=xrea-cookie-secret | npx wrangler secret put COOKIE_SECRET_PREVIOUS
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add xrea-cookie-secret --data-file=-
gcloud secrets versions access latest --secret=xrea-cookie-secret | npx wrangler secret put COOKIE_SECRET
# 7日後
npx wrangler secret delete COOKIE_SECRET_PREVIOUS
```

### D-8: 一括配備と一括撤去 (FR-12)

`npm run deploy:cloud` は `scripts/cloud/deploy.ts` を実行する。外部コマンドの実行は差し替え可能な実行環境（読み取りの `query` と、変更を伴う `exec`）を通し、テストでは呼び出しの記録で検証する。

| 入力                    | 内容                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `PROJECT_ID`            | 読み取りサービスを配備するときだけ必須。Google Cloud のプロジェクトID |
| `CLOUDFLARE_ACCOUNT_ID` | 必須。Cloudflare のアカウントID                                       |
| `REGION`                | 任意。既定は `asia-northeast1`                                        |
| `IMAGE_TAG`             | 任意。既定は `v1`。更新のたびに変えない                               |
| `APP_URL`               | 任意。あれば最後に疎通確認を実行する                                  |
| `--no-reader`           | 読み取りサービスを配備せず、`PROTON_READER_URL` を空にする            |
| `--dry-run`             | 読み取りだけ実行し、変更を伴う操作は表示だけにする                    |

配備の順序と冪等性:

| 順  | 対象                             | 処理                                                                                                                                                                       |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Google Cloud の準備              | `--no-reader` のときは省略。API の有効化。リポジトリが無ければ作成。共有シークレットが無ければ標準入力で作成（あれば変更しない）。読み取りの許可の付与                     |
| 2   | コンテナ（読み取りサービスのみ） | ビルド → サービスがあれば削除 → イメージ（同じタグ）があれば `--delete-tags` で削除 → push → デプロイ（最大1、Secret Manager 注入）                                        |
| 3   | Workers                          | ビルド → 読み取りサービスを配備するときだけ `INTERNAL_TOKEN` を Secret Manager から標準入力で設定 → `COOKIE_SECRET` は未設定のときだけ作成 → `--var` でURLを渡してデプロイ |
| 4   | 疎通確認                         | `APP_URL` があれば `probe` を実行し、失敗があれば終了コード1                                                                                                               |

- 時間のかかるビルドを削除の前に済ませ、サービスの停止を push とデプロイの間に限る。
- URL は `wrangler deploy --var` で渡し、個人用の `wrangler.jsonc` を書き換えない。定義は `wrangler.jsonc` があればそれを、無ければ雛形を使う。
- Cloudflare Access の設定は含めない。

一括撤去（`npm run destroy:cloud`、`scripts/cloud/destroy.ts`）は同じ実行環境を使い、存在を確認してから削除する。確認なしでは実行せず、`--yes` か PROJECT_ID の入力を求める。

| 順  | 対象              | 処理                                                             |
| --- | ----------------- | ---------------------------------------------------------------- |
| 1   | Workers           | スクリプト、画面ファイル、秘密、Durable Objectのクラスを削除する |
| 2   | Cloud Run         | 読み取りサービスのサービスを削除する                             |
| 3   | Artifact Registry | リポジトリをイメージごと削除する                                 |
| 4   | Secret Manager    | 共有シークレットと COOKIE_SECRET の控えを削除する                |
| 5   | 手元              | ビルドしたイメージを削除する                                     |

ログ、Cloudflare Access、DNS、有効化した API は対象外とし、手順書で手動の確認を促す。

手順書は、共通の事前準備、クイックスタート、配備手順、配備後の作業の順に構成する。

## 3. エラー処理

| 事象                     | 処理                                                |
| ------------------------ | --------------------------------------------------- |
| 束縛 GATEWAY が無い      | Workersが500で応答し、設定の不足を示す              |
| 要件の検査で違反         | 違反の説明を表示して終了コード1で終了する           |
| 疎通確認の失敗           | 失敗した検査の名前を表示して終了コード1で終了する   |
| 疎通確認が60秒を超える   | 打ち切って終了コード1で終了する                     |
| 必須の環境変数が無い     | 不足の変数名を表示して終了コード2で終了する         |
| 一括配備のコマンドの失敗 | 失敗した工程を表示して、そこで終了コード1で終了する |
