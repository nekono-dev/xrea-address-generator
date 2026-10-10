# XREA Address Generator

XREA のメール転送アドレス（エイリアス）を、ワンボタンで発行・管理する Web アプリです。発行したアドレスは指定のメールボックスへ転送されます。Proton Pass の Vault を読み取り、各アドレスがどのサービスで使われているか（エントリ名）を一覧に表示します。

- 名前を空にして発行すると、`quiet.river42` の形のランダムな名前を付けます。
- 転送先は候補（XREA の既存の転送先）から選ぶか、自由に入力できます。
- アプリ独自のデータベースは持ちません。状態は XREA と Proton Pass から導き出します。
- Proton Pass への書き込みは行いません（読み取り専用のアクセストークンで動作します）。

## 構成

| ディレクトリ | 内容 |
| --- | --- |
| `src/xrea` | XREA API の型付きクライアント（公式ドキュメントから生成した OpenAPI に基づく） |
| `src/proton` | Proton Pass CLI（`pass-cli`）による読み取りと、アドレス→エントリ名の対応表 |
| `src/server` | HTTP API と画面ファイルの配信（Hono） |
| `web` | 画面（Preact。ブラウザ標準の部品は使わず、すべて独自の部品で構成） |
| `api` | 公式ドキュメントの基準・補正定義・生成した OpenAPI |
| `installer` | LXC／ベアメタル向けインストーラ |
| `specs` | 仕様書（要件定義・設計・タスク） |

仕様書は `specs/<コンポーネント>/` にあり、`npm run lint:spec` で検査します。

## 導入の前に用意するもの

1. **XREA の API シークレットキー**: コントロールパネルで発行します。
2. **Proton Pass の読み取り専用アクセストークン**（有料プラン）:
   ```sh
   pass-cli login                                  # ブラウザでログイン
   pass-cli pat create --name xrea-address-generator --expiration 1y
   pass-cli pat access grant --personal-access-token-name xrea-address-generator \
     --vault-name "<照合に使うVault名>" --role viewer
   ```
3. **Cloudflare Tunnel のトークン**: 公開ホスト名の接続先は、Docker 構成では `http://app:3000`、LXC 構成では `http://127.0.0.1:3000` にします。アクセス制御は Cloudflare Access で行ってください（アプリ自身は認証を持ちません）。

## Docker で動かす（アプリと Cloudflare Tunnel の2コンテナ）

```sh
cp .env.example .env   # 値を記入する（このファイルはリポジトリに含めない）
docker compose up -d
```

ホストへポートは公開しません。永続化するのは Proton Pass のセッションの保存先（名前付きボリューム）だけです。

## LXC（Ubuntu）・ベアメタルで動かす

Ubuntu 24.04 のコンテナ内で、root として実行します。秘匿値は `ps` やシェルの履歴に残らないよう、環境変数で渡してください。

```sh
curl -fsSL https://github.com/nekono-dev/xrea-address-generator/releases/latest/download/install.sh -o install.sh
sudo env XREA_API_SECRET_KEY='…' PROTON_PASS_PERSONAL_ACCESS_TOKEN='…' TUNNEL_TOKEN='…' \
  sh install.sh install --set XREA_ACCOUNT=… --set XREA_SERVER_NAME=… --set PROTON_PASS_VAULT_NAME=…
```

LXD のホストから入れる場合:

```sh
lxc exec <コンテナ名> --env XREA_API_SECRET_KEY='…' --env PROTON_PASS_PERSONAL_ACCESS_TOKEN='…' -- \
  sh -c 'curl -fsSL <URL>/install.sh | sh -s -- install --set XREA_ACCOUNT=… --set XREA_SERVER_NAME=… --set PROTON_PASS_VAULT_NAME=…'
```

- 設定は `/etc/xrea-address-generator/xrea-address-generator.env`（権限600）に保存されます。手で編集した値は、再導入や更新でも保持されます。
- `TUNNEL_TOKEN` を設定すると cloudflared も導入します（空にすると取り除きます）。
- 導入後は常設コマンドで管理します。

| コマンド | 動作 |
| --- | --- |
| `xrea-address-generator-ctl update` | 導入時のブランチ・タグの最新へ追従し、再ビルドして再起動する（Proton Pass CLI も最新版を取得し直す） |
| `xrea-address-generator-ctl status` | 導入先・参照名・コミット・取得元・更新日時を表示する |
| `xrea-address-generator-ctl uninstall` | アプリ本体を削除する（設定とデータは残す） |
| `xrea-address-generator-ctl uninstall --purge` | 設定・データ・専用ユーザーも削除する |

## 環境変数

| 変数 | 必須 | 既定値 | 内容 |
| --- | --- | --- | --- |
| `XREA_ACCOUNT` | 必須 | | XREA のアカウントID |
| `XREA_SERVER_NAME` | 必須 | | XREA のサーバ名 |
| `XREA_API_SECRET_KEY` | 必須 | | XREA の API シークレットキー |
| `PROTON_PASS_PERSONAL_ACCESS_TOKEN` | 必須 | | Proton Pass の読み取り専用アクセストークン |
| `PROTON_PASS_VAULT_NAME` | 必須 | | 照合に使う Vault 名 |
| `TUNNEL_TOKEN` | 任意 | | Cloudflare Tunnel のトークン |
| `BIND_ADDRESS` | 任意 | `127.0.0.1` | 待ち受けるアドレス |
| `PORT` | 任意 | `3000` | 待ち受けるポート |
| `SESSION_DIR` | 任意 | `/var/lib/xrea-address-generator/session` | Proton Pass のセッション保存先 |
| `LOG_LEVEL` | 任意 | `info` | ログの詳細度 |

## 開発

```sh
npm ci
npm run typecheck        # 型チェック
npm test                 # 単体テスト
npx playwright test      # 画面のブラウザテスト（ヘッドレス）
npm run build            # dist/server と dist/web を生成
npm run lint:spec        # 仕様書の検査
```

開発時は、`npx tsx src/server/main.ts`（環境変数が必要）と `npx vite --config vite.config.ts` を並べて起動します。`/api` は Vite からサーバへ転送されます。

実機を使うテストは、変数を指定したときだけ実行されます（`.env` の値を環境変数として読み込んでから実行してください）。

| 変数 | 対象 |
| --- | --- |
| `XREA_LIVE=1` | 実際の XREA API に対する契約テスト・発行と削除（`poc-` で始まる名前だけを作成・削除する） |
| `DOCKER_LIVE=1` | イメージ・Compose・公開経路・再起動 |
| `LXD_LIVE=1` | 使い捨ての LXD コンテナでの導入・更新・アンインストール（LXD のホストで実行） |

## XREA API の変更に追従する

XREA のクライアントは、公式ドキュメント（apidoc.xrea.com）から生成した OpenAPI に基づいています。

```sh
npm run docs:check       # 基準（api/snapshot）との差分を検知する。差分があれば終了コード1
npm run docs:snapshot    # 差分を確認したうえで、基準を更新する
npm run docs:all         # OpenAPI（api/xrea.openapi.yaml）と型（src/xrea/generated）を再生成する
XREA_LIVE=1 npx vitest run tests/xrea/contract.live.test.ts   # 実際のAPIとの整合を確かめる
```

公式ドキュメントの誤記や、実際の API との違いは `api/overlay.yaml`（JSON Merge Patch）で補正します。新しいエンドポイントを使うときは、`scripts/xrea-docs/fetch.ts` と `scripts/xrea-docs/generate.ts` の対象一覧に追加します。
