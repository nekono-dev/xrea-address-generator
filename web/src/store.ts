// 状態の保持（一覧、候補、絞り込み、並び順、通知）。
import { useEffect, useState } from "preact/hooks"
import type { Alias, Options, ProtonStatus } from "./api"

export type SortOrder = "asc" | "desc"
export type ToastItem = { id: number; text: string }
export type State = {
  aliases: Alias[]
  listLoaded: boolean
  listError: string | null
  options: Options
  optionsError: string | null
  filter: string | null // null は「すべてのドメイン」
  order: SortOrder
  proton: ProtonStatus | null
  flash: string | null // 強調表示する行のアドレス
  toasts: ToastItem[]
}

export const ALL_DOMAINS = "すべてのドメイン"
export const TOAST_MS = 2600

const initial = (): State => ({
  aliases: [],
  listLoaded: false,
  listError: null,
  options: { domains: [], forwardTargets: [] },
  optionsError: null,
  filter: null,
  order: "asc",
  proton: null,
  flash: null,
  toasts: [],
})

export function createStore(start: State = initial()) {
  let state = start
  const subs = new Set<() => void>()
  let toastId = 0
  const store = {
    get: () => state,
    set(patch: Partial<State> | ((s: State) => Partial<State>)) {
      state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }
      for (const f of subs) f()
    },
    subscribe(f: () => void) {
      subs.add(f)
      return () => void subs.delete(f)
    },
    reset() {
      state = initial()
      for (const f of subs) f()
    },
    toast(text: string) {
      const id = ++toastId
      store.set(s => ({ toasts: [...s.toasts, { id, text }] }))
      setTimeout(() => store.set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), TOAST_MS)
    },
    add(alias: Alias) {
      store.set(s => ({ aliases: [...s.aliases.filter(a => a.address !== alias.address), alias] }))
    },
    remove(address: string) {
      store.set(s => ({ aliases: s.aliases.filter(a => a.address !== address) }))
    },
    flash(address: string | null) {
      store.set({ flash: address })
    },
  }
  return store
}

export type Store = ReturnType<typeof createStore>
export const store = createStore()

export function useStore<T>(select: (s: State) => T, s: Store = store): T {
  const [value, setValue] = useState(() => select(s.get()))
  useEffect(() => {
    setValue(() => select(s.get()))
    return s.subscribe(() => setValue(() => select(s.get())))
  }, [s])
  return value
}

/** 絞り込みと並び替えを適用した一覧 */
export function view(aliases: readonly Alias[], domain: string | null, order: SortOrder): Alias[] {
  return aliases
    .filter(a => domain === null || a.domain === domain)
    .sort((x, y) => x.address.localeCompare(y.address) * (order === "asc" ? 1 : -1))
}
