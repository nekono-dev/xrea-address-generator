# クラウドの運用

[クラウドへの配備](cloud-deploy.md)を終えたあとの運用の手順です。保持方式、秘密値の更新、全利用者の失効、インスタンス数の固定を扱います。

## 1. 認証情報の保持方式

クラウドでは、認証情報の保持方式を **cookie 方式に固定**します（`CREDENTIAL_STORE=cookie`）。

- cookie 方式は、XREA の認証情報を AES-256-GCM で暗号化して cookie の値にします。サーバに何も保存しないため、Workers がどのインスタンスで動いても、同じ cookie を復号できます。
- SQLite 方式は、ローカルのファイルに保存します。Workers にはファイルも組み込みの SQLite もなく、Cloud Run のようなコンテナではインスタンスごとにファイルが別になり、再起動で消えます。ログイン済みなのに別のインスタンスで 401 になる原因になるため、クラウドでは使えません。Workers は `CREDENTIAL_STORE=sqlite` を起動時に拒否します。
- ネットワークファイルシステム（GCS FUSE、NFS など）にSQLiteを置く構成は、ロックが信頼できず、データベースが壊れるため採りません。

cookie 方式の制約は次のとおりです。

| 制約       | 内容                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| 有効期間   | 登録から7日。7日を過ぎた cookie は未登録として扱われ、利用者は再登録する                   |
| 個別の失効 | できない。ログアウトはブラウザの cookie を消すだけで、複製された cookie は7日間有効        |
| 鍵         | `COOKIE_SECRET` から導出する。変更すると、直前の秘密値を指定しない限り、全員が再登録になる |

失効やログアウトが必要になったときは、複数インスタンスから共有できるストア（Cloudflare D1、Postgres など）へ保持方式を移す必要があります。この実装は現在の対象外です。保持方式は SQL クライアントの差し替えで切り替えられる設計になっています。

ヘッダの「ログアウト」は、ブラウザの cookie を消して登録画面へ戻します。共有端末や、操作を乗っ取られたタブからの継続的な利用を止めるには有効です。一方、すでに複製された cookie（マルウェア、端末の盗難、通信経路のログなど）は、サーバが何も覚えていないため無効にできません。その場合は「4. 全利用者の失効」を行います。

## 2. 秘密値の保管

Workers の秘密（`wrangler secret put` で設定した値）は、あとから読み戻せません。秘密値の更新では旧い値が必要になるため、`COOKIE_SECRET` の控えを Secret Manager に置いてください。

```sh
# 初回: 値を標準出力に出さずに、Secret Manager と Workers の両方へ渡す
openssl rand -base64 48 | tr -d '\n' | gcloud secrets create xrea-cookie-secret --data-file=-
gcloud secrets versions access latest --secret=xrea-cookie-secret | npx wrangler secret put COOKIE_SECRET
```

## 3. 秘密値の更新（利用者は再登録しない）

`COOKIE_SECRET_PREVIOUS` を使うと、更新の前後で、既存の cookie を使い続けられます。暗号文は鍵の識別子を持つため、アプリは直前の秘密値の暗号文を復号し、新しい登録を現行の鍵で暗号化します。

```sh
# 1. 現行の値を、直前の秘密値として設定する（現行と同じ値のため、この時点では動作が変わらない）
gcloud secrets versions access latest --secret=xrea-cookie-secret | npx wrangler secret put COOKIE_SECRET_PREVIOUS

# 2. 新しい値を作り、現行へ差し替える
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add xrea-cookie-secret --data-file=-
gcloud secrets versions access latest --secret=xrea-cookie-secret | npx wrangler secret put COOKIE_SECRET

# 3. 7日後（最後に発行された cookie が期限切れになってから）、直前の秘密値を削除する
npx wrangler secret delete COOKIE_SECRET_PREVIOUS
```

- 順序を守ってください。2 を先にすると、直前の秘密値がないため、全員が再登録になります。
- 直前の秘密値は、復号にだけ使います。直前の鍵で作られた cookie は、期限（7日）まで使われ、自然に新しい鍵の暗号文へ替わります。
- どちらも32文字以上が必要です。足りないと、変数名を示して起動を拒否します。
- 直前の秘密値は1つまでです。更新の途中でもう一度更新すると、2世代前の cookie は未登録になります。

## 4. 全利用者の失効

cookie を個別には失効できないため、漏洩が疑われるときは、**直前の秘密値を設定せずに**現行を差し替えます。差し替え前の cookie はすべて未登録になり、利用者は再登録します。

```sh
# 直前の秘密値が残っていれば先に削除する
npx wrangler secret delete COOKIE_SECRET_PREVIOUS
openssl rand -base64 48 | tr -d '\n' | gcloud secrets versions add xrea-cookie-secret --data-file=-
gcloud secrets versions access latest --secret=xrea-cookie-secret | npx wrangler secret put COOKIE_SECRET
```

XREA の API シークレットキーが漏れた可能性があるときは、XREA 側でも API シークレットキーを再発行してください。

## 5. インスタンス数

| サービス       | 最大インスタンス数 | 理由                                                                                                   |
| -------------- | ------------------ | ------------------------------------------------------------------------------------------------------ |
| xrea-gateway   | 1                  | XREA の API への要求を直列化する。2以上にすると、同じアカウントへの要求が並列になる                    |
| proton-reader  | 1                  | Proton Pass のセッションをファイルで保持し、複数のインスタンスで同時にログインしない                   |
| app（Workers） | 指定しない         | 状態を持たないため、Workers が増減させる。認証情報は cookie にあり、インスタンスの間で共有しなくてよい |

Cloud Run では `--max-instances 1` を指定します。proton-reader は再作成でセッションを失っても、次の要求で自動的に再ログインします。

## 6. 運用の確認

秘密値を更新したあとや、再デプロイのあとに、疎通確認を実行します。

```sh
npx tsx scripts/cloud/check.ts probe --app https://app.example.net --gateway "$GATEWAY_URL"
```
