// サーバとの通信と型。
export type Alias = { address: string; name: string; domain: string; forwardTo: string; protonEntries: string[]; mailbox: boolean }
export type ProtonStatus = {
  state: "loading" | "ready" | "relogin" | "error" | "disabled"
  updatedAt: string | null
  reloginAt: string | null
  itemCount: number | null
  error: { kind: string; message: string } | null
}
export type Options = { domains: string[]; forwardTargets: string[] }
export type ApiErrorBody = { error: { code: string; message: string } }

export const NETWORK_ERROR = "サーバへ接続できません"

/** サーバの失敗。message はサーバが返したメッセージ（通知にそのまま表示する） */
export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiFailure"
  }
}

type FetchLike = typeof fetch
let doFetch: FetchLike = (...args) => fetch(...args)
/** テスト用に通信の実体を差し替える */
export function setFetch(f: FetchLike): void {
  doFetch = f
}

const requiredListeners = new Set<() => void>()
/** code が credentials_required の応答を受けたときに呼ばれる購読を登録する。戻り値で解除する */
export function onCredentialsRequired(fn: () => void): () => void {
  requiredListeners.add(fn)
  return () => void requiredListeners.delete(fn)
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await doFetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiFailure(0, "network", NETWORK_ERROR)
  }
  if (res.status === 204 || res.status === 202) return undefined as T
  let json: unknown
  try {
    json = await res.json()
  } catch {
    throw new ApiFailure(res.status, "invalid_response", `サーバの応答を解釈できませんでした（HTTP ${res.status}）`)
  }
  if (!res.ok) {
    const e = (json as Partial<ApiErrorBody>)?.error
    if (e?.code === "credentials_required") for (const f of requiredListeners) f()
    throw new ApiFailure(res.status, e?.code ?? "unknown", e?.message ?? `サーバでエラーが発生しました（HTTP ${res.status}）`)
  }
  return json as T
}

export const api = {
  list: () => request<{ aliases: Alias[]; proton: ProtonStatus }>("GET", "/api/aliases"),
  options: () => request<Options>("GET", "/api/options"),
  create: (b: { name?: string; domain: string; forwardTo: string }) => request<{ alias: Alias }>("POST", "/api/aliases", b),
  changeForward: (address: string, forwardTo: string) => request<{ alias: Alias }>("PATCH", `/api/aliases/${encodeURIComponent(address)}`, { forwardTo }),
  remove: (address: string) => request<void>("DELETE", `/api/aliases/${encodeURIComponent(address)}`),
  protonStatus: () => request<ProtonStatus>("GET", "/api/proton/status"),
  protonRefresh: () => request<void>("POST", "/api/proton/refresh", {}),
}
