// XREAゲートウェイへの要求。認証情報はヘッダのみで渡し、URLと本文には載せない。
import { AppError, STATUS, type ErrorCode, type ErrorKind } from "../shared/errors"
import type { XreaCredentials } from "../credentials/types"
import type { GatewayFetcher } from "../gateway/app"

export const GATEWAY_TIMEOUT_MS = 10_000

export type GatewayAlias = { address: string; name: string; domain: string; forwardTo: string; mailbox: boolean }
export type CreateBody = { name?: string; domain: string; forwardTo: string }
export type Options = { domains: string[]; forwardTargets: string[] }

/** fetch に打ち切り時間を設ける。失敗・打ち切りは null の代わりに例外で返す */
export async function fetchWithTimeout(f: typeof fetch, url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), ms)
  try {
    return await f(url, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(timer)
  }
}

// 呼び出し先は URL ではなく関数で受け取る。要求のURLは内部の固定のホスト名で、ネットワークには出ない
const BASE = "http://gateway.internal"

export class GatewayClient {
  constructor(
    private fetcher: GatewayFetcher,
    private timeoutMs = GATEWAY_TIMEOUT_MS,
  ) {}

  private headers(x: XreaCredentials, json = false): Record<string, string> {
    return {
      "x-xrea-account": x.account,
      "x-xrea-server": x.serverName,
      "x-xrea-secret": x.apiSecretKey,
      ...(json ? { "content-type": "application/json" } : {}),
    }
  }

  private async call(x: XreaCredentials, method: string, path: string, body?: object): Promise<Response> {
    let res: Response
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const req = new Request(`${BASE}${path}`, { method, headers: this.headers(x, !!body), body: body ? JSON.stringify(body) : undefined })
      // 呼び出しと時計を競わせる。先に終わった方を採る
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), this.timeoutMs)
      })
      res = await Promise.race([this.fetcher(x, req), timeout])
    } catch {
      throw new AppError("upstream_error", "XREAゲートウェイへ接続できません", "network")
    } finally {
      clearTimeout(timer)
    }
    if (res.ok) return res
    let code: string | undefined
    let message = ""
    let kind: ErrorKind | undefined
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string; kind?: ErrorKind } }
      code = j.error?.code
      message = j.error?.message ?? ""
      kind = j.error?.kind
    } catch {
      // 本文を解釈できない応答は、下で upstream_error にする
    }
    // 認証情報の欠落は、アプリが3項目を必ず付けるため通常は起きない。利用者の認証情報の期限切れと区別する
    if (code === "unauthorized") throw new AppError("upstream_error", "内部サービスの認証に失敗しました", "network")
    if (code && code in STATUS) throw new AppError(code as ErrorCode, message, kind)
    throw new AppError("upstream_error", "XREAゲートウェイが不正な応答を返しました", "network")
  }

  async list(x: XreaCredentials): Promise<GatewayAlias[]> {
    return ((await (await this.call(x, "GET", "/v1/aliases")).json()) as { aliases: GatewayAlias[] }).aliases
  }

  async options(x: XreaCredentials): Promise<Options> {
    return (await (await this.call(x, "GET", "/v1/options")).json()) as Options
  }

  async create(x: XreaCredentials, b: CreateBody): Promise<GatewayAlias> {
    return ((await (await this.call(x, "POST", "/v1/aliases", b)).json()) as { alias: GatewayAlias }).alias
  }

  async changeForward(x: XreaCredentials, address: string, forwardTo: string): Promise<GatewayAlias> {
    const res = await this.call(x, "PATCH", `/v1/aliases/${encodeURIComponent(address)}`, { forwardTo })
    return ((await res.json()) as { alias: GatewayAlias }).alias
  }

  async removeForward(x: XreaCredentials, address: string): Promise<GatewayAlias> {
    const res = await this.call(x, "DELETE", `/v1/aliases/${encodeURIComponent(address)}/forward`)
    return ((await res.json()) as { alias: GatewayAlias }).alias
  }

  async remove(x: XreaCredentials, address: string): Promise<void> {
    await this.call(x, "DELETE", `/v1/aliases/${encodeURIComponent(address)}`)
  }
}
