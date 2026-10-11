# Docker構成 設計書

## 1. 構成

| パス                               | 責務                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `Dockerfile`                       | アプリ・ゲートウェイ用イメージと、読み取りサービス用イメージの作成                        |
| `compose.yaml`                     | 4サービス（アプリ、ゲートウェイ、読み取りサービス、Cloudflare Tunnel）の定義              |
| `compose.lan.yaml`                 | トンネルを使わないときの、アプリのポートの公開の追加定義                                  |
| `.env.example`                     | 環境変数の記入例                                                                          |
| `tests/docker/env.test.ts`         | 記入例の変数の網羅を確認するテスト                                                        |
| `tests/docker/docker.live.test.ts` | 検証サーバでのイメージ・Compose・公開経路・再起動のテスト（DOCKER_LIVE=1 のときだけ実行） |

## 2. 設計項目

### D-1: コンテナイメージ (FR-1, NFR-1, NFR-2)

```dockerfile
FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build            # dist/app・dist/gateway・dist/reader・dist/web を生成する

FROM node:22-bookworm-slim AS deps
WORKDIR /src
COPY package*.json ./
RUN npm ci --omit=dev        # 実行に必要な依存だけを取得する

# アプリとゲートウェイ（同一イメージ。起動するコマンドだけが異なる）
FROM node:22-bookworm-slim AS app
COPY --from=build /src/dist /app/dist
COPY --from=deps /src/node_modules /app/node_modules
USER node
CMD ["node", "/app/dist/app/node.js"]

# 読み取りサービス（公式CLIを同梱する）
FROM node:22-bookworm-slim AS reader
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
CMD ["node", "/app/dist/reader/main.js"]
```

| 項目           | 方針                                                                            |
| -------------- | ------------------------------------------------------------------------------- |
| 基盤           | glibc の Debian slim。Proton Pass CLI の配布バイナリが musl に非対応のため      |
| 公式CLIの分離  | アプリのイメージに公式CLIを含めない。読み取りサービスを配備しなければ存在しない |
| ハッシュ検証   | 配布マニフェストのSHA-256と一致しなければビルドを失敗させる                     |
| アーキテクチャ | ビルド中の uname -m（x86_64・aarch64）で配布物を選ぶ。buildx の有無に依存しない |
| 実行ユーザー   | node（非特権）                                                                  |

### D-2: Docker Compose (FR-2, FR-3, FR-4, FR-6, FR-7, FR-9, FR-12, NFR-4)

```yaml
x-common: &common
  restart: unless-stopped
  env_file: ${ENV_FILE:-.env} # 既定は .env。テストでは別のファイルを指定する

services:
  app:
    <<: *common
    build: { context: ., target: app }
    image: xrea-address-generator:local
    environment:
      PORT: "3000"
      BIND_ADDRESS: "0.0.0.0"
      COOKIE_SECURE: "1" # environment は env_file より優先される。トンネル経由はHTTPSなので常に Secure を付ける
      XREA_GATEWAY_URL: http://xrea-gateway:8081
      PROTON_READER_URL: ${PROTON_READER_URL:-} # 空なら Proton Pass 連携を使わない
      CREDENTIAL_DB_PATH: /var/lib/xrea-address-generator/data/sessions.db
      TUNNEL_TOKEN: ${TUNNEL_TOKEN:-}
    volumes: [app-data:/var/lib/xrea-address-generator/data]
    depends_on: { xrea-gateway: { condition: service_healthy } }
  xrea-gateway:
    <<: *common
    image: xrea-address-generator:local
    command: ["node", "/app/dist/gateway/main.js"]
    environment: { PORT: "8081", BIND_ADDRESS: "0.0.0.0" }
    deploy: { replicas: 1 } # 直列化のため1インスタンスに固定する
  proton-reader:
    <<: *common
    profiles: [proton] # COMPOSE_PROFILES=proton のときだけ起動する
    build: { context: ., target: reader }
    image: xrea-address-generator-reader:local
    environment: { PORT: "8082", BIND_ADDRESS: "0.0.0.0", SESSION_DIR: /var/lib/xrea-address-generator/session }
    volumes: [reader-session:/var/lib/xrea-address-generator/session]
  cloudflared:
    <<: *common
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    deploy: { replicas: 0${TUNNEL_TOKEN:+1} } # トークンが空なら 0、あれば 1 になる
    environment: { TUNNEL_TOKEN: "${TUNNEL_TOKEN}" }
    depends_on: { app: { condition: service_healthy } }
volumes:
  app-data:
  reader-session:
```

| 方針             | 内容                                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| ポート           | compose.yaml のどのサービスにも ports を書かず、ホストへ公開しない                                        |
| 内部通信         | ゲートウェイと読み取りサービスは、Composeの内部ネットワークのサービス名でのみ接続できる                   |
| 永続化           | reader-session（Proton Passのセッション）と app-data（SQLite方式のときだけ使う）の2つの名前付きボリューム |
| cookie の Secure | compose.yaml で COOKIE_SECURE を 1 に固定し、compose.lan.yaml だけが 0 に上書きする                       |
| トンネルの接続先 | Cloudflareの管理画面で、公開ホスト名の接続先を http://app:3000 にする                                     |

```yaml
# compose.lan.yaml（トンネルを使わないとき、compose.yaml に重ねて指定する）
# docker compose -f compose.yaml -f compose.lan.yaml up -d
services:
  app:
    ports: ["3000:3000"]
    environment: { COOKIE_SECURE: "0" } # HTTPのLAN接続でも cookie を保持する
```

### D-3: 環境変数の記入例 (FR-5, FR-10)

| 変数              | 必須 | 既定値 | 内容                                                                 |
| ----------------- | ---- | ------ | -------------------------------------------------------------------- |
| COOKIE_SECRET     | 必須 | なし   | 32文字以上。認証情報の暗号化の鍵の導出に使う                         |
| INTERNAL_TOKEN    | 必須 | なし   | 32文字以上。アプリとゲートウェイ・読み取りサービスの共有シークレット |
| CREDENTIAL_STORE  | 任意 | cookie | cookie または sqlite                                                 |
| COMPOSE_PROFILES  | 任意 | 空     | proton を指定すると読み取りサービスを起動する                        |
| PROTON_READER_URL | 任意 | 空     | proton を選ぶときは http://proton-reader:8082                        |
| TUNNEL_TOKEN      | 任意 | なし   | Cloudflare Tunnelのトークン。空ならトンネルを使わない                |
| LOG_LEVEL         | 任意 | info   | ログの詳細度                                                         |

記入例のファイルには、上の全変数を並べ、必須の値は空にする。実際の値を入れた環境変数ファイルは、リポジトリへ含めない。Compose の定義では、必須の2変数を `${COOKIE_SECRET:?COOKIE_SECRET を設定してください}` の形で参照し、空のときは起動を拒否する。

```sh
# tests/docker/env.test.ts の中核（同じ判定を TypeScript で行う）: 必須の変数がすべて記入例に含まれる
for k in COOKIE_SECRET INTERNAL_TOKEN; do
  grep -q "^$k=" .env.example || { echo "不足: $k"; exit 1; }
done
```

### D-4: 死活確認と再起動 (FR-8, NFR-3)

| サービス      | 死活確認                                 | 間隔・失敗回数 |
| ------------- | ---------------------------------------- | -------------- |
| app           | GET http://127.0.0.1:3000/healthz が 200 | 10秒・3回      |
| xrea-gateway  | GET http://127.0.0.1:8081/healthz が 200 | 10秒・3回      |
| proton-reader | GET http://127.0.0.1:8082/healthz が 200 | 10秒・3回      |

```yaml
healthcheck:
  test:
    [
      "CMD",
      "node",
      "-e",
      "fetch('http://127.0.0.1:${PORT}/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
    ]
  interval: 10s
  timeout: 3s
  retries: 3
```

再起動は restart を unless-stopped とし、停止または異常判定のコンテナを再起動する。起動の所要時間は、環境変数の検証・サーバの起動を3秒以内、全コンテナの死活確認の初回成功まで30秒以内とする。

### D-5: 権限の制限 (FR-11)

```yaml
# xrea-gateway と proton-reader に付ける
read_only: true
cap_drop: [ALL]
security_opt: ["no-new-privileges:true"]
tmpfs: ["/tmp"]
```

読み取りサービスの書き込み先は、セッションの名前付きボリュームと /tmp のみとする。

## 3. エラー処理

| 事象                              | 処理                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| Proton Pass CLIのハッシュが不一致 | イメージのビルドを中止し、不一致を表示する                      |
| 必須の環境変数が未設定            | Composeが変数名を示して起動を拒否する                           |
| 読み取りサービスのURLが空         | アプリがProton Pass連携を使わず、読み取りサービスを呼び出さない |
| トンネルのトークンが無効          | cloudflared のみが失敗し、アプリは稼働を続ける                  |
| 死活確認が3回連続で失敗           | コンテナを異常と判定し、再起動する                              |
