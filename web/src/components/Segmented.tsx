// 排他選択のボタン群。
type Props<T extends string> = { items: { value: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }

export function Segmented<T extends string>({ items, value, onChange, label }: Props<T>) {
  return (
    <div class="seg" role="group" aria-label={label}>
      {items.map(it => (
        <button key={it.value} type="button" aria-pressed={it.value === value} onClick={() => onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  )
}
