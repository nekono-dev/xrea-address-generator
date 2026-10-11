// 内部サービスのURLの通信方式とホストの検査。文字列だけで判定し、名前解決は行わない。
export type HttpPolicy = "all" | "external"

const INTERNAL_NAMES = new Set(["proton-reader", "localhost", "[::1]"])

function ipv4(hostname: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)
  if (!m) return null
  const o = m.slice(1).map(Number)
  return o.every(n => n <= 255) ? o : null
}

/** 同梱サービス名・ループバック・プライベートIPアドレス（クラスA〜C）なら true */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  if (INTERNAL_NAMES.has(h)) return true
  const o = ipv4(h)
  if (!o) return false
  const [a, b] = o as [number, number]
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

export function allowsHttp(u: URL, policy: HttpPolicy): boolean {
  if (u.protocol === "https:") return true
  return policy === "external" && u.protocol === "http:" && isInternalHost(u.hostname)
}
