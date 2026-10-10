import { expect, test } from "@playwright/test"
import { alias, mockApi } from "./mock"

test.describe("一覧と行の操作", () => {
  test("web-ui/AC-6: ドメインで絞り込み、降順に切り替えると、行が絞られ並びが逆になる", async ({ page }) => {
    await mockApi(page, { aliases: [alias("b@example.com"), alias("a@example.com"), alias("c@example.net")] })
    await page.goto("/")
    const rows = page.locator(".row .ad")
    await expect(rows).toHaveText(["a@example.com", "b@example.com", "c@example.net"])
    await page.locator("#filter .dd-btn").click()
    await page.locator("#filter [role=option]", { hasText: "example.com" }).click()
    await expect(rows).toHaveText(["a@example.com", "b@example.com"])
    await expect(page.locator("#count")).toHaveText("2件")
    await page.getByRole("button", { name: "Z→A" }).click()
    await expect(rows).toHaveText(["b@example.com", "a@example.com"])
  })

  test("web-ui/AC-9: 削除を押して確認すると、確認前は削除が送信されず、確認文にエントリ名が含まれる", async ({ page }) => {
    const api = await mockApi(page)
    await page.goto("/")
    const row = page.locator('[data-address="sns@example.net"]')
    await row.locator("[data-delete]").click()
    await expect(row.locator(".confirm-text")).toHaveText("Proton Passに「Bluesky」「X (Twitter)」があります。メールを削除しますか？")
    expect(api.requests.some(r => r.method === "DELETE")).toBe(false)
    await row.locator("[data-yes]").click()
    await expect(page.locator('[data-address="sns@example.net"]')).toHaveCount(0)
    expect(api.requests.filter(r => r.method === "DELETE").map(r => r.path)).toEqual(["/api/aliases/sns%40example.net"])
    await expect(page.locator(".toasts")).toContainText("メールアドレスを削除しました")
  })

  test("web-ui/AC-7: 行にエントリ名が表示され、照合の取得中は読み込み表示が出る", async ({ page }) => {
    await mockApi(page, { proton: { state: "loading", updatedAt: null, reloginAt: null, itemCount: null, error: null } })
    await page.goto("/")
    await expect(page.locator(".chip.sk").first()).toBeVisible()
    await expect(page.locator("#proton-status")).toContainText("Protonを照合中")
  })

  test("web-ui/AC-12: ネイティブの選択要素・ダイアログ要素・標準ダイアログが無く、キーボードだけで発行から削除まで操作できる", async ({ page }) => {
    const api = await mockApi(page)
    await page.goto("/")
    await expect(page.locator(".row").first()).toBeVisible()
    expect(await page.locator("select, dialog, datalist").count()).toBe(0)

    // 発行: Tab で名前欄へ移動し、入力して Enter
    await page.keyboard.press("Tab")
    await expect(page.locator("#name")).toBeFocused()
    await page.keyboard.type("kbd-only")
    await page.keyboard.press("Enter")
    await expect(page.locator('[data-address="kbd-only@example.com"]')).toBeVisible()

    // 削除: Tab で対象の行の削除ボタンまで移動し、Enter → 確認（やめる にフォーカス）→ Shift+Tab で 削除 → Enter
    const target = '[data-address="kbd-only@example.com"] [data-delete]'
    for (let i = 0; i < 120 && !(await page.locator(target).evaluate(el => el === document.activeElement)); i++) await page.keyboard.press("Tab")
    await expect(page.locator(target)).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.locator('[data-address="kbd-only@example.com"] [data-no]')).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await expect(page.locator('[data-address="kbd-only@example.com"] [data-yes]')).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page.locator('[data-address="kbd-only@example.com"]')).toHaveCount(0)
    expect(api.requests.filter(r => r.method === "DIALOG")).toEqual([])
  })
})
