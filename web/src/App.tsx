// 画面全体の組み立て。一覧と候補の読み込み、照合状態の確認の繰り返し。
import { useEffect, useRef } from "preact/hooks"
import { api } from "./api"
import { loadPrefs } from "./prefs"
import { OfflineBanner } from "./pwa"
import { AliasList } from "./components/AliasList"
import { Banner } from "./components/Banner"
import { IssueForm } from "./components/IssueForm"
import { Toasts } from "./components/Toast"
import { store as defaultStore, useStore, type Store } from "./store"

export const POLL_MS = 5000

export function App({ store = defaultStore, pollMs = POLL_MS }: { store?: Store; pollMs?: number }) {
  const proton = useStore(s => s.proton, store)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function reloadList() {
    try {
      const r = await api.list()
      // 保存した絞り込みのドメインが一覧に無ければ、全件の表示にする
      const { filter } = store.get()
      store.set({ aliases: r.aliases, listLoaded: true, listError: null, filter: filter && r.aliases.some(a => a.domain === filter) ? filter : null })
      return r
    } catch (e) {
      store.set({ listLoaded: true, listError: (e as Error).message })
      return null
    }
  }

  function schedule() {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void pollProton(), pollMs)
  }

  // 照合が loading・relogin の間は一定間隔で状態を確認する
  async function pollProton() {
    timer.current = null
    const prev = store.get().proton // 初回表示（prev が null）では、過去の再ログインを通知しない
    let s
    try {
      s = await api.protonStatus()
    } catch {
      schedule()
      return
    }
    store.set({ proton: s })
    if (prev && s.state === "ready" && s.reloginAt && s.reloginAt !== prev.reloginAt) store.toast("Proton Pass に再ログインしました")
    // 照合が完了したら一覧を取り直す（エントリ名は一覧の応答に含まれるため）
    if (prev && prev.state !== "ready" && s.state === "ready") await reloadList()
    if (s.state === "loading" || s.state === "relogin") schedule()
  }

  async function load() {
    const [r] = await Promise.all([
      reloadList(),
      api
        .options()
        .then(options => store.set({ options, optionsError: null }))
        .catch(e => {
          store.set({ optionsError: (e as Error).message })
          store.toast(`候補を取得できません: ${(e as Error).message}`)
        }),
    ])
    if (r) {
      store.set({ proton: r.proton })
      if (r.proton.state === "loading" || r.proton.state === "relogin") schedule()
    }
  }

  async function refresh() {
    try {
      await api.protonRefresh()
      store.set(s => ({ proton: s.proton ? { ...s.proton, state: "loading" } : s.proton }))
      schedule()
    } catch (e) {
      store.toast((e as Error).message)
    }
  }

  useEffect(() => {
    const p = loadPrefs()
    store.set({ filter: p.filter ?? null, order: p.order ?? "asc" })
    void load()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  return (
    <>
      <div class="wrap">
        <h1>ALIAS GENERATOR</h1>
      </div>
      <div class="sticky" id="sticky">
        <div class="wrap">
          <IssueForm store={store} />
          <OfflineBanner onOnline={() => void load()} />
          {proton?.state === "relogin" && <Banner kind="relogin" text="Proton Pass のセッションが失効したため、再ログインしています…" />}
          {proton?.state === "error" && <Banner kind="error" text={`Proton Passの照合に失敗しました: ${proton.error?.message ?? ""}`} />}
        </div>
      </div>
      <div class="wrap">
        <AliasList store={store} onRefresh={() => void refresh()} onReload={() => void load()} />
      </div>
      <Toasts store={store} />
    </>
  )
}
