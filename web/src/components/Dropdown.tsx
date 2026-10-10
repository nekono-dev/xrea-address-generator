// 独自のドロップダウン。button と ul[role=listbox] で構成し、ネイティブの select は使わない。
import { useEffect, useRef, useState } from "preact/hooks"

type Props = { items: string[]; value: string; onChange: (v: string) => void; label: string; id?: string; disabled?: boolean }

export function Dropdown({ items, value, onChange, label, id, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const [hi, setHi] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const current = Math.max(0, items.indexOf(value))

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("click", onDoc)
    return () => document.removeEventListener("click", onDoc)
  }, [])

  const openMenu = () => {
    setHi(current)
    setOpen(true)
  }
  const pick = (i: number) => {
    const v = items[i]
    if (v !== undefined) onChange(v)
    setOpen(false)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      open ? setHi(h => Math.min(h + 1, items.length - 1)) : openMenu()
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      open ? setHi(h => Math.max(h - 1, 0)) : openMenu()
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      open ? pick(hi) : openMenu()
    } else if (e.key === "Escape") {
      setOpen(false)
    } else if (e.key === "Tab") {
      setOpen(false)
    }
  }

  return (
    <div
      class={`dd${open ? " open" : ""}`}
      ref={root}
      id={id}
      onFocusOut={e => {
        // フォーカスが部品の外へ移ったら閉じる
        if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        type="button"
        class="dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span class="dd-label">{value}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        </svg>
      </button>
      <ul class="dd-menu" role="listbox" aria-label={label}>
        {items.map((it, i) => (
          <li
            key={it}
            role="option"
            aria-selected={i === current}
            class={i === hi && open ? "hi" : ""}
            onMouseMove={() => setHi(i)}
            onMouseDown={e => e.preventDefault()}
            onClick={() => pick(i)}
          >
            {it}
          </li>
        ))}
      </ul>
    </div>
  )
}
