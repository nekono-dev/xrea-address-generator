# XREA Address Generator

XREA のメール転送アドレス（エイリアス）を、ワンボタンで発行・管理する Web アプリです。発行したアドレスは指定のメールボックスへ転送されます。複数の利用者が、それぞれ自分の XREA アカウントで使えます。任意で Proton Pass の読み取り専用アクセストークンを登録すると、トークンで参照できるすべての Vault を読み取り、各アドレスがどのサービスで使われているか（エントリ名）を一覧に表示します。

- 認証情報（XREA のアカウント・サーバ名・API シークレットキー、任意で Proton Pass のトークン）は、画面から登録します。サーバの環境変数には持ちません。
- 認証情報は暗号化した cookie（HttpOnly・SameSite=Strict・有効期間7日）に保持し、サーバには保存しません。ログアウトや削除の操作はなく、7日で期限切れになります。期限が切れたときは画面が再登録を求めます。
- セルフホストでは、cookie にセッション ID だけを入れ、認証情報を暗号化して SQLite に保存する方式も選べます（`CREDENTIAL_STORE=sqlite`）。
- 名前を空にして発行すると、`quiet.river42` の形のランダムな名前を付けます。
- 転送先は候補（XREA の既存の転送先）から選ぶか、自由に入力できます。発行済みのアドレスの転送先も、一覧の「変更」から変えられます（自動返信・フィルタ・パスワードはそのまま保たれます）。
- XREA でメールボックスを持つアドレス（受信のみ・転送と受信の両方）も一覧に表示します（「メールボックス」の印付き。コピーだけができ、変更・削除はできません）。
- 最後に選んだ発行ドメイン・転送先・絞り込み・並び順は、ブラウザに保存して次回の表示で復元します（認証情報は保存しません）。
- 幅680ピクセル未満ではスマートフォン向けの表示（文字を約1.2倍、部品の高さ44ピクセル）になります。
- ホーム画面に追加して、アプリとして使えます（PWA）。画面ファイルだけを端末に保存し、一覧などの API の応答は保存しません。
- Proton Pass への書き込みは行いません。Proton Pass のパスワードは、通信にもログにも載せません。

## 構成

3つのコンポーネントに分けています。クラウドでもセルフホストでも同じ構成です。

```
ブラウザ → app ─→ xrea-gateway ─→ XREA API
             └──→ proton-reader ─→ Proton Pass（任意）
```

| コンポーネント | 役割 | 動かす場所 |
| --- | --- | --- |
| `app` | 画面の配信と HTTP API。無状態で、認証情報の cookie を復号して内部サービスへ中継する | Cloudflare Workers、または Node.js のコンテナ |
| `xrea-gateway` | XREA への要求をアカウントごとに直列化する（1秒間隔の制限を守る）。**最大1インスタンス** | コンテナ |
| `proton-reader` | 公式 CLI（`pass-cli`）で Proton Pass を読み、アドレス→エントリ名の対応表だけを返す。使わなければ配備しない | コンテナ |

| ディレクトリ | 内容 |
| --- | --- |
| `src/app` | `app` の API・中継・画面の配信と、Node.js・Workers の入口 |
| `src/credentials` | 認証情報の暗号化・cookie 方式・SQL 方式・登録のルート |
| `src/gateway` | `xrea-gateway` |
| `src/reader` | `proton-reader`（公式 CLI の実行、トークンごとのセッション分離、対応表） |
| `src/shared` | エラーコード・ログ・内部の共有シークレットの検査 |
| `src/xrea` | XREA API の型付きクライアント（公式ドキュメントから生成した OpenAPI に基づく） |
| `web` | 画面（Preact。ブラウザ標準の部品は使わず、すべて独自の部品で構成）と、PWA の宣言・アイコン・Service Worker |
| `api` | 公式ドキュメントの基準・補正定義・生成した OpenAPI |
| `docs` | 配備の手順書 |
| `specs` | 仕様書（要件定義・設計・タスク） |

仕様書は `specs/<コンポーネント>/` にあり、`npm run lint:spec` で検査します。

## 導入の前に用意するもの

1. **XREA の API シークレットキー**: コントロールパネルで発行します。画面から登録するもので、サーバの設定には書きません。XREA の API に接続元 IP の制限はありません。
2. **Proton Pass の読み取り専用アクセストークン**（有料プラン。省略すると Proton Pass 連携を使いません。登録時に画面で入力します）:
   ```sh
   pass-cli login                                  # ブラウザでログイン
   pass-cli pat create --name xrea-address-generator --expiration 1y
   pass-cli pat access grant --personal-access-token-name xrea-address-generator \
     --vault-name "<照合に使うVault名>" --role viewer
   ```
   アプリは Vault の名前を指定せず、このトークンで参照できるすべての Vault を調べます。照合の対象は、ここで権限を与えた Vault で決まります。
3. **サーバの秘密値 2つ**: `COOKIE_SECRET`（認証情報を暗号化する鍵の元）と `INTERNAL_TOKEN`（内部サービスの共有シークレット）。どちらも 32 文字以上で、`openssl rand -base64 48` などで作ります。
4. **Cloudflare Tunnel のトークン**（省略すると、トンネルを使わず LAN に公開します）: 公開ホスト名の接続先は、Docker 構成では `http://app:3000` にします。アクセス制御は Cloudflare Access で行ってください（アプリ自身は利用者の認証を持ちません）。PWA の宣言は Cloudflare Access の認証情報を付けて取得するよう指定しています。

## Docker で動かす（セルフホスト）

```sh
cp .env.example .env   # COOKIE_SECRET と INTERNAL_TOKEN を記入する（このファイルはリポジトリに含めない）
docker compose up -d
```

起動するのは `app`・`xrea-gateway`・`cloudflared` の3つです。ホストへポートは公開しません。`TUNNEL_TOKEN` を空にすると、`cloudflared` は起動しません。

Proton Pass 連携を使うときは、`.env` に次を書いて `proton-reader` も起動します。

```
COMPOSE_PROFILES=proton
PROTON_READER_URL=http://proton-reader:8082
```

`proton-reader` のセッションの保存先（名前付きボリューム）だけを永続化します（`CREDENTIAL_STORE=sqlite` のときは、SQLite 用のボリュームも使います）。ゲートウェイと読み取りサービスは、読み取り専用のルートファイルシステム・非特権ユーザー・全権限の放棄で動かします。

トンネルを使わず LAN だけで使うときは、追加の定義でアプリのポートを公開します。HTTP でも cookie を保持できるよう、この定義だけ cookie の `Secure` 属性を外します。信頼できる LAN でのみ使ってください。ホスト側のポートは `APP_PORT`（既定 3000）で変えられます。

```sh
docker compose -f compose.yaml -f compose.lan.yaml up -d
```

トンネルを使う構成では、`.env` の値によらず cookie に `Secure` 属性を付けます。

## クラウドに載せる

`app` を Cloudflare Workers の無料枠へ、`xrea-gateway`（と任意で `proton-reader`）を任意のコンテナ基盤へ配備します。手順は [docs/cloud-deploy.md](docs/cloud-deploy.md) を参照してください。配備後の疎通確認は `npx tsx scripts/cloud/check.ts probe` で行えます。

## 環境変数

`app`（Docker では `app` サービス、Workers では変数と秘密）:

| 変数 | 必須 | 既定値 | 内容 |
| --- | --- | --- | --- |
| `COOKIE_SECRET` | 必須 | | 32 文字以上。認証情報の暗号化の鍵を導出する |
| `INTERNAL_TOKEN` | 必須 | | 32 文字以上。内部サービスとの共有シークレット |
| `XREA_GATEWAY_URL` | 必須 | | `xrea-gateway` の URL（Docker では compose が設定する） |
| `PROTON_READER_URL` | 任意 | | `proton-reader` の URL。空なら Proton Pass 連携を使わない |
| `CREDENTIAL_STORE` | 任意 | `cookie` | `cookie` または `sqlite`（Workers は `cookie` のみ） |
| `CREDENTIAL_DB_PATH` | 任意 | `/var/lib/xrea-address-generator/sessions.db` | `sqlite` のときの保存先 |
| `COOKIE_SECURE` | 任意 | `1` | `0` で cookie の `Secure` 属性を外す（LAN の HTTP 公開用） |
| `TUNNEL_TOKEN` | 任意 | | 設定があると `BIND_ADDRESS` の既定が `127.0.0.1` になる |
| `BIND_ADDRESS` | 任意 | `0.0.0.0`（`TUNNEL_TOKEN` があれば `127.0.0.1`） | 待ち受けるアドレス |
| `PORT` | 任意 | `3000` | 待ち受けるポート |
| `LOG_LEVEL` | 任意 | `info` | ログの詳細度 |

`xrea-gateway`: `INTERNAL_TOKEN`（必須）、`PORT`（既定 8081）、`BIND_ADDRESS`、`LOG_LEVEL`。

`proton-reader`: `INTERNAL_TOKEN`（必須）、`SESSION_DIR`（既定 `/var/lib/xrea-address-generator/session`）、`MAX_TENANTS`（既定 20）、`PORT`（既定 8082）、`BIND_ADDRESS`、`LOG_LEVEL`。

Docker Compose 用の変数（`.env`）は [.env.example](.env.example) を参照してください。

## 開発

```sh
npm ci
npm run typecheck        # 型チェック
npm test                 # 単体テスト
npx playwright test      # 画面のブラウザテスト（ヘッドレス）
npm run build            # dist/app・dist/gateway・dist/reader・dist/worker・dist/web を生成
npm run lint:spec        # 仕様書の検査
npx tsx scripts/icons.ts # アイコンの原画（web/icon.svg）から PWA のアイコンを書き出す
```

開発時は、ゲートウェイ・アプリ・Vite を並べて起動します。`/api` は Vite からアプリへ転送されます。

```sh
export INTERNAL_TOKEN=$(openssl rand -hex 32) COOKIE_SECRET=$(openssl rand -hex 32)
PORT=8081 npx tsx src/gateway/main.ts &
XREA_GATEWAY_URL=http://127.0.0.1:8081 COOKIE_SECURE=0 BIND_ADDRESS=127.0.0.1 npx tsx src/app/node.ts &
npx vite --config vite.config.ts
```

実機を使うテストは、変数を指定したときだけ実行されます（`.env` の値を環境変数として読み込んでから実行してください）。XREA は同じ操作の連続した要求を1秒に1回までしか受け付けないため、XREA を使うテストは1ファイルずつ実行してください。

| 変数 | 対象 |
| --- | --- |
| `XREA_LIVE=1` | 実際の XREA API に対する契約テスト・ゲートウェイ経由の発行・転送先の変更・削除（`poc-` で始まる名前だけを作成・削除する。`XREA_ACCOUNT`・`XREA_SERVER_NAME`・`XREA_API_SECRET_KEY`・`XREA_POC_DOMAIN`・`XREA_POC_FORWARD_TO` が必要） |
| `DOCKER_LIVE=1` | イメージ・Compose・公開経路・再起動・権限（Docker のあるホストで実行。実際の認証情報があれば登録まで確認する） |

## XREA API の変更に追従する

XREA のクライアントは、公式ドキュメント（apidoc.xrea.com）から生成した OpenAPI に基づいています。

```sh
npm run docs:check       # 基準（api/snapshot）との差分を検知する。差分があれば終了コード1
npm run docs:snapshot    # 差分を確認したうえで、基準を更新する
npm run docs:all         # OpenAPI（api/xrea.openapi.yaml）と型（src/xrea/generated）を再生成する
XREA_LIVE=1 npx vitest run tests/xrea/contract.live.test.ts   # 実際のAPIとの整合を確かめる
```

公式ドキュメントの誤記や、実際の API との違いは `api/overlay.yaml`（JSON Merge Patch）で補正します。新しいエンドポイントを使うときは、`scripts/xrea-docs/fetch.ts` と `scripts/xrea-docs/generate.ts` の対象一覧に追加します。
