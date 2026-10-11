# ゲートウェイのDurable Object 設計書

## 1. 構成

| パス                                 | 責務                                                         |
| ------------------------------------ | ------------------------------------------------------------ |
| `src/gateway/tenantKey.ts`           | 認証情報から鍵（SHA-256の16進）を導く                        |
| `src/gateway/durableRouter.ts`       | 鍵ごとのDurable Objectへ要求を振り分ける                     |
| `src/gateway/durableObject.ts`       | アカウントごとのDurable Object本体                           |
| `src/gateway/dohResolver.ts`         | DNS over HTTPSによる名前解決                                 |
| `src/app/worker.ts`                  | Durable Objectのクラスの公開と、振り分けの組み込み           |
| `wrangler.jsonc`                     | Durable Objectの束縛と移行の定義                             |
| `wrangler.template.jsonc`            | 個人用の定義の雛形                                           |
| `tests/gateway/durable.test.ts`      | 振り分け・直列化・間隔・キャッシュ・ストレージ非使用のテスト |
| `tests/gateway/dohResolver.test.ts`  | DNS over HTTPSの応答の変換と打ち切りのテスト                 |
| `tests/gateway/durable.live.test.ts` | 実際のXREAに対する同時要求のテスト                           |
| `tests/cloud/durableConfig.test.ts`  | 配備の定義の束縛と移行のテスト                               |

## 2. 設計項目

### D-1: 鍵と振り分け (FR-1, FR-4)

```ts
// src/gateway/tenantKey.ts: WebCrypto だけを使い、node: に依存しない
export async function tenantKey(c: XreaConfig): Promise<string> {
  const data = new TextEncoder().encode(
    `${c.account}\0${c.serverName}\0${c.apiSecretKey}`,
  )
  const hash = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

// src/gateway/durableRouter.ts
import type { GatewayFetcher } from "./app"
export function durableFetcher(ns: DurableObjectNamespace): GatewayFetcher {
  return async (x, req) => ns.get(ns.idFromName(await tenantKey(x))).fetch(req)
}
```

| 項目     | 内容                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 鍵の素材 | アカウント名、サーバ名、シークレットキーの3つ。同じ組が常に同じ鍵になる    |
| 名前     | 鍵のハッシュ値のみ。平文を名前に含めず、ログにも出さない                   |
| 要求     | 認証情報のヘッダを含む要求をそのまま渡す。Durable Objectは同じヘッダを読む |

### D-2: Durable Object本体 (FR-2, FR-3, FR-4, NFR-1)

```ts
// src/gateway/durableObject.ts: 基底クラスを継承せず、cloudflare:workers に依存しない
export type TenantDeps = {
  xrea?: (c: XreaConfig) => XreaPort // テストでXREAを差し替える
  now?: () => number
  domainCheck?: DomainCheck
}
export class GatewayTenant {
  private readonly app: Hono
  // 第3引数はテスト専用。Workers の実行環境は state と env だけを渡す。永続ストレージを使わない
  constructor(_state?: unknown, _env?: unknown, deps: TenantDeps = {}) {
    this.app = createGatewayApp({
      registry: new Registry(100, 600_000, deps.now, deps.xrea),
      domainCheck: deps.domainCheck ?? mxCheck(dohResolver()),
    })
  }
  fetch(req: Request): Promise<Response> {
    return Promise.resolve(this.app.fetch(req))
  }
}
```

| 項目               | 内容                                                                                       |
| ------------------ | ------------------------------------------------------------------------------------------ |
| 直列化             | 排他と間隔の待ち行列を、Durable Objectのメモリに置く。1つの鍵に対して実体は1つだけ存在する |
| 一覧のキャッシュ   | 30秒。変更の成功時に破棄する。Durable Objectが破棄されたときは失われる                     |
| 破棄後の最初の要求 | 待ち行列の履歴が無いが、破棄までに1.1秒を超える間があるため、間隔の規則に反しない          |
| 認証情報           | メモリ上のクライアントにだけ保持し、永続ストレージ・ログに書かない                         |
| 応答時間           | 稼働中でキャッシュが有効な一覧は、メモリからの応答だけで返す                               |

### D-3: DNS over HTTPS (FR-5, NFR-2)

```ts
// src/gateway/dohResolver.ts: 既存の Resolver の型を満たす
export function dohResolver(
  f: typeof fetch = fetch,
  endpoint = "https://cloudflare-dns.com/dns-query",
  timeoutMs = 3000,
): Resolver

// 照会: GET ${endpoint}?name=<名前>&type=<MX|A|AAAA>  ヘッダ accept: application/dns-json
// 応答: { Status: number; Answer?: { type: number; data: string }[] }
const TYPE = { A: 1, MX: 15, AAAA: 28 }
```

| 応答                                    | 結果                                                             |
| --------------------------------------- | ---------------------------------------------------------------- |
| Status 0 で、要求した型の Answer がある | 値の配列を返す。MX は「優先度 ホスト名.」を分解し末尾の . を除く |
| Status 0 で、要求した型の Answer が無い | code が ENODATA の例外（記録が無いこと）                         |
| Status 3（NXDOMAIN）                    | code が ENOTFOUND の例外（記録が無いこと）                       |
| Status 0 と 3 以外の値                  | code の無い例外（照会の失敗）                                    |
| HTTPが200以外、接続の失敗、3秒の超過    | code の無い例外（照会の失敗）                                    |

CNAME の Answer は読み飛ばし、要求した型だけを数える。MXの確認は、サーバ名のA・AAAA、ドメインのMX、各MXホストのA・AAAAを並列に照会する。

### D-4: 配備の定義とWorkerの入口 (FR-6)

```jsonc
// wrangler.jsonc に加える
"durable_objects": {
  "bindings": [{ "name": "GATEWAY", "class_name": "GatewayTenant" }]
},
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["GatewayTenant"] }]
```

```ts
// src/app/worker.ts
export { GatewayTenant } from "../gateway/durableObject"
// Env に GATEWAY: DurableObjectNamespace を加え、GatewayClient の送信先を durableFetcher(env.GATEWAY) にする
```

| 項目       | 内容                                                                |
| ---------- | ------------------------------------------------------------------- |
| クラス方式 | SQLite方式。Workersの無料枠で使える方式であり、ストレージは使わない |
| ビルド     | 既存の worker 用のビルドが、クラスを含む単一ファイルを出力する      |
| 雛形       | wrangler.template.jsonc にも同じ束縛と移行を加える                  |

## 3. エラー処理

| 事象                                       | 処理                                                 |
| ------------------------------------------ | ---------------------------------------------------- |
| Durable Objectへの呼び出しが失敗           | アプリが 502 upstream_error（kind は network）を返す |
| MXの照会が失敗                             | 502 upstream_error（kind は network）を返す          |
| MXの記録が無い、または向き先がXREAと異なる | 400 validation_error を返す                          |
| 認証情報のヘッダが欠けた要求               | Durable Objectの中で 401 を返し、XREAを呼び出さない  |
