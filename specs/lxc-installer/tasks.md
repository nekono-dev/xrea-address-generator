# LXCインストーラ タスク一覧

## Phase 1: インストーラの土台と設定

- 対応: D-1, D-2
- [x] T-1.1: ブートストラップ型インストーラの作業方式に沿って、ひな形・生成スクリプト・本体・ワークフローを配置する。
- [x] T-1.2: 設定スキーマにキーを宣言し、プレースホルダを実値へ置換する。
- [x] T-1.3: 生成した install.sh の構文検査と shellcheck を通す。
- [x] T-1.4: 必須欠如・優先順位・保持・未宣言キー・不正値のテストを追加する。
- [x] T-1.5: アクセストークンの任意化とVault名の削除をスキーマに反映し、取得の手段と案内を wget に改める。
- 検証: `npx vitest run tests/installer/workflow.test.ts && LXD_LIVE=1 npx vitest run tests/installer/lxd.live.test.ts -t config`

## Phase 2: 導入とサービス

- 対応: D-3, D-4
- [x] T-2.1: 導入のフックに、手順1から6を実装する。
- [x] T-2.2: アプリと cloudflared のサービス定義を書き出す処理を実装する。
- [x] T-2.3: 使い捨てのLXDコンテナで、導入・再実行・稼働・外部からの接続不可・強制終了後の再起動を確認するテストを追加する。
- [x] T-2.4: トンネルのトークンの有無で待ち受けアドレスが切り替わることを、使い捨てのLXDコンテナで確認するテストを追加する。
- [x] T-2.5: Proton Passのアクセストークンを指定しない導入が成功することを、使い捨てのLXDコンテナで確認するテストを追加する。
- 検証: `LXD_LIVE=1 npx vitest run tests/installer/lxd.live.test.ts -t install`

## Phase 3: 更新とアンインストール

- 対応: D-5, D-6
- [x] T-3.1: アンインストールと完全削除のフックを実装する。
- [x] T-3.2: 新しいコミットを配布し、常設コマンドの更新で追従と新キーの追記を確認するテストを追加する。
- [x] T-3.3: アンインストールと完全削除の後に残るものを確認するテストを追加する。
- 検証: `LXD_LIVE=1 npx vitest run tests/installer/lxd.live.test.ts -t lifecycle`

## Phase 4: CIによる配布物の生成

- 対応: D-7
- [x] T-4.1: ワークフローに、プロジェクト固有の検査と、出力先 installer-dist を設定する。
- [x] T-4.2: ブランチとタグのプッシュ、手動実行での生成と添付を確認する。
- 検証: `for f in installer/*.sh; do sh -n "$f"; done && shellcheck -S warning installer/*.sh`
