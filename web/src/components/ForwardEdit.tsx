// 行内の転送先の変更。転送先の入力部品と「保存」「やめる」で構成する。
import { useEffect, useRef, useState } from "preact/hooks"
import { api, type Alias } from "../api"
import { useStore, type Store } from "../store"
import { Combobox, MAIL_RE } from "./Combobox"

export function ForwardEdit({ alias, store, onDone }: { alias: Alias; store: Store; onDone: () => void }) {
  const candidates = useStore(s => s.options.forwardTargets, store)
  const [value, setValue] = useState(alias.forwardTo)
  const [busy, setBusy] = useState(false)
  const ok = MAIL_RE.test(value.trim()) && !busy
  const root = useRef<HTMLDivElement>(null)

  // 開いた入力部品と候補が固定の帯に隠れないよう、行を見える位置へ寄せる
  useEffect(() => {
    root.current?.closest(".row")?.scrollIntoView?.({ block: "nearest" })
  }, [])

  async function save() {
    if (!ok) return
    setBusy(true)
    try {
      const { alias: next } = await api.changeForward(alias.address, value.trim())
      store.add(next) // 同じアドレスの行を置き換える
      // 新しい転送先を候補にも加える
      store.set(s => ({ options: { ...s.options, forwardTargets: [...new Set([...s.options.forwardTargets, next.forwardTo])].sort() } }))
      store.toast("転送先を変更しました")
      onDone()
    } catch (e) {
      store.toast((e as Error).message) // 入力は保持する
      setBusy(false)
    }
  }

  return (
    <div class="fedit" ref={root}>
      <div class="line">
        <Combobox id={`fwd-${alias.address}`} label={`${alias.address} の転送先`} value={value} candidates={candidates} onInput={setValue} onEnter={() => void save()} onEscape={onDone} autoFocus />
      </div>
      <div class="fedit-act">
        <button type="button" class="ghost yes-acc" data-save disabled={!ok} onClick={() => void save()}>
          保存
        </button>
        <button type="button" class="ghost" data-cancel onClick={onDone}>
          やめる
        </button>
      </div>
    </div>
  )
}
