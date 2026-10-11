# ゲートウェイのDurable Object タスク一覧

## Phase 1: 鍵と振り分け

- 対応: D-1
- [x] T-1.1: WebCryptoによる鍵の導出を実装する。
- [x] T-1.2: 鍵ごとのDurable Objectへ要求を振り分ける部品を実装する。
- [x] T-1.3: 同じ認証情報が同じ識別子になり、名前に平文が含まれないことのテストを、受け入れ条件のタグ付きで追加する。
- 検証: `npx vitest run tests/gateway/durable.test.ts -t 振り分け`

## Phase 2: Durable Object本体

- 対応: D-2
- [x] T-2.1: ゲートウェイの処理を包むDurable Objectのクラスを実装する。
- [x] T-2.2: 同時の発行の直列化、別アカウントの非干渉、1.1秒の間隔、キャッシュの有効期間のテストを追加する。
- [x] T-2.3: 永続ストレージへの書き込みが0回であることのテストを追加する。
- 検証: `npx vitest run tests/gateway/durable.test.ts`

## Phase 3: DNS over HTTPS

- 対応: D-3
- [x] T-3.1: DNS over HTTPSの照会と、応答の型・状態の変換を実装する。
- [x] T-3.2: 3秒の打ち切りと、記録が無い場合・失敗の場合の区別を実装する。
- [x] T-3.3: 応答の変換、打ち切り、MXの確認の合否のテストを、受け入れ条件のタグ付きで追加する。
- 検証: `npx vitest run tests/gateway/dohResolver.test.ts`

## Phase 4: 配備の定義と実環境

- 対応: D-4
- [x] T-4.1: 配備の定義と雛形に、束縛と移行を加える。
- [x] T-4.2: Workerの入口でクラスを公開し、ゲートウェイの送信先をDurable Objectの振り分けにする。
- [x] T-4.3: 配備の定義のテストと、Workerの実行環境での応答のテストを追加する。
- [x] T-4.4: 実際のXREA（poc- 接頭辞のアカウント）に対し、同時の一覧と発行を送り、レート制限の応答が出ないことを確認する。
- [x] T-4.5: 実際のWorkersへ配備し、DNS over HTTPSによるMXの確認が成功することを確認する。
- 検証: `npx vitest run tests/cloud/durableConfig.test.ts tests/app/worker.test.ts && XREA_LIVE=1 npx vitest run tests/gateway/durable.live.test.ts`
