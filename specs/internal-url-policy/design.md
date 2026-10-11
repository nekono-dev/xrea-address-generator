# 内部URLの通信方式の検査 設計書

## 1. 構成

| パス                            | 責務                                     |
| ------------------------------- | ---------------------------------------- |
| `src/app/internalUrl.ts`        | URLの通信方式とホストの検査              |
| `src/app/config.ts`             | 設定の読み込み時に検査を呼び出す         |
| `src/app/worker.ts`             | Workersの入口から https のみの基準を渡す |
| `tests/app/internalUrl.test.ts` | 検査の単体テスト                         |

## 2. 設計項目

### D-1: 通信方式とホストの判定 (FR-1, FR-2, FR-3, FR-4, NFR-1)

```ts
// src/app/internalUrl.ts
export type HttpPolicy = "all" | "external" // all: https のみ。external: 下表のホストに限り http も許す
export function isInternalHost(hostname: string): boolean // URL.hostname を小文字化して判定する。IPv6は角括弧付き
export function allowsHttp(u: URL, policy: HttpPolicy): boolean {
  if (u.protocol === "https:") return true
  return (
    policy === "external" &&
    u.protocol === "http:" &&
    isInternalHost(u.hostname)
  )
}
```

| 種別           | 許すホスト                                |
| -------------- | ----------------------------------------- |
| 同梱サービス名 | proton-reader                             |
| ループバック   | localhost、127.0.0.0/8、[::1]             |
| プライベート   | 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16 |

IPv4は、ドット区切りの4つの0〜255の数字のときだけアドレスとして扱う。それ以外の形のホスト名は、名前の一致だけで判定する。

### D-2: 設定への組み込み (FR-1, FR-2, FR-5)

```ts
// src/app/config.ts の loadAppConfig の opts に httpPolicy を加える（既定は "external"）
loadAppConfig(env, { allowSqlite: false, httpPolicy: "all" }) // Workersの入口が渡す
// PROTON_READER_URL を検査し、違反なら
// throw new ConfigError(`${name} は${policy === "all" ? "https" : "https、または内部ネットワークのホストの http"} のURLにしてください`)
```

## 3. エラー処理

| 事象                            | 処理                                                             |
| ------------------------------- | ---------------------------------------------------------------- |
| 許されない通信方式・ホストのURL | 変数名を示して設定の読み込みを失敗させる（Workersでは500で応答） |
| URLの形式が不正                 | 変数名を示して設定の読み込みを失敗させる                         |
