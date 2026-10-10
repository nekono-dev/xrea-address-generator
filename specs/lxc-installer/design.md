# LXCインストーラ 設計書

## 1. 構成

| パス                                      | 責務                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `installer/bootstrap.sh.tmpl`             | 頒布する install.sh のひな形（取得・一致確認・本体の起動だけの薄い層）                           |
| `installer/build-bootstrap.sh`            | ひな形へ参照名・コミット・取得元URLを埋め込み、install.sh を生成                                 |
| `installer/main.sh`                       | 本体（導入・更新・アンインストール・状態表示、設定の検証と反映、常設コマンドの配置）             |
| `installer/config.schema`                 | 設定ファイルに持てるキーの宣言                                                                   |
| `.github/workflows/release-installer.yml` | インストーラの検査・生成・頒布                                                                   |
| `tests/installer/workflow.test.ts`        | 生成スクリプトとワークフローの定義のテスト                                                       |
| `tests/installer/lxd.live.test.ts`        | 使い捨てのLXDコンテナでの設定・導入・更新・アンインストールのテスト（LXD_LIVE=1 のときだけ実行） |

## 2. 設計項目

### D-1: 構成と実行の流れ (FR-1)

```text
[install.sh]  wget -qO- … | sudo sh -s -- install | update | uninstall
   │  取得（埋め込んだコミットに固定）→ コミットの一致確認 → 本体へ委譲
   ▼
[installer/main.sh]  設定の検証と反映 → 導入メタ情報の記録 → 常設コマンドの配置 → 導入のフック
   ▼
[/usr/local/bin/xrea-address-generator-ctl]  update | uninstall [--purge] | status
```

```sh
# 導入（秘匿値は、履歴に残らない環境変数で渡す）
wget -qO- https://github.com/nekono-dev/xrea-address-generator/releases/latest/download/install.sh \
  | sudo env XREA_API_SECRET_KEY=… PROTON_PASS_PERSONAL_ACCESS_TOKEN=… sh -s -- install --set XREA_ACCOUNT=… --set XREA_SERVER_NAME=…
# LXDのホストから、コンテナへ導入する
lxc exec <コンテナ名> --env XREA_API_SECRET_KEY=… -- sh -c 'wget -qO- <URL>/install.sh | sh -s -- install --set …'
```

| 種別         | パス                                                                                  |
| ------------ | ------------------------------------------------------------------------------------- |
| ソース       | /opt/xrea-address-generator（環境変数 XREA_ADDRESS_GENERATOR_DIR で、導入時のみ変更） |
| 設定         | /etc/xrea-address-generator/xrea-address-generator.env（権限600）                     |
| 導入メタ情報 | /var/lib/xrea-address-generator-installer/state                                       |
| データ       | /var/lib/xrea-address-generator（Proton Passのセッションを含む）                      |
| 常設コマンド | /usr/local/bin/xrea-address-generator-ctl                                             |

### D-2: 設定スキーマと優先順位 (FR-4, FR-5, FR-6, FR-7)

```text
# installer/config.schema  KEY|既定値|required または optional|説明
XREA_ACCOUNT||required|XREAのアカウントID
XREA_SERVER_NAME||required|XREAのサーバ名
XREA_API_SECRET_KEY||required|XREAのAPIシークレットキー
PROTON_PASS_PERSONAL_ACCESS_TOKEN||optional|Proton Passの読み取り専用アクセストークン（未指定ならProton Pass連携を使わない）
TUNNEL_TOKEN||optional|Cloudflare Tunnelのトークン（指定するとcloudflaredを導入する。未指定ならLANに公開する）
BIND_ADDRESS||optional|待ち受けるアドレス（未指定ならTUNNEL_TOKENがあれば127.0.0.1、無ければ0.0.0.0）
PORT|3000|optional|待ち受けるポート
SESSION_DIR|/var/lib/xrea-address-generator/session|optional|Proton Passのセッション保存先
LOG_LEVEL|info|optional|ログの詳細度
```

| 優先 | 値の出どころ       | 備考                                                       |
| ---- | ------------------ | ---------------------------------------------------------- |
| 1    | 指定オプション     | 設定ファイルへ上書きして反映する                           |
| 2    | 環境変数           | 宣言済みのキーと同名のものだけを参照し、上書きして反映する |
| 3    | 既存の設定ファイル | 手で編集した値を保持する                                   |
| 4    | 既定値             | 設定ファイルに無いキーを追記するときだけ使う               |

| 検証                               | 結果                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| 必須のキーがどの出どころにも無い   | 変更の前に、不足しているキー名を表示して中止する         |
| 指定オプションのキーが宣言に無い   | 変更の前に中止する                                       |
| 値にアポストロフィまたは改行がある | 変更の前に中止する                                       |
| 値の表示                           | ログには、キー名と、値の出どころだけを出し、値は出さない |

### D-3: 導入のフック (FR-2, FR-3, NFR-1)

プロジェクト固有の処理は、本体の導入・アンインストール・完全削除の3つのフックだけに書く。導入のフックは何度実行しても同じ結果にする。

```sh
app_install() {
  . /etc/os-release; [ "$ID" = "ubuntu" ] || die "Ubuntu のみ対応しています"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q && apt-get install -y -q wget jq ca-certificates
  [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)" = "22" ] \
    || { wget -qO- https://deb.nodesource.com/setup_22.x | sh && apt-get install -y -q nodejs; }
  M=$(wget -qO- https://proton.me/download/pass-cli/versions.json); A=$(uname -m)
  URL=$(printf '%s' "$M" | jq -r ".passCliVersions.urls.linux.$A.url")
  SHA=$(printf '%s' "$M" | jq -r ".passCliVersions.urls.linux.$A.hash")
  wget -q -O /tmp/pass-cli "$URL" && echo "$SHA  /tmp/pass-cli" | sha256sum -c - \
    && install -m 0755 /tmp/pass-cli /usr/local/bin/pass-cli && rm -f /tmp/pass-cli
  id xrea-gen >/dev/null 2>&1 || useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin xrea-gen
  mkdir -p "$DATA_DIR/session" && chown -R xrea-gen:xrea-gen "$DATA_DIR"
  (cd "$DIR" && npm ci && npm run build && npm prune --omit=dev)
  # サービス定義を書き出す（内容は次の設計項目）
  systemctl daemon-reload && systemctl enable xrea-address-generator && systemctl restart xrea-address-generator
  # shellcheck source=/dev/null
  . "$CONF_FILE"
  if [ -n "${TUNNEL_TOKEN:-}" ]; then
    install -d -m 0755 /usr/share/keyrings
    wget -q -O /usr/share/keyrings/cloudflare-main.gpg https://pkg.cloudflare.com/cloudflare-main.gpg
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' > /etc/apt/sources.list.d/cloudflared.list
    apt-get update -q && apt-get install -y -q cloudflared
    systemctl enable cloudflared-xrea && systemctl restart cloudflared-xrea
  elif [ -f /etc/systemd/system/cloudflared-xrea.service ]; then
    systemctl disable --now cloudflared-xrea && rm -f /etc/systemd/system/cloudflared-xrea.service
  fi
}
```

| 手順 | 処理                                                                                | 冪等性の確保                       |
| ---- | ----------------------------------------------------------------------------------- | ---------------------------------- |
| 1    | OSが Ubuntu であることを確認する                                                    | 条件に反すれば何も変更せず終了する |
| 2    | Node.js 22 を導入する                                                               | 版が合えばスキップする             |
| 3    | Proton Pass CLI を、配布マニフェストのSHA-256を検証して導入する                     | 上書きして同じ結果になる           |
| 4    | 専用ユーザーとデータディレクトリを作成する                                          | 存在すればスキップする             |
| 5    | 取得先でビルドし、実行に不要な依存を取り除く                                        | 同じコミットなら同じ結果になる     |
| 6    | サービスを登録して再起動する。トークンがあればcloudflaredも同様にし、空なら取り除く | 登録済みなら再読み込みと再起動のみ |

### D-4: サービス定義 (FR-11, NFR-2, NFR-3)

```ini
# xrea-address-generator.service
[Unit]
Description=XREA address generator
After=network-online.target
Wants=network-online.target

[Service]
User=xrea-gen
EnvironmentFile=/etc/xrea-address-generator/xrea-address-generator.env
Environment=HOME=/var/lib/xrea-address-generator
ExecStart=/usr/bin/node /opt/xrea-address-generator/dist/server/main.js
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/xrea-address-generator

[Install]
WantedBy=multi-user.target
```

```ini
# cloudflared-xrea.service（トークンがあるときだけ登録する）
[Service]
DynamicUser=yes
EnvironmentFile=/etc/xrea-address-generator/xrea-address-generator.env
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run
Restart=always
```

| 項目             | 内容                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------- |
| 待ち受け         | BIND_ADDRESS が未指定なら、トークンがあるときは 127.0.0.1（ループバックだけ）、無いときは 0.0.0.0（LANへ公開） |
| トンネルの接続先 | 同一コンテナ内の cloudflared が http://127.0.0.1:3000 へ接続する                                               |
| 死活確認         | GET /healthz が 200 を返す。起動から30秒以内の初回成功を確認する                                               |
| 設定の読み込み   | 設定ファイルはroot所有の600のまま、サービス管理側が読み込んでアプリへ環境変数として渡す                        |
| 検証用コンテナ   | テストは ubuntu:24.04 から使い捨てのコンテナを作り、終了後に破棄する                                           |

### D-5: 更新 (FR-8, NFR-4)

| 実行                  | 動作                                                       |
| --------------------- | ---------------------------------------------------------- |
| 常設コマンドの update | 導入メタ情報の参照名の最新を取得し、新しい本体で再適用する |
| install.sh の update  | その install.sh に埋め込んだコミットへ揃える               |
| 常設コマンドの status | 導入先・参照名・コミット・取得元・更新日時を表示する       |

更新の手順を次に示す。

| 手順 | 処理                                                                           |
| ---- | ------------------------------------------------------------------------------ |
| 1    | 取得先に未コミットの変更があれば、何も変更せずに中止する                       |
| 2    | 参照名の最新を取得して切り替え、新しい本体を起動する                           |
| 3    | 設定を検証し、スキーマで増えたキーを既定値で追記する（手編集した値は変えない） |
| 4    | 導入メタ情報を更新し、導入のフックを再実行してビルドとサービスの再起動を行う   |

### D-6: アンインストール (FR-9, FR-10)

| 対象                                                  | 通常 | 完全削除 |
| ----------------------------------------------------- | ---- | -------- |
| アプリと cloudflared のサービス、サービス定義         | 削除 | 削除     |
| 常設コマンド、取得先ディレクトリ                      | 削除 | 削除     |
| 設定ファイル、データ（Proton Passのセッションを含む） | 残す | 削除     |
| 導入メタ情報                                          | 残す | 削除     |
| 専用ユーザー                                          | 残す | 削除     |
| Node.js、Proton Pass CLI、cloudflared のパッケージ    | 残す | 残す     |

```sh
app_uninstall() {
  for s in cloudflared-xrea xrea-address-generator; do
    systemctl disable --now "$s" 2>/dev/null || true
    rm -f "/etc/systemd/system/$s.service"
  done
  systemctl daemon-reload
}
app_purge() { userdel xrea-gen 2>/dev/null || true; }
```

### D-7: CIによる配布物の生成 (FR-12)

| トリガー                     | 動作                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ブランチへのプッシュ         | 検査後に install.sh と install.sh.sha256 を生成し、成果物として保存し、ブランチ名を元にしたタグのPre-releaseを作り直して添付する |
| タグ（v で始まる）のプッシュ | 同じ検査と生成を行い、Releaseへ添付する。最新版は releases/latest/download/install.sh から取得できる                             |
| 手動実行                     | 選んだブランチまたはタグで、上記と同じ処理を再度実行する                                                                         |

```yaml
# release-installer.yml の固有の検査（シェルの構文と shellcheck に続けて実行する）
- uses: actions/setup-node@v4
  with: { node-version: 22 }
- run: npm ci && npm run lint:spec && npm test && npm run build
```

生成物の出力先はアプリのビルド出力と別のディレクトリ（installer-dist）にして、混在を避ける。

## 3. エラー処理

| 事象                                       | 処理                                                               |
| ------------------------------------------ | ------------------------------------------------------------------ |
| root 以外で実行した                        | 何も変更せずに、root権限が必要であることを表示して終了する         |
| 取得物のコミットが埋め込んだ値と不一致     | 本体を実行せず、不一致を表示して終了する                           |
| OSが Ubuntu でない                         | 何も変更せずに、対応していないことを表示して終了する               |
| Proton Pass CLIのハッシュが不一致          | 導入を中止し、不一致を表示する                                     |
| 取得先に未コミットの変更がある             | 更新を中止し、退避を促す                                           |
| 導入されていない環境で更新・状態表示を実行 | 先に導入が必要であることを表示して終了する（状態表示は「未導入」） |
| CIの検査が失敗                             | 成果物とリリースを作成せずに終了する                               |
