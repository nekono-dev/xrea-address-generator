// アカウントの鍵ごとの Durable Object へ要求を振り分ける（Workers 用）。
import type { GatewayFetcher } from "./app"
import { tenantKey } from "./tenantKey"

/** 呼び出しに使う Durable Object の名前空間の最小の型 */
export type GatewayNamespace = {
  idFromName(name: string): unknown
  get(id: any): { fetch(req: Request): Promise<Response> }
}

export function durableFetcher(ns: GatewayNamespace): GatewayFetcher {
  return async (x, req) => ns.get(ns.idFromName(await tenantKey(x))).fetch(req)
}
