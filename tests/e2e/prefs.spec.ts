import { expect, test, type Page } from "@playwright/test"
import { alias, mockApi } from "./mock"

const PREFS_KEY = "xrea-address-generator:prefs"
async function open(page: Page) {
  await page.goto("/")
  await expect(page.locator(".row").first()).toBeVisible()
  await expect(page.locator("#issue")).toBeEnabled()
}

test.describe("選択した値の保存と復元", () => {
  test("web-ui/AC-19: 選んだドメインが再読み込み後の初期値になり、候補に無い保存値は先頭の候補に置き換わる", async ({ page }) => {
    await mockApi(page)
    await open(page)
    await expect(page.locator("#domain .dd-btn")).toContainText("example.com")
    await page.locator("#domain .dd-btn").click()
    await page.locator("#domain [role=option]", { hasText: "example.net" }).click()
    await page.reload()
    await open(page)
    await expect(page.locator("#domain .dd-btn")).toContainText("example.net")
    // 候補に無いドメインが保存されているとき
    await page.evaluate(k => localStorage.setItem(k, JSON.stringify({ domain: "gone.example" })), PREFS_KEY)
    await page.reload()
    await open(page)
    await expect(page.locator("#domain .dd-btn")).toContainText("example.com")
  })

  test("web-ui/AC-20: 入力した有効な転送先が再読み込み後の初期値になり、形式不正の入力は保存されない", async ({ page }) => {
    await mockApi(page)
    await open(page)
    await expect(page.locator("#target input")).toHaveValue("family@mail.example")
    await page.locator("#target input").fill("new@mail.example")
    await page.reload()
    await open(page)
    await expect(page.locator("#target input")).toHaveValue("new@mail.example")
    await page.locator("#target input").fill("broken-address")
    await page.reload()
    await open(page)
    await expect(page.locator("#target input")).toHaveValue("new@mail.example")
  })

  test("web-ui/AC-21: 選んだ絞り込みと並び順が、再読み込み後も同じ状態で表示される", async ({ page }) => {
    await mockApi(page, { aliases: [alias("b@example.com"), alias("a@example.com"), alias("c@example.net")] })
    await open(page)
    await page.locator("#filter .dd-btn").click()
    await page.locator("#filter [role=option]", { hasText: "example.com" }).click()
    await page.getByRole("button", { name: "Z→A" }).click()
    await page.reload()
    await open(page)
    await expect(page.locator(".row .addr")).toHaveText(["b@example.com", "a@example.com"])
    await expect(page.locator("#filter .dd-btn")).toContainText("example.com")
    await expect(page.getByRole("button", { name: "Z→A" })).toHaveAttribute("aria-pressed", "true")
  })
})
