// 発行フォーム。名前・ドメイン・発行ボタン・転送先から成る。
import { useEffect, useState } from "preact/hooks"
import { api } from "../api"
import { loadPrefs, savePrefs } from "../prefs"
import { store as defaultStore, useStore, type Store } from "../store"
import { Combobox, isInvalidMail, MAIL_RE } from "./Combobox"
import { Dropdown } from "./Dropdown"

const isImeEnter = (e: KeyboardEvent) => e.isComposing || e.keyCode === 229

export function IssueForm({ store = defaultStore }: { store?: Store }) {
  const options = useStore(s => s.options, store)
  const optionsError = useStore(s => s.optionsError, store)
  const [name, setName] = useState("")
  // 最後に選んだドメインと、最後に指定した有効な転送先を初期値にする
  const [domain, setDomain] = useState(() => loadPrefs().domain ?? "")
  const [target, setTarget] = useState(() => loadPrefs().forwardTo ?? "")
  const [targetTouched, setTargetTouched] = useState(false)
  const [busy, setBusy] = useState(false)

  // 候補の取得後に、既定のドメインと転送先を入れる（保存したドメインが候補に無ければ先頭の候補にする）
  useEffect(() => {
    if (options.domains.length && !options.domains.includes(domain)) setDomain(options.domains[0]!)
    if (!targetTouched && !target && options.forwardTargets[0]) setTarget(options.forwardTargets[0])
  }, [options])

  const invalid = isInvalidMail(target)
  const canIssue = !busy && !optionsError && domain !== "" && target.trim() !== "" && !invalid

  async function issue() {
    if (!canIssue) return
    setBusy(true)
    try {
      const { alias } = await api.create({ name: name.trim() || undefined, domain, forwardTo: target.trim() })
      store.add(alias) // 応答の受信後すぐに一覧へ反映する
      store.flash(alias.address)
      setName("")
      store.toast(`${alias.address} を発行しました`)
    } catch (e) {
      store.toast((e as Error).message) // 入力は保持する
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="form">
      <div class="line">
        <input
          class="fld al"
          id="name"
          aria-label="エイリアス名"
          placeholder="空なら ランダム (例: quiet.river42)"
          autocomplete="off"
          value={name}
          onInput={e => setName((e.target as HTMLInputElement).value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !isImeEnter(e)) {
              e.preventDefault()
              void issue()
            }
          }}
        />
        <span class="at">@</span>
        <Dropdown id="domain" label="ドメイン" items={options.domains} value={domain || "ドメインなし"} onChange={v => {
            setDomain(v)
            savePrefs({ domain: v })
          }}
          disabled={!options.domains.length} />
        <button type="button" class="btn" id="issue" disabled={!canIssue} onClick={() => void issue()}>
          発行
        </button>
      </div>
      <div class="line">
        <span class="label">転送先</span>
        <Combobox
          id="target"
          label="転送先"
          value={target}
          candidates={options.forwardTargets}
          onInput={v => {
            setTarget(v)
            setTargetTouched(true)
            if (MAIL_RE.test(v.trim())) savePrefs({ forwardTo: v.trim() })
          }}
          onEnter={() => void issue()}
        />
      </div>
      {invalid && <div class="err" id="target-error">メールアドレスの形式で入力してください</div>}
    </div>
  )
}
