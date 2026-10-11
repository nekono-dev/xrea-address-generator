// 選択した値のブラウザへの保存と復元（発行ドメイン・転送先・絞り込み・並び順）。
import type { SortOrder } from "./store"

export const PREFS_KEY = "xrea-address-generator:prefs"
export type Prefs = { domain?: string; forwardTo?: string; serverName?: string; filter?: string | null; order?: SortOrder }

const storageOf = (s?: Storage): Storage | undefined => {
  try {
    return s ?? globalThis.localStorage
  } catch {
    return undefined // 保存先へのアクセス自体が禁止されている
  }
}

/** 保存した値を読む。読めないとき・形式が不正なときは {} を返す */
export function loadPrefs(storage?: Storage): Prefs {
  try {
    const raw = storageOf(storage)?.getItem(PREFS_KEY)
    const v: unknown = raw ? JSON.parse(raw) : {}
    if (!v || typeof v !== "object" || Array.isArray(v)) return {}
    const o = v as Record<string, unknown>
    const p: Prefs = {}
    if (typeof o.domain === "string") p.domain = o.domain
    if (typeof o.serverName === "string") p.serverName = o.serverName
    if (typeof o.forwardTo === "string") p.forwardTo = o.forwardTo
    if (typeof o.filter === "string" || o.filter === null) p.filter = o.filter
    if (o.order === "asc" || o.order === "desc") p.order = o.order
    return p
  } catch {
    return {}
  }
}

/** 保存した値へ併合して書く。書けないときは何もしない */
export function savePrefs(patch: Prefs, storage?: Storage): void {
  try {
    storageOf(storage)?.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(storage), ...patch }))
  } catch {
    // 容量超過・プライベートブラウズでの書き込み禁止
  }
}

/** ログイン画面のサーバ名を読む。未保存のときは空文字 */
export const loadServerName = (storage?: Storage): string => loadPrefs(storage).serverName ?? ""

/** ログイン画面のサーバ名を保存する */
export const saveServerName = (serverName: string, storage?: Storage): void => savePrefs({ serverName }, storage)
