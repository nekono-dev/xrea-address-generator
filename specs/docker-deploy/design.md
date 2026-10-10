# Docker構成 設計書

## 1. 構成

| パス                               | 責務                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `Dockerfile`                       | アプリのコンテナイメージの作成                                                            |
| `compose.yaml`                     | アプリとCloudflare Tunnelの2コンテナの定義                                                |
| `compose.lan.yaml`                 | トンネルを使わないときの、アプリのポートの公開の追加定義                                  |
| `.env.example`                     | 環境変数の記入例                                                                          |
| `tests/docker/env.test.ts`         | 記入例の変数の網羅を確認するテスト                                                        |
| `tests/docker/docker.live.test.ts` | 検証サーバでのイメージ・Compose・公開経路・再起動のテスト（DOCKER_LIVE=1 のときだけ実行） |

## 2. 設計項目

### D-1: コンテナイメージ (FR-1, NFR-1)

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build            # dist/server と dist/web を生成する

FROM node:22-bookworm-slim AS deps
WORKDIR /src
COPY package*.json ./
RUN npm ci --omit=dev        # 実行に必要な依存だけを取得する

FROM node:22-bookworm-slim
# テストでハッシュ不一致を再現するときだけ指定する（通常は空で、配布マニフェストの値を使う）
ARG PASS_CLI_SHA256=""
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates jq \
 && ARCH=$(uname -m) \
 && M=$(curl -fsSL https://proton.me/download/pass-cli/versions.json) \
 && URL=$(echo "$M" | jq -r ".passCliVersions.urls.linux.$ARCH.url") \
 && SHA=${PASS_CLI_SHA256:-$(echo "$M" | jq -r ".passCliVersions.urls.linux.$ARCH.hash")} \
 && curl -fsSL -o /usr/local/bin/pass-cli "$URL" \
 && echo "$SHA  /usr/local/bin/pass-cli" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/pass-cli \
 && apt-get purge -y curl jq && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/dist /app/dist
COPY --from=deps /src/node_modules /app/node_modules
RUN mkdir -p /var/lib/xrea-address-generator/session \
 && chown -R node:node /var/lib/xrea-address-generator
USER node
CMD ["node", "/app/dist/server/main.js"]
```

| 項目           | 方針                                                                            |
| -------------- | ------------------------------------------------------------------------------- |
| 基盤           | glibc の Debian slim。Proton Pass CLI の配布バイナリが musl に非対応のため      |
| ハッシュ検証   | 配布マニフェストのSHA-256と一致しなければビルドを失敗させる                     |
| アーキテクチャ | ビルド中の uname -m（x86_64・aarch64）で配布物を選ぶ。buildx の有無に依存しない |
| 実行ユーザー   | node（非特権）                                                                  |
| サイズ         | 開発用の依存と取得用の道具をイメージに残さず、500メガバイト以下に収める         |

### D-2: Docker Compose (FR-2, FR-3, FR-7, NFR-3)

```yaml
services:
  app:
    build: .
    image: xrea-address-generator:local # docker build で作ったイメージも、この名前で使える
    env_file: ${ENV_FILE:-.env} # 既定は .env。テストでは別のファイルを指定する
    environment:
      BIND_ADDRESS: "0.0.0.0"
      PORT: "3000"
      SESSION_DIR: /var/lib/xrea-address-generator/session
    volumes: [proton-session:/var/lib/xrea-address-generator/session]
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ]
      interval: 10s
      timeout: 3s
      retries: 3
    restart: unless-stopped
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    deploy: { replicas: 0${TUNNEL_TOKEN:+1} } # トークンが空なら 0、あれば 1 になる
    environment: { TUNNEL_TOKEN: "${TUNNEL_TOKEN}" }
    depends_on: { app: { condition: service_healthy } }
    restart: unless-stopped
volumes:
  proton-session:
```

```yaml
# compose.lan.yaml（トンネルを使わないとき、compose.yaml に重ねて指定する）
# docker compose -f compose.yaml -f compose.lan.yaml up -d
services:
  app:
    ports: ["3000:3000"]
```

| 方針             | 内容                                                                  |
| ---------------- | --------------------------------------------------------------------- |
| ポート           | compose.yaml のどのサービスにも ports を書かず、ホストへ公開しない    |
| LAN用の公開      | トークンが空のときだけ、compose.lan.yaml でアプリのポートを公開する   |
| 永続化           | 名前付きボリューム1つ（セッションの保存先）のみ                       |
| トンネルの接続先 | Cloudflareの管理画面で、公開ホスト名の接続先を http://app:3000 にする |

### D-3: 環境変数の記入例 (FR-4)

| 変数                              | 必須 | 既定値 | 内容                                                            |
| --------------------------------- | ---- | ------ | --------------------------------------------------------------- |
| XREA_ACCOUNT                      | 必須 | なし   | XREAのアカウントID                                              |
| XREA_SERVER_NAME                  | 必須 | なし   | XREAのサーバ名                                                  |
| XREA_API_SECRET_KEY               | 必須 | なし   | XREAのAPIシークレットキー                                       |
| PROTON_PASS_PERSONAL_ACCESS_TOKEN | 任意 | なし   | 読み取り専用のアクセストークン。空ならProton Pass連携を使わない |
| TUNNEL_TOKEN                      | 任意 | なし   | Cloudflare Tunnelのトークン。空ならトンネルを使わない           |
| LOG_LEVEL                         | 任意 | info   | ログの詳細度                                                    |

記入例のファイルには、上の全変数を値を空にして並べる。実際の値を入れた環境変数ファイルは、リポジトリへ含めない。待ち受けアドレス・ポート・セッション保存先は、Composeの定義で固定する。

```sh
# tests/docker/env.test.ts の中核（同じ判定を TypeScript で行う）: 必須の3変数がすべて記入例に含まれる
for k in XREA_ACCOUNT XREA_SERVER_NAME XREA_API_SECRET_KEY; do
  grep -q "^$k=" .env.example || { echo "不足: $k"; exit 1; }
done
```

### D-4: 公開経路と死活確認 (FR-5, FR-6, NFR-2)

| 項目           | 設定                                                                  |
| -------------- | --------------------------------------------------------------------- |
| 公開経路       | 内部ネットワークのみ。cloudflared が http://app:3000 へ接続する       |
| 死活確認       | GET /healthz が 200 を返す。10秒間隔、3回連続の失敗で異常と判定する   |
| 再起動         | restart を unless-stopped とし、停止または異常判定のコンテナを再起動  |
| 起動の所要時間 | 環境変数の検証・サーバの起動を3秒以内、死活確認の初回成功まで30秒以内 |

## 3. エラー処理

| 事象                              | 処理                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| Proton Pass CLIのハッシュが不一致 | イメージのビルドを中止し、不一致を表示する                    |
| 必須の環境変数が未設定            | アプリが変数名を表示して終了コード1で終了し、再起動を繰り返す |
| トンネルのトークンが無効          | cloudflared のみが失敗し、アプリは稼働を続ける                |
| 死活確認が3回連続で失敗           | コンテナを異常と判定し、再起動する                            |
