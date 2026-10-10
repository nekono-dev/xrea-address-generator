import { expect, test } from "@playwright/test"
import { mockApi, ready } from "./mock"

test.describe("照合状態の通知", () => {
  test("web-ui/AC-10: 状態が再ログインの応答を返す状態で開くと、帯が表示され、完了後に通知が出る", async ({ page }) => {
    await page.clock.install()
    await mockApi(page, {
      proton: ready({ state: "relogin" }),
      protonSequence: [ready({ state: "relogin" }), ready({ reloginAt: "2026-10-10T02:00:00.000Z", updatedAt: "2026-10-10T02:00:00.000Z" })],
    })
    await page.goto("/")
    await expect(page.locator(".banner")).toContainText("再ログインしています")
    await page.clock.runFor(5_000)
    await expect(page.locator(".banner")).toContainText("再ログインしています")
    await page.clock.runFor(5_000)
    await expect(page.locator(".banner")).toHaveCount(0)
    await expect(page.locator(".toasts")).toContainText("Proton Pass に再ログインしました")
    await expect(page.locator("#proton-status")).toContainText("315件を参照")
  })

  test("web-ui/AC-10: 更新ボタンの押下で再取得の要求が送信され、照合中の表示を経て完了する", async ({ page }) => {
    await page.clock.install()
    const api = await mockApi(page, { protonSequence: [] })
    await page.goto("/")
    await expect(page.locator("#proton-status")).toContainText("315件を参照")
    api.state.protonSequence.push(ready({ state: "loading" }), ready({ updatedAt: "2026-10-10T03:00:00.000Z" }))
    await page.locator("#proton-refresh").click()
    await expect.poll(() => api.requests.some(r => r.method === "POST" && r.path === "/api/proton/refresh")).toBe(true)
    await expect(page.locator("#proton-status")).toContainText("Protonを照合中")
    // 5秒ごとの状態確認を2回進める（各回の通信の完了を待ってから次へ進める）
    const statusCalls = () => api.requests.filter(r => r.path === "/api/proton/status").length
    for (let i = 1; i <= 2; i++) {
      await page.clock.runFor(5_000)
      await expect.poll(statusCalls).toBe(i)
    }
    await expect(page.locator("#proton-status")).toContainText("315件を参照")
    // 完了後は一覧を取り直す
    expect(api.requests.filter(r => r.method === "GET" && r.path === "/api/aliases").length).toBeGreaterThanOrEqual(2)
  })
})
