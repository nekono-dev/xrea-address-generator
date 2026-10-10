# Docker構成 タスク一覧

## Phase 1: コンテナイメージと記入例

- 対応: D-1, D-3
- [x] T-1.1: 環境変数の記入例を作成し、必須の変数の網羅を確認するテストを追加する。
- [x] T-1.2: ハッシュ検証つきでProton Pass CLIを同梱するイメージの定義を作成する。
- [x] T-1.3: イメージのサイズ・CLIの実行・ハッシュ不一致の失敗を確認するテストを追加する。
- [x] T-1.4: 記入例のアクセストークンの任意化と、Vault名の削除を反映する。
- 検証: `npx vitest run tests/docker/env.test.ts && DOCKER_LIVE=1 npx vitest run tests/docker/docker.live.test.ts -t image`

## Phase 2: Docker Composeと公開経路

- 対応: D-2, D-4
- [x] T-2.1: アプリとCloudflare Tunnelの2コンテナを定義し、ポートを公開しない構成にする。
- [x] T-2.2: 死活確認と自動再起動を設定する。
- [x] T-2.3: 検証サーバで起動し、起動から死活確認の成功までの時間とポートの公開状況を確認する。
- [x] T-2.4: アプリを強制終了し、自動で再起動して死活確認が成功することを確認する。
- [x] T-2.5: トンネルのトークンが空のときにトンネルのコンテナを起動しない定義と、LAN用の追加定義を作成する。
- [x] T-2.6: 検証サーバで、トークンが空の構成を起動し、LAN用の追加定義でホストの外部アドレスから接続できることを確認する。
- 検証: `DOCKER_LIVE=1 npx vitest run tests/docker/docker.live.test.ts -t compose`
