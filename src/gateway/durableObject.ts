// アカウントごとの Durable Object。直列化・間隔の確保・一覧のキャッシュを、このオブジェクトのメモリで行う。
// 認証情報はメモリ上のクライアントにだけ置き、永続ストレージには何も書かない。
import type { XreaConfig } from "../xrea/client"
import { consoleLogger } from "../shared/logger"
import { createGatewayApp } from "./app"
import { dohResolver } from "./dohResolver"
import { mxCheck, type DomainCheck } from "./domainCheck"
import { Registry } from "./registry"
import type { XreaPort } from "./service"

/** テストで XREA・時計・MX の確認を差し替えるための引数。Workers の実行環境は渡さない */
export type TenantDeps = { xrea?: (c: XreaConfig) => XreaPort; now?: () => number; domainCheck?: DomainCheck }

export class GatewayTenant {
  private readonly app

  // 基底クラスを継承せず、永続ストレージ（state.storage）にも触れない
  constructor(_state?: unknown, _env?: unknown, deps: TenantDeps = {}) {
    this.app = createGatewayApp({
      registry: new Registry(100, 600_000, deps.now, deps.xrea),
      domainCheck: deps.domainCheck ?? mxCheck(dohResolver()),
      logger: consoleLogger,
    })
  }

  fetch(req: Request): Promise<Response> {
    return Promise.resolve(this.app.fetch(req))
  }
}
