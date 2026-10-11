// 鍵の導出と、暗号化・復号（WebCrypto のみ。Node.js と Workers の両方で動く）。
const enc = new TextEncoder()
const dec = new TextDecoder()
const AAD = "xag-credentials-v1"
const PREFIX = "v1."

export type Keyring = {
  /** 暗号化に使う鍵 */
  current: { kid: string; key: CryptoKey }
  /** 復号に使える鍵（現行と直前） */
  byKid: Map<string, CryptoKey>
}

async function deriveOne(secret: string): Promise<{ kid: string; key: CryptoKey }> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, ["deriveKey", "deriveBits"])
  const salt = enc.encode("xag-v1")
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("credentials") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  )
  const kidBits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: enc.encode("kid") }, base, 48)
  return { kid: toBase64Url(new Uint8Array(kidBits)), key }
}

/** HKDF-SHA256 で秘密値ごとに鍵と鍵の識別子を導出する。1つ目が現行、2つ目が直前。識別子が同じ鍵は1つにまとめる */
export async function deriveKey(...secrets: [current: string, previous?: string]): Promise<Keyring> {
  const [current, previous] = await Promise.all(secrets.map(s => (s === undefined ? undefined : deriveOne(s))))
  const byKid = new Map<string, CryptoKey>()
  if (previous) byKid.set(previous.kid, previous.key)
  byKid.set(current!.kid, current!.key)
  return { current: current!, byKid }
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

const aad = (context?: string) => enc.encode(context ? `${AAD}:${context}` : AAD)

/** "v1." + kid + "." + base64url(iv 12バイト + 暗号文 + 認証タグ)。context（SQLite方式ではセッションID）は追加認証データに含める */
export async function seal(ring: Keyring, payload: unknown, context?: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const body = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(context) }, ring.current.key, enc.encode(JSON.stringify(payload))),
  )
  const out = new Uint8Array(iv.length + body.length)
  out.set(iv)
  out.set(body, iv.length)
  return `${PREFIX}${ring.current.kid}.${toBase64Url(out)}`
}

/** 形式の不一致・未知のkid・認証タグの不一致（改ざん・鍵違い・contextの違い）は例外を出さず null を返す */
export async function open<T>(ring: Keyring, sealed: string, context?: string): Promise<T | null> {
  if (!sealed.startsWith(PREFIX)) return null
  const [kid, data, ...rest] = sealed.slice(PREFIX.length).split(".")
  const key = kid === undefined ? undefined : ring.byKid.get(kid)
  if (!key || data === undefined || rest.length) return null
  const bytes = fromBase64Url(data)
  if (!bytes || bytes.length < 12 + 16) return null
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: aad(context) },
      key,
      bytes.slice(12),
    )
    return JSON.parse(dec.decode(plain)) as T
  } catch {
    return null
  }
}
