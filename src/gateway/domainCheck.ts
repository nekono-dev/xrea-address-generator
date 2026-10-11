// 候補にないドメインの確認。XREAは未登録のドメインでもアドレスの作成を受理するため、MXがXREAのサーバを指すことをDNSで確かめる。
import { AppError } from "../shared/errors"

export type Resolver = {
  resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>
  resolve4(name: string): Promise<string[]>
  resolve6(name: string): Promise<string[]>
}
export type DomainCheck = (domain: string, serverName: string) => Promise<void>

const MAX_MX = 10
const ABSENT = ["ENOTFOUND", "ENODATA"] // 名前や該当の記録が無いことを示す

/** 記録が無いときは空、それ以外の失敗（タイムアウトなど）は例外にする */
async function lookup<T>(f: () => Promise<T[]>): Promise<T[]> {
  try {
    return await f()
  } catch (e) {
    if (ABSENT.includes((e as { code?: string }).code ?? "")) return []
    throw e
  }
}

const addresses = async (r: Resolver, host: string): Promise<string[]> =>
  (await Promise.all([lookup(() => r.resolve4(host)), lookup(() => r.resolve6(host))])).flat()

/** ドメインのMX（無ければドメイン自身）の向き先が、XREAのサーバのIPアドレスのいずれかと一致するか */
export function mxCheck(resolver: Resolver): DomainCheck {
  return async (domain, serverName) => {
    try {
      const server = new Set(await addresses(resolver, serverName))
      const mx = (await lookup(() => resolver.resolveMx(domain))).sort((a, b) => a.priority - b.priority).slice(0, MAX_MX)
      const hosts = mx.length ? mx.map(m => m.exchange) : [domain] // MXが無いときは、ドメイン自身がメールの宛先になる
      for (const host of hosts) {
        if ((await addresses(resolver, host)).some(ip => server.has(ip))) return
      }
    } catch {
      throw new AppError("upstream_error", `${domain} のMXレコードを確認できませんでした。少し待ってから再度お試しください`, "network")
    }
    throw new AppError("validation_error", `${domain} のMXレコードがXREAのサーバ（${serverName}）を指していないため、使用できません`)
  }
}
