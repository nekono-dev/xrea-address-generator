import { expect, test, type Page } from "@playwright/test"
import { mockApi } from "./mock"

async function open(page: Page, width: number) {
  await page.setViewportSize({ width, height: 760 })
  await mockApi(page)
  await page.goto("/")
  await expect(page.locator(".row").first()).toBeVisible()
  await expect(page.locator("#issue")).toBeEnabled()
}
/** 文字入力欄（発行フォームと、行内の転送先の変更）の文字の大きさ */
const inputFontSizes = (page: Page) => page.evaluate(() => [...document.querySelectorAll("input")].map(i => parseFloat(getComputedStyle(i).fontSize)))

test.describe("幅ごとの寸法と文字の大きさ", () => {
  test("web-ui/AC-22: 本文の文字の大きさが、幅900ピクセルで15ピクセル、幅360ピクセルで18ピクセルになる", async ({ page }) => {
    const sizes = async () =>
      page.evaluate(() => ({
        body: getComputedStyle(document.body).fontSize,
        row: getComputedStyle(document.querySelector(".row .addr")!).fontSize,
        ghost: getComputedStyle(document.querySelector(".row [data-copy]")!).fontSize,
        chip: getComputedStyle(document.querySelector(".chip")!).fontSize,
      }))
    await open(page, 900)
    expect(await sizes()).toEqual({ body: "15px", row: "15px", ghost: "13px", chip: "12px" })
    await page.setViewportSize({ width: 360, height: 760 })
    expect(await sizes()).toEqual({ body: "18px", row: "18px", ghost: "16px", chip: "14px" })
    // 大きくした文字でも横スクロールが出ない
    const { doc, vw } = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vw: window.innerWidth }))
    expect(doc).toBeLessThanOrEqual(vw)
  })
})

test.describe("タッチ操作の端末", () => {
  test.use({ hasTouch: true, isMobile: true })

  for (const width of [900, 360]) {
    test(`web-ui/AC-23: タッチ操作の端末として開くと、すべての文字入力欄の文字が16ピクセル以上になる（幅${width}）`, async ({ page }) => {
      await open(page, width)
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true)
      await page.locator('[data-address="shop@example.com"] [data-edit]').click()
      const sizes = await inputFontSizes(page)
      expect(sizes.length).toBe(4)
      for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16)
    })
  }
})
