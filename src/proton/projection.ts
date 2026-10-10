// アイテム一覧から、アドレス -> エントリ名 の対応表を作る。秘匿情報はこの関数のスコープの外へ出さない。

/** 小文字のアドレス -> 昇順のエントリ名 */
export type AddressMap = ReadonlyMap<string, readonly string[]>

type RawItem = {
  state?: string
  content?: { title?: string; content?: { Login?: { username?: string; email?: string } } }
}

export type Projection = { map: AddressMap; itemCount: number }

export function project(rawJson: string): Projection {
  const parsed = JSON.parse(rawJson) as { items?: RawItem[] }
  const items = parsed.items ?? []
  const map = new Map<string, string[]>()
  for (const it of items) {
    const login = it.content?.content?.Login
    if (it.state !== "Active" || !login) continue
    const title = it.content?.title ?? ""
    const addrs = new Set([login.username, login.email].filter((s): s is string => !!s).map(s => s.trim().toLowerCase()))
    for (const addr of addrs) map.set(addr, [...(map.get(addr) ?? []), title])
  }
  for (const [k, v] of map) map.set(k, v.sort((a, b) => a.localeCompare(b)))
  return { map, itemCount: items.length }
}
