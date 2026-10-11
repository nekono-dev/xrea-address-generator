// cookie方式の保持と、Set-Cookie の組み立て。Node.js固有のAPIは使わない。
import { open, seal } from "./seal"
import {
  COOKIE_NAME,
  LIFETIME_SEC,
  type CredentialStore,
  type Credentials,
} from "./types"

export const nowSec = () => Math.floor(Date.now() / 1000)

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const i = part.indexOf("=")
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return null
}

// Set-Cookie: xag_session=<値>; Max-Age=604800; Path=/; HttpOnly; SameSite=Strict[; Secure]
export function cookieHeader(value: string, secure: boolean): string {
  return `${COOKIE_NAME}=${value}; Max-Age=${LIFETIME_SEC}; Path=/; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`
}

export function createCookieStore(key: CryptoKey, opts: { secure: boolean }): CredentialStore {
  return {
    async save(credentials: Credentials, o) {
      const exp = (o?.now ?? nowSec()) + LIFETIME_SEC
      const value = await seal(key, { c: credentials, e: exp })
      return cookieHeader(value, opts.secure)
    },
    async load(header, now = nowSec()) {
      const raw = readCookie(header, COOKIE_NAME)
      const p = raw ? await open<{ c: Credentials; e: number }>(key, raw) : null
      return p && p.e > now ? { credentials: p.c, expiresAt: p.e } : null
    },
  }
}
