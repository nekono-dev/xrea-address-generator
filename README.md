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

`app`（XREA ゲートウェイを内蔵）と、任意の `proton-reader` の2つに分けています。クラウドでもセルフホストでも同じ構成です。

```
ブラウザ → app（ゲートウェイ内蔵）─→ XREA API
             └──→ proton-reader ─→ Proton Pass（任意）
```

| コンポーネント | 役割 | 動かす場所 |
| --- | --- | --- |
| `app` | 画面の配信と HTTP API。認証情報の cookie を復号し、内蔵のゲートウェイへ中継する | Cloudflare Workers、または Node.js のコンテナ |
| ゲートウェイ（`app` に内蔵） | XREA への要求をアカウントごとに直列化する（1秒間隔の制限を守る）。Workers ではアカウントごとの Durable Object、Node.js では同一プロセス | `app` と同じ |
| `proton-reader` | 公式 CLI（`pass-cli`）で Proton Pass を読み、アドレス→エントリ名の対応表だけを返す。使わなければ配備しない。**最大1インスタンス** | コンテナ |

| ディレクトリ | 内容 |
| --- | --- |
| `src/app` | `app` の API・中継・画面の配信と、Node.js・Workers の入口 |
| `src/credentials` | 認証情報の暗号化・cookie 方式・SQL 方式・登録のルート |
| `src/gateway` | XREA ゲートウェイ（`app` に内蔵。Durable Object の入口と DNS over HTTPS を含む） |
| `src/reader` | `proton-reader`（公式 CLI の実行、トークンごとのセッション分離、対応表） |
| `src/shared` | エラーコード・ログ・読み取りサービスの共有シークレットの検査 |
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
3. **サーバの秘密値**: `COOKIE_SECRET`（認証情報を暗号化する鍵の元）。Proton Pass 連携を使うときは `INTERNAL_TOKEN`（読み取りサービスとの共有シークレット）も要ります。どちらも 32 文字以上で、`openssl rand -base64 48` などで作ります。
4. **Cloudflare Tunnel のトークン**（省略すると、トンネルを使わず LAN に公開します）: 公開ホスト名の接続先は、Docker 構成では `http://app:3000` にします。アクセス制御は Cloudflare Access で行ってください（アプリ自身は利用者の認証を持ちません）。PWA の宣言は Cloudflare Access の認証情報を付けて取得するよう指定しています。

## Docker で動かす（セルフホスト）

```sh
cp .env.example .env   # COOKIE_SECRET を記入する（Proton Pass 連携を使うときは INTERNAL_TOKEN も）（このファイルはリポジトリに含めない）
docker compose up -d
```

起動するのは `app`（ゲートウェイ内蔵）と `cloudflared` の2つです。ホストへポートは公開しません。`TUNNEL_TOKEN` を空にすると、`cloudflared` は起動しません。

Proton Pass 連携を使うときは、`.env` に次を書いて `proton-reader` も起動します。

```
COMPOSE_PROFILES=proton
PROTON_READER_URL=http://proton-reader:8082
```

`proton-reader` のセッションの保存先（名前付きボリューム）だけを永続化します（`CREDENTIAL_STORE=sqlite` のときは、SQLite 用のボリュームも使います）。`app` と読み取りサービスは、読み取り専用のルートファイルシステム・非特権ユーザー・全権限の放棄で動かします（`app` の書き込み先は SQLite 用のボリュームと `/tmp` だけです）。

トンネルを使わず LAN だけで使うときは、追加の定義でアプリのポートを公開します。HTTP でも cookie を保持できるよう、この定義だけ cookie の `Secure` 属性を外します。信頼できる LAN でのみ使ってください。ホスト側のポートは `APP_PORT`（既定 3000）で変えられます。

```sh
docker compose -f compose.yaml -f compose.lan.yaml up -d
```

トンネルを使う構成では、`.env` の値によらず cookie に `Secure` 属性を付けます。

## クラウドに載せる

`app`（ゲートウェイは同じ Worker の Durable Object）を Cloudflare Workers の無料枠へ配備します。任意の `proton-reader` だけを任意のコンテナ基盤へ配備します（使わなければ Google Cloud は不要です）。事前準備のあと、`npm run deploy:cloud` で構成例のすべてを一括で配備できます（手動の手順もあります）。撤去は `npm run destroy:cloud` です。詳細は [docs/cloud-deploy.md](docs/cloud-deploy.md) を参照してください。配備後の疎通確認は `npx tsx scripts/cloud/check.ts probe` で行えます。配備後の運用（保持方式、秘密値の更新、失効）は [docs/cloud-operations.md](docs/cloud-operations.md) を参照してください。

## 環境変数

`app`（Docker では `app` サービス、Workers では変数と秘密）:

| 変数 | 必須 | 既定値 | 内容 |
| --- | --- | --- | --- |
| `COOKIE_SECRET` | 必須 | | 32 文字以上。認証情報の暗号化の鍵を導出する |
| `INTERNAL_TOKEN` | 条件付き | | 32 文字以上。`PROTON_READER_URL` を設定するときだけ必須。読み取りサービスとの共有シークレット |
| `PROTON_READER_URL` | 任意 | | `proton-reader` の URL。空なら Proton Pass 連携を使わない。Workers は https のみ。Node.js/Docker は https のほか、`proton-reader`・`localhost`・プライベートIP（10/8、172.16/12、192.168/16）への http だけを許す |
| `CREDENTIAL_STORE` | 任意 | `cookie` | `cookie` または `sqlite`（Workers は `cookie` のみ） |
| `CREDENTIAL_DB_PATH` | 任意 | `/var/lib/xrea-address-generator/sessions.db` | `sqlite` のときの保存先 |
| `COOKIE_SECURE` | 任意 | `1` | `0` で cookie の `Secure` 属性を外す（LAN の HTTP 公開用） |
| `TUNNEL_TOKEN` | 任意 | | 設定があると `BIND_ADDRESS` の既定が `127.0.0.1` になる |
| `BIND_ADDRESS` | 任意 | `0.0.0.0`（`TUNNEL_TOKEN` があれば `127.0.0.1`） | 待ち受けるアドレス |
| `PORT` | 任意 | `3000` | 待ち受けるポート |
| `LOG_LEVEL` | 任意 | `info` | ログの詳細度 |

`proton-reader`: `INTERNAL_TOKEN`（必須）、`SESSION_DIR`（既定 `/var/lib/xrea-address-generator/session`）、`MAX_TENANTS`（既定 20）、`PORT`（既定 8082）、`BIND_ADDRESS`、`LOG_LEVEL`。

Docker Compose 用の変数（`.env`）は [.env.example](.env.example) を参照してください。

## 開発

### 1. 準備する

Node.js 22 以上が必要です。依存パッケージを入れます。

```sh
npm ci
```

### 2. ローカルで起動して画面を確認する

```sh
npm run dev
```

アプリ（3000。ゲートウェイを内蔵）・読み取りサービス（8082）・Vite（5173）がまとまって起動します。ブラウザで `http://<ホストのアドレス>:5173` を開いてください。Ctrl+C で全て終了します。

- `/api` は Vite からアプリへ転送されます。Vite だけが `0.0.0.0` で待ち受け、ほかは固定の開発用トークンを使うため `127.0.0.1` に限ります。
- 秘密値は開発専用の固定値です。`INTERNAL_TOKEN`・`COOKIE_SECRET` で上書きできます。
- 読み取りサービスが使う公式 CLI（`pass-cli`）が PATH に無ければ、初回に取得して `.dev/bin` に置きます（ハッシュを検証）。
- Proton Pass 連携を使わないときは `PROTON_READER_URL= npm run dev` とします（読み取りサービスの起動と `pass-cli` の取得を省きます）。

### 3. 変更を検査する

```sh
npm run typecheck        # 型チェック
npm test                 # 単体テスト
npx playwright test      # 画面のブラウザテスト（ヘッドレス）
npm run lint:spec        # 仕様書の検査
```

### 4. ビルドする

```sh
npm run build            # dist/app・dist/reader・dist/worker・dist/web を生成
npx tsx scripts/icons.ts # アイコンの原画（web/icon.svg）から PWA のアイコンを書き出す（アイコンを変えたときだけ）
```

### 5. 実機で確認する（任意）

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
