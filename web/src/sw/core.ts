// Service Worker の判断部分（要求の振り分け、通信優先の取得、参照ファイルの抽出）。副作用を持たず、単体で検証できる。
export const CACHE = "xrea-alias-dashboard-shell"
export const SHELL = "/" // 画面の入口は、パスによらずこのキーで保存する
export const NAV_TIMEOUT_MS = 3000
export const STATIC_FILES = ["/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"]

export type Route = "network" | "navigate" | "asset" | "static"

/** 要求の扱いを決める。network は横取りせず、ブラウザの通常の通信に任せる */
export function route(url: URL, method: string, mode: string, origin: string): Route {
  if (method !== "GET" || url.origin !== origin) return "network"
  if (url.pathname.startsWith("/api/") || url.pathname === "/healthz" || url.pathname === "/sw.js") return "network"
  if (mode === "navigate") return "navigate"
  if (url.pathname.startsWith("/assets/")) return "asset"
  return "static"
}

/** 画面の入口が参照する /assets/ のパス（重複なし、出現順） */
export function referencedAssets(html: string): string[] {
  return [...new Set([...html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(m => m[1]!))]
}

/** 保存済みの /assets/ のうち、新しい入口から参照されないもの */
export function staleAssets(cachedPaths: readonly string[], html: string): string[] {
  const keep = new Set(referencedAssets(html))
  return cachedPaths.filter(p => p.startsWith("/assets/") && !keep.has(p))
}

/** 入口として保存してよい応答か（転送・認証の要求・エラーは保存しない） */
export function isShell(r: Response): boolean {
  return r.status === 200 && (r.type === "basic" || r.type === "default") && (r.headers.get("content-type") ?? "").includes("text/html")
}

export type ShellDeps = {
  fetch: () => Promise<Response>
  cached: () => Promise<Response | undefined>
  save: (r: Response) => Promise<void> // 入口の保存と、参照されない画面ファイルの削除
}

/** 通信を優先して入口を取得する。timeoutMs 以内に応答が無いか通信に失敗したら、保存した入口を返す */
export async function networkFirst(d: ShellDeps, timeoutMs = NAV_TIMEOUT_MS): Promise<Response> {
  const net = d.fetch().then(async r => {
    if (isShell(r)) await d.save(r.clone()).catch(() => undefined) // 容量不足では保存せずに応答だけ返す
    return r
  })
  net.catch(() => undefined) // 保存した入口を返した後の失敗は捨てる
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">(res => (timer = setTimeout(() => res("timeout"), timeoutMs)))
  try {
    const first = await Promise.race([net, timeout])
    if (first !== "timeout") return first // 転送（opaqueredirect）・401・403 もそのまま返す
  } catch (e) {
    const c = await d.cached()
    if (c) return c
    throw e
  } finally {
    clearTimeout(timer)
  }
  // 応答が遅いときは保存した入口を返し、後から届いた応答で保存を更新する
  return (await d.cached()) ?? net
}
