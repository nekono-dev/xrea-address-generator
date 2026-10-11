// 認証情報からアカウントの鍵を導く。WebCrypto だけを使い、node: の組み込みモジュールに依存しない。
import type { XreaConfig } from "../xrea/client"

/** key = sha256(account + "\0" + serverName + "\0" + apiSecretKey) の16進。平文は含まない */
export async function tenantKey(c: XreaConfig): Promise<string> {
  const data = new TextEncoder().encode(`${c.account}\0${c.serverName}\0${c.apiSecretKey}`)
  const hash = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("")
}
