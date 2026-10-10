/// <reference types="vite/client" />
// Service Worker の登録と、オフラインの帯。
import { useEffect, useState } from "preact/hooks"
import { Banner } from "./components/Banner"

/** 本番のビルドでだけ登録する（開発用サーバでは画面ファイルを保存させない） */
export function registerServiceWorker(nav: Navigator = navigator, prod = import.meta.env.PROD): void {
  if (!prod || !("serviceWorker" in nav)) return
  void nav.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined) // 失敗しても通常の画面として動かす
}

/** オフラインの間だけ帯を出し、オンラインへ戻ったときに onOnline を呼ぶ */
export function OfflineBanner({ onOnline }: { onOnline: () => void }) {
  const [online, setOnline] = useState(() => navigator.onLine !== false) // 判定できない環境ではオンラインとみなす
  useEffect(() => {
    const on = () => {
      setOnline(true)
      onOnline()
    }
    const off = () => setOnline(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
    }
  }, [])
  return online ? null : <Banner kind="offline" text="オフラインです。接続が戻ると一覧を取り直します" />
}
