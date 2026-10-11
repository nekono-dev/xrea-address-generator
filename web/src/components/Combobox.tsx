// 自由入力つきの候補選択。input[role=combobox] と候補の ul[role=listbox] で構成する。
import { useEffect, useRef, useState } from "preact/hooks"

export const MAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export const isInvalidMail = (v: string): boolean => v.trim() !== "" && !MAIL_RE.test(v.trim())

type Props = {
  value: string
  onInput: (v: string) => void
  candidates: string[]
  onEnter: () => void
  onEscape?: () => void
  label: string
  id?: string
  autoFocus?: boolean
  /** 入力欄の name 属性 */
  name?: string
  placeholder?: string
  /** 誤りの判定。省略時はメールアドレスの形式の検査 */
  invalid?: boolean
  /** 該当する候補がないときの文言 */
  noneText?: string
}

export function Combobox({ value, onInput, candidates, onEnter, onEscape, label, id, autoFocus, name, placeholder, invalid: invalidProp, noneText }: Props) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(-1)
  const [typed, setTyped] = useState(false) // 文字を入力したときだけ候補を絞り込む
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const q = value.trim().toLowerCase()
  const items = typed ? candidates.filter(c => c.toLowerCase().includes(q)) : candidates
  const invalid = invalidProp ?? isInvalidMail(value)

  const quietFocus = useRef(false) // 自動のフォーカスでは候補を開かない（隣のボタンを隠さないため）
  useEffect(() => {
    if (!autoFocus) return
    quietFocus.current = true
    input.current?.focus()
    quietFocus.current = false
  }, [])
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("click", onDoc)
    return () => document.removeEventListener("click", onDoc)
  }, [])

  // キーボードで移動した候補が見える位置までスクロールする
  useEffect(() => {
    if (open && hi >= 0) root.current?.querySelectorAll("[role=option]")[hi]?.scrollIntoView?.({ block: "nearest" })
  }, [hi, open])

  const choose = (v: string) => {
    onInput(v)
    setOpen(false)
    setHi(-1)
    setTyped(false)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.isComposing) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setOpen(true)
      setHi(h => Math.min(h + 1, items.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setHi(h => Math.max(h - 1, 0))
    } else if (e.key === "Escape") {
      // 候補が閉じた状態の Escape は呼び出し元へ伝える
      if (!open) onEscape?.()
      setOpen(false)
    } else if (e.key === "Tab") {
      setOpen(false)
    } else if (e.key === "Enter") {
      e.preventDefault()
      const v = open && hi >= 0 ? items[hi] : undefined
      if (v !== undefined) choose(v)
      else {
        setOpen(false)
        onEnter()
      }
    }
  }

  return (
    <div
      class={`cb${open ? " open" : ""}`}
      ref={root}
      id={id}
      onFocusOut={e => {
        // フォーカスが部品の外へ移ったら閉じる
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <input
        ref={input}
        class={`fld${invalid ? " bad" : ""}`}
        name={name}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-label={label}
        aria-invalid={invalid}
        placeholder={placeholder ?? "選択、またはメールアドレスを入力"}
        autocomplete="off"
        value={value}
        onFocus={() => {
          if (!quietFocus.current) setOpen(true)
          setTyped(false)
        }}
        onInput={e => {
          onInput((e.target as HTMLInputElement).value)
          setOpen(true)
          setHi(-1)
          setTyped(true)
        }}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        class="chev"
        tabIndex={-1}
        aria-label="候補を開く"
        onMouseDown={e => e.preventDefault()}
        onClick={() => {
          setTyped(false)
          setOpen(o => !o)
          input.current?.focus()
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
      <ul class="dd-menu" role="listbox" aria-label={`${label}の候補`}>
        {items.length ? (
          items.map((v, i) => (
            <li
              key={v}
              role="option"
              aria-selected={v === value}
              class={i === hi ? "hi" : ""}
              onMouseDown={e => {
                e.preventDefault()
                choose(v)
              }}
            >
              {v}
            </li>
          ))
        ) : (
          <li class="none">{noneText ?? "候補なし（入力した値を使います）"}</li>
        )}
      </ul>
    </div>
  )
}
