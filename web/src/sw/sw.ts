// Service Worker の本体。画面ファイルだけを端末へ保存し、APIは横取りしない。
import { CACHE, isShell, networkFirst, referencedAssets, route, SHELL, staleAssets, STATIC_FILES } from "./core"

// DOM の型定義だけで書けるよう、使う範囲の Service Worker の型を定義する
type ExtendableEvent = Event & { waitUntil(p: Promise<unknown>): void }
type FetchEvent = ExtendableEvent & { request: Request; respondWith(r: Response | Promise<Response>): void }
type SwScope = {
  location: Location
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
  addEventListener(type: "install" | "activate", f: (e: ExtendableEvent) => void): void
  addEventListener(type: "fetch", f: (e: FetchEvent) => void): void
}
const sw = self as unknown as SwScope

/** 入口を保存し、新しい入口から参照されない画面ファイルを削除する */
async function saveShell(cache: Cache, res: Response): Promise<void> {
  const html = await res.clone().text()
  await cache.put(SHELL, res)
  const paths = (await cache.keys()).map(r => new URL(r.url).pathname)
  await Promise.all(staleAssets(paths, html).map(p => cache.delete(p)))
}

async function precache(): Promise<void> {
  const cache = await caches.open(CACHE)
  const res = await fetch(SHELL, { cache: "reload" })
  if (!isShell(res)) throw new Error(`画面の入口を取得できません（HTTP ${res.status}）`) // 導入を失敗させ、次回やり直す
  const html = await res.clone().text()
  await cache.addAll([...referencedAssets(html), ...STATIC_FILES])
  await saveShell(cache, res)
  await sw.skipWaiting()
}

async function cleanup(): Promise<void> {
  await Promise.all((await caches.keys()).filter(k => k !== CACHE).map(k => caches.delete(k)))
  await sw.clients.claim()
}

async function cacheFirst(req: Request): Promise<Response> {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(req, { ignoreVary: true }) // 要求の Origin の有無で照合が外れないようにする
  if (hit) return hit
  const res = await fetch(req)
  if (res.ok) await cache.put(req, res.clone()).catch(() => undefined)
  return res
}

async function staleWhileRevalidate(req: Request, wait: (p: Promise<unknown>) => void): Promise<Response> {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(req, { ignoreVary: true }) // 要求の Origin の有無で照合が外れないようにする
  const update = fetch(req).then(async res => {
    if (res.ok) await cache.put(req, res.clone()).catch(() => undefined)
    return res
  })
  if (hit) {
    wait(update.catch(() => undefined))
    return hit
  }
  return update
}

sw.addEventListener("install", e => e.waitUntil(precache()))
sw.addEventListener("activate", e => e.waitUntil(cleanup()))
sw.addEventListener("fetch", e => {
  const req = e.request
  const kind = route(new URL(req.url), req.method, req.mode, sw.location.origin)
  if (kind === "network") return
  if (kind === "navigate") {
    e.respondWith(
      networkFirst({
        fetch: () => fetch(req),
        cached: async () => (await caches.open(CACHE)).match(SHELL),
        save: async r => saveShell(await caches.open(CACHE), r),
      }),
    )
  } else if (kind === "asset") e.respondWith(cacheFirst(req))
  else e.respondWith(staleWhileRevalidate(req, p => e.waitUntil(p)))
})
