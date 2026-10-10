// 通知。ブラウザ標準の通知ダイアログは使わない。
import { store as defaultStore, useStore, type Store } from "../store"

export function Toasts({ store = defaultStore }: { store?: Store }) {
  const toasts = useStore(s => s.toasts, store)
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} class="toast">
          {t.text}
        </div>
      ))}
    </div>
  )
}
