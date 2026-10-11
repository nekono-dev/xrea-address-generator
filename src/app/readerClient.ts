// Proton Pass読み取りサービスへの要求。トークンは要求ヘッダのみで渡す。
import { fetchWithTimeout } from "./gatewayClient"

export const READER_TIMEOUT_MS = 2_000
export const READER_HEALTH_TIMEOUT_MS = 1_000

export type ProtonStatus = {
  state: "loading" | "relogin" | "ready" | "error" | "disabled"
  updatedAt: string | null
  reloginAt: string | null
  itemCount: number | null
  error: { kind: string; message: string } | null
}
export type EntriesResponse = { status: ProtonStatus; entries: Record<string, string[]> }

export class ReaderClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchImpl: typeof globalThis.fetch = (...a) => globalThis.fetch(...a),
    private timeoutMs = READER_TIMEOUT_MS,
  ) {}

  private async call(method: string, path: string, protonToken: string): Promise<Response> {
    const res = await fetchWithTimeout(
      this.fetchImpl,
      `${this.baseUrl}${path}`,
      { method, headers: { authorization: `Bearer ${this.token}`, "x-proton-token": protonToken } },
      this.timeoutMs,
    )
    if (!res.ok) throw new Error(`reader ${res.status}`)
    return res
  }

  /** GET /health。共有シークレットなしで1秒で打ち切る。200 のとき true、それ以外と接続失敗は false */
  async health(): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(this.fetchImpl, `${this.baseUrl}/health`, { method: "GET" }, READER_HEALTH_TIMEOUT_MS)
      return res.status === 200
    } catch {
      return false
    }
  }

  /** GET /v1/entries。2秒で打ち切る */
  async entries(protonToken: string): Promise<EntriesResponse> {
    return (await (await this.call("GET", "/v1/entries", protonToken)).json()) as EntriesResponse
  }

  /** POST /v1/refresh。2秒で打ち切る */
  async refresh(protonToken: string): Promise<void> {
    await this.call("POST", "/v1/refresh", protonToken)
  }
}
