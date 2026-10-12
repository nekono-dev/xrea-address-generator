import { expect, test, type Page } from "@playwright/test"
import { mockApi } from "./mock"

test.use({ serviceWorkers: "allow" })

/** 画面を開き、Service Worker が導入されて画面を制御するまで待つ */
async function openControlled(page: Page) {
  const api = await mockApi(page)
  await page.goto("/")
  await expect(page.locator(".row").first()).toBeVisible()
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (!navigator.serviceWorker.controller) await new Promise(r => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }))
  })
  return api
}
const cachedPaths = (page: Page) => page.evaluate(async () => (await Promise.all((await caches.keys()).map(async k => (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname)))).flat())

test.describe("宣言とアイコン", () => {
  test("web-pwa/AC-1: 画面の入口から参照する宣言に、名前・短い名前・テーマ色・単独表示の形式と、192と512ピクセルのアイコンが含まれる", async ({ page }) => {
    await mockApi(page)
    await page.goto("/")
    const link = page.locator('link[rel="manifest"]')
    await expect(link).toHaveAttribute("crossorigin", "use-credentials")
    const m = await (await page.request.get((await link.getAttribute("href"))!)).json()
    expect(m).toMatchObject({ name: "XREA Alias Dashboard", short_name: "Alias", display: "standalone", theme_color: "#0f172a", start_url: "/" })
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toEqual(["192x192", "512x512"])
  })

  test("web-pwa/AC-2: 画面の入口に、iOS用のアイコン・ホーム画面での名前・単独表示の指定が含まれる", async ({ page }) => {
    await mockApi(page)
    await page.goto("/")
    await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", "/icons/apple-touch-icon.png")
    await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute("content", "Alias")
    await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute("content", "yes")
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0f172a")
  })

  test("web-pwa/AC-10: 3種類のアイコンが、宣言した大きさの正方形の画像として取得できる", async ({ page }) => {
    await mockApi(page)
    await page.goto("/")
    const sizes = await page.evaluate(async () => {
      const load = (src: string) =>
        new Promise<string>((ok, ng) => {
          const img = new Image()
          img.onload = () => ok(`${img.naturalWidth}x${img.naturalHeight}`)
          img.onerror = () => ng(new Error(src))
          img.src = src
        })
      return Promise.all(["/icons/icon-192.png", "/icons/icon-512.png", "/icons/apple-touch-icon.png"].map(load))
    })
    expect(sizes).toEqual(["192x192", "512x512", "180x180"])
  })
})

test.describe("画面ファイルの保存とオフライン", () => {
  test("web-pwa/AC-3: 一度表示した後にオフラインにして再読み込みすると、画面の見出しと発行フォームが表示される", async ({ page, context }) => {
    await openControlled(page)
    await context.setOffline(true)
    await page.reload()
    await expect(page.locator("h1")).toHaveText("XREA ALIAS DASHBOARD")
    await expect(page.locator("#name")).toBeVisible()
    await expect(page.locator("#issue")).toBeVisible()
  })

  test("web-pwa/AC-11: 一度表示した後にオフラインにして再読み込みすると、2秒以内に画面の見出しが表示される", async ({ page, context }) => {
    await openControlled(page)
    await context.setOffline(true)
    const start = Date.now()
    await page.reload({ waitUntil: "commit" })
    await expect(page.locator("h1")).toBeVisible({ timeout: 2000 })
    expect(Date.now() - start).toBeLessThan(2000)
  })

  test("web-pwa/AC-4: 一覧と候補を取得した後の端末の保存領域に、APIと死活確認の応答が含まれない", async ({ page }) => {
    const api = await openControlled(page)
    await page.reload()
    await expect(page.locator(".row").first()).toBeVisible()
    expect(api.requests.filter(r => r.path === "/api/aliases" && r.method === "GET").length).toBeGreaterThanOrEqual(2)
    const paths = await cachedPaths(page)
    expect(paths).toContain("/")
    expect(paths.some(p => p.startsWith("/assets/"))).toBe(true)
    expect(paths.filter(p => p.startsWith("/api/") || p === "/healthz")).toEqual([])
  })

  test("web-pwa/AC-7: オフラインにすると帯が表示され、オンラインに戻すと帯が消えて一覧の要求が送信される", async ({ page, context }) => {
    const api = await openControlled(page)
    await context.setOffline(true)
    await expect(page.locator('.banner[data-kind="offline"]')).toHaveText("オフラインです。接続が戻ると一覧を取り直します")
    const before = api.requests.filter(r => r.path === "/api/aliases").length
    await context.setOffline(false)
    await expect(page.locator('.banner[data-kind="offline"]')).toHaveCount(0)
    await expect.poll(() => api.requests.filter(r => r.path === "/api/aliases").length).toBeGreaterThan(before)
  })
})
