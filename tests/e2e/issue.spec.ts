import { expect, test, type Page } from "@playwright/test"
import { alias, mockApi } from "./mock"

async function open(page: Page, width = 900) {
  await page.setViewportSize({ width, height: 700 })
  const api = await mockApi(page)
  await page.goto("/")
  await expect(page.locator(".row")).toHaveCount(27)
  await expect(page.locator("#issue")).toBeEnabled()
  return api
}
const posts = (api: Awaited<ReturnType<typeof mockApi>>) => api.requests.filter(r => r.method === "POST" && r.path === "/api/aliases")

test.describe("発行フォームと部品", () => {
  for (const width of [900, 360]) {
    test(`web-ui/AC-13: 4つの部品の描画後の高さが、幅900ピクセルで38ピクセル、幅360ピクセルで44ピクセルになる（幅${width}）`, async ({ page }) => {
      await open(page, width)
      const heights = await page.evaluate(() =>
        ["#name", "#issue", "#domain .dd-btn", "#target input"].map(s => Math.round(document.querySelector(s)!.getBoundingClientRect().height)),
      )
      const h = width < 680 ? 44 : 38
      expect(heights).toEqual([h, h, h, h])
    })

    test(`web-ui/AC-16: 両方の候補リストの全項目が最前面に表示される（幅${width}）`, async ({ page }) => {
      await open(page, width)
      // 候補リストの最終項目の中心にある最前面の要素が、その項目自身であることを確かめる
      const lastOnTop = (menu: string) =>
        page.evaluate(m => {
          const items = [...document.querySelectorAll(`${m} [role=option]`)]
          const last = items[items.length - 1]!
          const b = last.getBoundingClientRect()
          const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)
          return { count: items.length, onTop: !!top && (top === last || last.contains(top)) }
        }, menu)
      await page.locator("#domain .dd-btn").click()
      await page.waitForTimeout(200)
      expect(await lastOnTop("#domain")).toEqual({ count: 3, onTop: true })
      await page.keyboard.press("Escape")
      await page.locator("#target .chev").click()
      await page.locator("#target input").fill("")
      await page.waitForTimeout(200)
      expect(await lastOnTop("#target")).toEqual({ count: 3, onTop: true })
      // スクロール後に開いても見切れない
      await page.keyboard.press("Escape")
      await page.mouse.wheel(0, 600)
      await page.waitForTimeout(200)
      await page.locator("#domain .dd-btn").click()
      await page.waitForTimeout(200)
      expect(await lastOnTop("#domain")).toEqual({ count: 3, onTop: true })
    })
  }

  test("web-ui/AC-14: 幅360ピクセルの表示で、文書の横幅が表示幅を超えない", async ({ page }) => {
    await open(page, 360)
    await page.mouse.wheel(0, 400)
    const { doc, vw } = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }))
    expect(doc).toBeLessThanOrEqual(vw)
  })

  for (const width of [360, 390, 430]) {
    test(`web-ui/AC-14: 幅${width}ピクセルで長いドメインを含む一覧を初回表示しても、閉じた候補リストを含めて横幅が表示幅を超えない`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await mockApi(page, { aliases: [alias("booth.long.name@mail.unnamed.works", ["accounts.booth.pm"], "very.long.forward.address@unnamed.works"), alias("a@example.com")] })
      await page.goto("/")
      await page.waitForSelector(".row")
      const r = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        vw: window.innerWidth,
        over: [...document.querySelectorAll("*")].filter(e => e.getBoundingClientRect().right > window.innerWidth + 0.5).map(e => `${e.tagName}.${e.className}`),
      }))
      expect(r.over).toEqual([])
      expect(r.doc).toBeLessThanOrEqual(r.vw)
    })
  }

  test("web-ui/AC-1: ページを下へ600ピクセルスクロールした後も、発行フォームの上端が画面の上端に位置する", async ({ page }) => {
    await open(page)
    await page.mouse.wheel(0, 600)
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(400)
    expect(await page.evaluate(() => Math.round(document.querySelector("#sticky")!.getBoundingClientRect().top))).toBe(0)
  })

  test("web-ui/AC-4: キーボードだけでドメインを選ぶと表示が切り替わり、その値で発行される", async ({ page }) => {
    const api = await open(page)
    await page.locator("#domain .dd-btn").focus()
    await page.keyboard.press("ArrowDown")
    await expect(page.locator("#domain [role=option]")).toHaveText(["example.com", "example.net", "example.org"])
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Enter")
    await expect(page.locator("#domain .dd-label")).toHaveText("example.net")
    await page.locator("#name").fill("keyboard")
    await page.locator("#name").press("Enter")
    await expect.poll(() => posts(api).length).toBe(1)
    expect(posts(api)[0]!.body.domain).toBe("example.net")
  })

  test("web-ui/AC-2: 名前欄でEnterを押すと発行の要求が1回送信され、変換確定中のEnterでは送信されない", async ({ page }) => {
    const api = await open(page)
    await page.locator("#name").fill("travel")
    // 日本語入力の変換確定中の Enter を模擬する
    await page.locator("#name").dispatchEvent("keydown", { key: "Enter", isComposing: true, keyCode: 229 })
    await page.waitForTimeout(200)
    expect(posts(api)).toHaveLength(0)
    await page.locator("#name").press("Enter")
    await expect.poll(() => posts(api).length).toBe(1)
    expect(posts(api)[0]!.body).toEqual({ name: "travel", domain: "example.com", forwardTo: "family@mail.example" })
    await expect(page.locator('[data-address="travel@example.com"]')).toBeVisible()
  })

  test("web-ui/AC-3: 名前を空にしてEnterを押すと、要求の名前が空で送信され、応答の行が強調表示される", async ({ page }) => {
    const api = await open(page)
    await page.locator("#name").press("Enter")
    await expect.poll(() => posts(api).length).toBe(1)
    expect(posts(api)[0]!.body).not.toHaveProperty("name")
    const row = page.locator('[data-address="quiet.river42@example.com"]')
    await expect(row).toHaveClass(/flash/)
    await expect(row).toBeInViewport()
    await expect(page.locator(".toasts")).toContainText("quiet.river42@example.com を発行しました")
  })

  test("web-ui/AC-5: 形式不正の転送先で誤りが表示されて発行ボタンが無効になり、候補を選ぶと有効になる", async ({ page }) => {
    await open(page)
    await page.locator("#target input").fill("bad")
    await expect(page.locator("#target-error")).toHaveText("メールアドレスの形式で入力してください")
    await expect(page.locator("#issue")).toBeDisabled()
    await page.locator("#target input").fill("")
    await page.locator("#target [role=option]", { hasText: "sub@mail.example" }).click()
    await expect(page.locator("#target input")).toHaveValue("sub@mail.example")
    await expect(page.locator("#issue")).toBeEnabled()
  })
})
