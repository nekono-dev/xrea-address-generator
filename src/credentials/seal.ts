// 鍵の導出と、暗号化・復号（WebCrypto のみ。Node.js と Workers の両方で動く）。
const enc = new TextEncoder()
const dec = new TextDecoder()
const AAD = enc.encode("xag-credentials-v1")
const PREFIX = "v1."

/** HKDF-SHA256（salt: "xag-v1"、info: "credentials"）で AES-GCM 256 ビットの鍵を導出する */
export async function deriveKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode("xag-v1"), info: enc.encode("credentials") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
}

export function toBase64Url(bytes: Uint8Array): string {
  let s = ""
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function fromBase64Url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"))
    return Uint8Array.from(bin, ch => ch.charCodeAt(0))
  } catch {
    return null
  }
}

/** "v1." + base64url(iv 12バイト + 暗号文 + 認証タグ)。追加認証データは "xag-credentials-v1" */
export async function seal(key: CryptoKey, payload: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, key, enc.encode(JSON.stringify(payload))),
  )
  const out = new Uint8Array(iv.length + body.length)
  out.set(iv)
  out.set(body, iv.length)
  return PREFIX + toBase64Url(out)
}

/** 形式の不一致・認証タグの不一致（改ざん・鍵違い）は例外を出さず null を返す */
export async function open<T>(key: CryptoKey, sealed: string): Promise<T | null> {
  if (!sealed.startsWith(PREFIX)) return null
  const bytes = fromBase64Url(sealed.slice(PREFIX.length))
  if (!bytes || bytes.length < 12 + 16) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: AAD },
      key,
      bytes.slice(12),
    )
    return JSON.parse(dec.decode(plain)) as T
  } catch {
    return null
  }
}
