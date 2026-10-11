// 登録状態の保持と、問い合わせ・登録の呼び出し。入力値は保存領域に書き込まない。
import { request } from "./api"

export type CredentialState = "unknown" | "missing" | "expired" | "registered"
export type RegisterBody = {
  xrea: { account: string; serverName: string; apiSecretKey: string }
  protonToken?: string
}

export const credentialsApi = {
  status: () => request<{ registered: boolean; proton?: boolean; expiresAt?: string }>("GET", "/api/credentials"),
  register: (b: RegisterBody) => request<void>("PUT", "/api/credentials", b),
}

/** 登録できる入力か。3項目がすべて空白以外を含む */
export function canRegister(account: string, serverName: string, key: string): boolean {
  return [account, serverName, key].every(v => v.trim() !== "")
}
