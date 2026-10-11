# 認証情報セッション タスク一覧

## Phase 1: 型と暗号化

- 対応: D-1, D-2
- [ ] T-1.1: 認証情報の型・保持方式のインターフェース・入力の上限を定義する。
- [ ] T-1.2: 鍵の導出と、暗号化・復号を WebCrypto で実装する。
- [ ] T-1.3: 暗号化・改ざん・鍵違いの単体テストを、受け入れ条件のタグ付きで追加する。
- 検証: `npx vitest run tests/credentials/seal.test.ts`

## Phase 2: cookie方式

- 対応: D-3
- [ ] T-2.1: cookie方式の保持と、Set-Cookie の組み立てを実装する。
- [ ] T-2.2: 期限・属性・サイズの単体テストを、受け入れ条件のタグ付きで追加する。
- [ ] T-2.3: Workersの実行環境で、保存と取り出しが成功するテストを追加する。
- 検証: `npx vitest run tests/credentials/store.test.ts tests/credentials/workers.test.ts`

## Phase 3: SQLite方式

- 対応: D-4
- [ ] T-3.1: SQLクライアントのインターフェースと、組み込みSQLiteによる実装を作る。
- [ ] T-3.2: SQLクライアントにのみ依存する保持方式を実装する（表の作成・保存・取り出し・期限切れの削除・置き換え）。
- [ ] T-3.3: 暗号文だけの保持・期限切れの削除・別のSQLクライアントの実装・標準のsqlite3コマンドでの参照のテストを追加する。
- 検証: `npx vitest run tests/credentials/store.test.ts`

## Phase 4: ルートと設定

- 対応: D-5, D-6
- [ ] T-4.1: 設定の読み込みと、秘密値の長さの検証を実装する。
- [ ] T-4.2: 登録・問い合わせのルートと、未登録を拒否する前段の処理を実装する。
- [ ] T-4.3: 疎通の失敗・401・秘匿値の非出力の単体テストを、受け入れ条件のタグ付きで追加する。
- 検証: `npx vitest run tests/credentials`
