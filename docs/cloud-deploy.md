# クラウドへの配備

アプリを Cloudflare Workers の無料枠へ、XREAゲートウェイと Proton Pass 読み取りサービスを任意のコンテナ基盤へ配備する手順です。配備はすべて手動で実行し、自動の配備の定義は置きません。

```
利用者のブラウザ → [Cloudflare Access] → Workers（app）
                                           ├─→ XREAゲートウェイ（コンテナ。最大1インスタンス）→ XREA API
                                           └─→ Proton Pass 読み取りサービス（コンテナ。任意）
```

## 1. 事前に決めるもの

| 項目                  | 内容                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------- |
| COOKIE_SECRET         | 認証情報を暗号化する鍵の元。32文字以上。例: `openssl rand -base64 48`                    |
| INTERNAL_TOKEN        | Workers とコンテナ間の共有シークレット。32文字以上。ゲートウェイと読み取りサービスで共通 |
| ゲートウェイのURL     | 手順2で公開するHTTPSのURL                                                                |
| 読み取りサービスのURL | 手順3で公開するHTTPSのURL。Proton Pass 連携を使わないなら不要                            |

秘匿値（COOKIE_SECRET と INTERNAL_TOKEN）は、リポジトリ・チャット・シェルの履歴・ログに残さないでください。対話的に入力するか、パスワードマネージャから貼り付けます。

## 2. XREAゲートウェイ（必須）

アプリと同じイメージから作ります（起動コマンドだけが異なります）。

```sh
docker build --target app -t xrea-address-generator:local .
```

コンテナ基盤に求める条件:

| 条件               | 値                                                                           |
| ------------------ | ---------------------------------------------------------------------------- |
| コマンド           | `node /app/dist/gateway/main.js`                                             |
| 環境変数           | `INTERNAL_TOKEN`（共有シークレット）、`PORT=8081`、`BIND_ADDRESS=0.0.0.0`    |
| 最大インスタンス数 | **1**（XREAへの要求を直列化するため。複数にすると1秒間隔の制限を守れません） |
| 公開               | HTTPS（Workers から呼び出せること）                                          |
| 永続ボリューム     | 不要                                                                         |
| 死活確認           | `GET /healthz` が 200                                                        |

ゲートウェイは認証情報を保存しません。XREAの接続元IP制限は設定しないでください（固定のIPを持たない基盤でも動かせるようにするため）。

## 3. Proton Pass 読み取りサービス（任意）

使わない場合は、このコンテナを配備せず、手順4の `PROTON_READER_URL` を空のままにします。Proton Pass 連携は無効になり、読み取りサービスの呼び出しも発生しません。

```sh
docker build --target reader -t xrea-address-generator-reader:local .
```

| 条件               | 値                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| コマンド           | `node /app/dist/reader/main.js`                                                                |
| 環境変数           | `INTERNAL_TOKEN`（ゲートウェイと同じ値）、`PORT=8082`、`BIND_ADDRESS=0.0.0.0`、`SESSION_DIR`   |
| 最大インスタンス数 | 1                                                                                              |
| 公開               | HTTPS                                                                                          |
| 永続ボリューム     | 不要。`SESSION_DIR` は再作成を許す一時領域でよい（失われても次の要求で自動的に再ログインする） |
| 死活確認           | `GET /healthz` が 200                                                                          |

読み取りサービスは、共有シークレットを知らない呼び出し元を 401 で拒否します。パスワードは応答にもログにも出ません。

## 4. Workers（app）

```sh
npm ci
npm run build:worker && npm run build:web
```

`wrangler.toml` の `[vars]` に、手順2・3のURLを書きます（URLは秘匿値ではないため定義に置きます）。

```toml
[vars]
XREA_GATEWAY_URL = "https://gateway.example.net"
PROTON_READER_URL = ""   # 使わないなら空のまま
```

秘密は `wrangler secret put` で対話的に設定します。値はリポジトリにもログにも残りません。

```sh
npx wrangler secret put COOKIE_SECRET
npx wrangler secret put INTERNAL_TOKEN
npx wrangler deploy
```

Workers は `XREA_GATEWAY_URL` と `PROTON_READER_URL` に https 以外を受け付けません（http だと 500 になり、ログに変数名が出ます）。Workers は SQLite 方式の認証情報の保持を使えません（`CREDENTIAL_STORE=cookie` のままにします）。無料枠の上限は、1要求あたり CPU 10ミリ秒、1日 10万要求、スクリプト 3MB（圧縮後）です。このアプリは圧縮後 1MB 以下で、一覧の要求の CPU 時間は 10ミリ秒を下回ります。

## 5. 配備後の疎通確認

```sh
npx tsx scripts/cloud/check.ts probe \
  --app https://app.example.net \
  --gateway https://gateway.example.net \
  --reader https://reader.example.net   # 使わないなら省く
```

60秒以内に次を確認し、成功と失敗の別だけを表示します（秘匿値は表示しません）。

| 検査                                              | 失敗したときの原因                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Workers・ゲートウェイ・読み取りサービスの死活確認 | URL、公開設定、コンテナの起動                                                                      |
| 共有シークレットなしの要求が 401                  | `INTERNAL_TOKEN` が未設定                                                                          |
| 誤った認証情報の登録が 400 になる                 | Workers とゲートウェイの `INTERNAL_TOKEN` の不一致（502 になる）、または `XREA_GATEWAY_URL` の誤り |

コンテナ基盤の設定が要件を満たすかは、次で検査できます。

```sh
npx tsx scripts/cloud/check.ts platform --max-instances 1 --https true --internal-token true
```

## 6. 入口の保護

Workers の前段の Cloudflare Access の設定は、このリポジトリの対象外です。公開前に、自分だけが入れるポリシーを設定してください。
