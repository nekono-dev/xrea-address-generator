FROM node:22-bookworm-slim AS build
WORKDIR /src
COPY package*.json ./
RUN npm ci
COPY . .
# dist/app・dist/reader・dist/web を生成する
RUN npm run build

FROM node:22-bookworm-slim AS deps
WORKDIR /src
COPY package*.json ./
# 実行に必要な依存だけを取得する
RUN npm ci --omit=dev

# アプリ（XREAゲートウェイを内蔵する）。公式CLIを含めない
FROM node:22-bookworm-slim AS app
WORKDIR /app
COPY --from=build /src/dist /app/dist
COPY --from=deps /src/node_modules /app/node_modules
COPY package.json /app/package.json
# SQLite方式を選んだときの保存先
RUN mkdir -p /var/lib/xrea-address-generator/data \
 && chown -R node:node /var/lib/xrea-address-generator
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
 && apt-get purge -y curl jq && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /src/dist /app/dist
COPY --from=deps /src/node_modules /app/node_modules
COPY package.json /app/package.json
RUN mkdir -p /var/lib/xrea-address-generator/session \
 && chown -R node:node /var/lib/xrea-address-generator
USER node
CMD ["node", "/app/dist/reader/main.js"]
