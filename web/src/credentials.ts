// 登録状態の保持と、問い合わせ・登録・ログアウトの呼び出し。入力値は保存領域に書き込まない。
import { request } from "./api"

export type CredentialState = "unknown" | "missing" | "expired" | "registered"
export type ProtonCapability = "disabled" | "available" | "unavailable"
export type RegisterBody = {
  xrea: { account: string; serverName: string; apiSecretKey: string }
  protonToken?: string
}

export const credentialsApi = {
  status: () => request<{ registered: boolean; proton?: boolean; expiresAt?: string }>("GET", "/api/credentials"),
  servers: () => request<{ servers: string[] }>("GET", "/api/servers"),
  capabilities: () => request<{ proton: ProtonCapability }>("GET", "/api/capabilities"),
  // 204 は undefined。200 { proton } はトークンを保持しなかったことを示す
  register: (b: RegisterBody) => request<{ proton?: ProtonCapability } | undefined>("PUT", "/api/credentials", b),
  logout: () => request<void>("DELETE", "/api/credentials"),
}

/** 登録できる入力か。3項目がすべて空白以外を含む */
export function canRegister(account: string, serverName: string, key: string, servers: readonly string[] = []): boolean {
  if (![account, serverName, key].every(v => v.trim() !== "")) return false
  // 一覧を取得できなかったとき（空）は、自由入力で登録できる
  return servers.length === 0 || servers.includes(serverName.trim())
}
