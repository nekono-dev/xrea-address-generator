// 一覧と行の操作（絞り込み、並び替え、コピー、転送先の変更、行内の確認つき削除）。
import { useEffect, useRef, useState } from "preact/hooks"
import { api, type Alias, type ProtonStatus } from "../api"
import { savePrefs } from "../prefs"
import { ALL_DOMAINS, store as defaultStore, useStore, view, type SortOrder, type Store } from "../store"
import { Dropdown } from "./Dropdown"
import { ForwardEdit } from "./ForwardEdit"
import { Segmented } from "./Segmented"

export function confirmText(a: Alias): string {
  return a.protonEntries.length ? `Proton Passに「${a.protonEntries.join("」「")}」があります。メールを削除しますか？` : "メールアドレスを削除しますか？"
}

const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : "--:--")

function ProtonLine({ proton, onRefresh }: { proton: ProtonStatus | null; onRefresh: () => void }) {
  if (proton?.state === "disabled") return null // 連携が無効なときは、照合の表示を出さない
  if (!proton) return <div class="pstat" />
  if (proton.state === "loading" || proton.state === "relogin")
    return (
      <div class="pstat" id="proton-status">
        <span class="sp" aria-hidden="true" />
        {proton.state === "relogin" ? "Protonへ再ログイン中…" : "Protonを照合中…"}
      </div>
    )
  return (
    <div class="pstat" id="proton-status">
      {proton.state === "ready" ? `Proton照合: ${proton.itemCount ?? 0}件を参照・${hhmm(proton.updatedAt)} 更新` : "Proton照合: 失敗"}
      <button type="button" class="link" id="proton-refresh" onClick={onRefresh}>
        更新
      </button>
    </div>
  )
}

function Row({ alias, loading, flash, store }: { alias: Alias; loading: boolean; flash: boolean; store: Store }) {
  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!flash) return
    ref.current?.scrollIntoView?.({ block: "center", behavior: "smooth" })
    const t = setTimeout(() => store.flash(null), 1500)
    return () => clearTimeout(t)
  }, [flash])
  useEffect(() => {
    if (confirming) cancelRef.current?.focus() // 誤操作を避けるため「やめる」にフォーカスする
  }, [confirming])

  async function copy() {
    try {
      await navigator.clipboard.writeText(alias.address)
      store.toast("コピーしました")
    } catch {
      store.toast("コピーできませんでした")
    }
  }
  async function remove() {
    setBusy(true)
    try {
      await api.remove(alias.address)
      store.remove(alias.address)
      store.toast("メールアドレスを削除しました")
    } catch (e) {
      store.toast((e as Error).message)
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class={`row${flash ? " flash" : ""}`} ref={ref} data-address={alias.address}>
      <div class="a">
        <div class="ad">{alias.address}</div>
        {editing ? <ForwardEdit alias={alias} store={store} onDone={() => setEditing(false)} /> : <small class="fwd">→ {alias.forwardTo}</small>}
        {loading ? (
          <div class="chips" aria-label="照合中">
            <span class="chip sk" />
          </div>
        ) : (
          alias.protonEntries.length > 0 && (
            <div class="chips">
              {alias.protonEntries.map(t => (
                <span key={t} class="chip">
                  {t}
                </span>
              ))}
            </div>
          )
        )}
      </div>
      <span class="act">
        {confirming ? (
          <span class="confirm">
            <span class="confirm-text">{confirmText(alias)}</span>
            <button type="button" class="ghost yes" data-yes disabled={busy} onClick={() => void remove()}>
              削除
            </button>
            <button type="button" class="ghost" data-no ref={cancelRef} onClick={() => setConfirming(false)}>
              やめる
            </button>
          </span>
        ) : (
          <>
            <button type="button" class="ghost" data-copy onClick={() => void copy()}>
              コピー
            </button>
            <button type="button" class="ghost" data-edit disabled={editing} onClick={() => setEditing(true)}>
              変更
            </button>
            <button type="button" class="ghost danger" data-delete onClick={() => setConfirming(true)}>
              削除
            </button>
          </>
        )}
      </span>
    </div>
  )
}

export function AliasList({ store = defaultStore, onRefresh, onReload }: { store?: Store; onRefresh: () => void; onReload: () => void }) {
  const aliases = useStore(s => s.aliases, store)
  const filter = useStore(s => s.filter, store)
  const order = useStore(s => s.order, store)
  const proton = useStore(s => s.proton, store)
  const flash = useStore(s => s.flash, store)
  const listError = useStore(s => s.listError, store)
  const listLoaded = useStore(s => s.listLoaded, store)
  const domains = [...new Set(aliases.map(a => a.domain))].sort()
  const shown = view(aliases, filter, order)
  const loading = proton?.state === "loading" || proton?.state === "relogin"

  return (
    <>
      <div class="tools">
        <h2>
          発行済み <span id="count">{shown.length}件</span>
        </h2>
        <Dropdown id="filter" label="ドメインで絞り込み" items={[ALL_DOMAINS, ...domains]} value={filter ?? ALL_DOMAINS} onChange={v => {
            const filter = v === ALL_DOMAINS ? null : v
            store.set({ filter })
            savePrefs({ filter })
          }}
        />
        <Segmented<SortOrder>
          label="並び順"
          items={[
            { value: "asc", label: "A→Z" },
            { value: "desc", label: "Z→A" },
          ]}
          value={order}
          onChange={v => {
            store.set({ order: v })
            savePrefs({ order: v })
          }}
        />
      </div>
      <ProtonLine proton={proton} onRefresh={onRefresh} />
      <div id="list">
        {listError ? (
          <div class="empty">
            一覧を取得できませんでした（{listError}）
            <div>
              <button type="button" class="link" id="reload" onClick={onReload}>
                再読み込み
              </button>
            </div>
          </div>
        ) : !listLoaded ? (
          <div class="empty">読み込み中…</div>
        ) : shown.length === 0 ? (
          <div class="empty">該当するエイリアスがありません</div>
        ) : (
          shown.map(a => <Row key={a.address} alias={a} loading={loading} flash={flash === a.address} store={store} />)
        )}
      </div>
    </>
  )
}
