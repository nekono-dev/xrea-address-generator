// DNS over HTTPS による名前解決。Workers では node:dns が使えないため、MXの確認はこれで行う。
import type { Resolver } from "./domainCheck"

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query"
export const DOH_TIMEOUT_MS = 3000
const TYPE = { A: 1, MX: 15, AAAA: 28 } as const

type Answer = { type: number; data: string }
type DohResponse = { Status: number; Answer?: Answer[] }

/** domainCheck が「記録が無い」と読む code を付けた例外 */
const absent = (code: "ENODATA" | "ENOTFOUND", name: string) => Object.assign(new Error(`${name}: ${code}`), { code })

export function dohResolver(f: typeof fetch = (...a) => fetch(...a), endpoint = DOH_ENDPOINT, timeoutMs = DOH_TIMEOUT_MS): Resolver {
  async function query(name: string, type: keyof typeof TYPE): Promise<string[]> {
    const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`
    // 打ち切りは fetch の中断と、時計との競争の両方で行う（fetch が信号を無視しても待たない）
    const ctl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctl.abort()
        reject(new Error("DNS over HTTPS の照会が時間内に終わりませんでした"))
      }, timeoutMs)
    })
    try {
      const res = await Promise.race([f(url, { headers: { accept: "application/dns-json" }, signal: ctl.signal }), timeout])
      if (!res.ok) throw new Error(`DNS over HTTPS が ${res.status} を返しました`)
      const body = (await Promise.race([res.json(), timeout])) as DohResponse
      if (body.Status === 3) throw absent("ENOTFOUND", name)
      if (body.Status !== 0) throw new Error(`DNS の応答コードが ${body.Status} です`)
      const data = (body.Answer ?? []).filter(a => a.type === TYPE[type]).map(a => a.data)
      if (data.length === 0) throw absent("ENODATA", name)
      return data
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    resolve4: name => query(name, "A"),
    resolve6: name => query(name, "AAAA"),
    async resolveMx(name) {
      return (await query(name, "MX")).map(d => {
        const [priority, host = ""] = d.trim().split(/\s+/)
        return { priority: Number(priority), exchange: host.replace(/\.$/, "") }
      })
    },
  }
}
