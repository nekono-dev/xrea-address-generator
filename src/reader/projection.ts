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

/** Vault一覧の出力から、各Vaultの共有IDを取り出す */
export function vaultShareIds(rawJson: string): string[] {
  const parsed = JSON.parse(rawJson) as { vaults?: { share_id?: string }[] }
  return (parsed.vaults ?? []).map(v => v.share_id).filter((id): id is string => !!id)
}

/** 複数のVaultの変換結果を1つの対応表にまとめる（エントリ名は昇順） */
export function mergeProjections(list: readonly Projection[]): Projection {
  const map = new Map<string, string[]>()
  for (const p of list) for (const [addr, titles] of p.map) map.set(addr, [...(map.get(addr) ?? []), ...titles])
  for (const [k, v] of map) map.set(k, v.sort((a, b) => a.localeCompare(b)))
  return { map, itemCount: list.reduce((n, p) => n + p.itemCount, 0) }
}
