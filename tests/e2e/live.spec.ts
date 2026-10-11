// 配備した実環境（Docker構成のLAN公開、またはWorkers）に対する、実ブラウザでの登録・発行・再表示・削除。
// LIVE_APP_URL を指定したときだけ実行する（playwright.live.config.ts から）。実際のXREAを使うため、
// 作成するのは poc- で始まる名前だけで、作成したアドレスは必ず削除する。
import { expect, test } from "@playwright/test"

const url = process.env.LIVE_APP_URL
const x = process.env
const creds = { server: x.XREA_POC_SERVER_NAME ?? "", account: x.XREA_POC_ACCOUNT ?? "", key: x.XREA_POC_API_SECRET_KEY ?? "" }
const domain = x.XREA_POC_DOMAIN ?? ""
const forwardTo = x.XREA_POC_FORWARD_TO ?? ""

test.describe("実環境", () => {
  test.skip(!url || !creds.key || !domain || !forwardTo, "LIVE_APP_URL と XREA_POC_* が必要です")
  test.use({ baseURL: url, serviceWorkers: "block" })

  test("実環境: 実ブラウザで、登録・発行・再読み込み後の表示・削除ができ、検証用アドレスが残らない", async ({ page }) => {
    test.setTimeout(120_000)
    const name = `poc-e2e-${Date.now().toString(36)}`
    const address = `${name}@${domain}`
    try {
      await page.goto("/")
      await expect(page.locator("#credentials")).toBeVisible()
      await page.locator('input[name="server"]').fill(creds.server)
      await page.locator('input[name="username"]').fill(creds.account)
      await page.locator('input[name="password"]').fill(creds.key)
      await page.locator("#cred-submit").click()
      await expect(page.locator("#credentials")).toHaveCount(0, { timeout: 30_000 })
      await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 })
      const before = await page.locator(".row").count()

      // 発行（候補にあるドメインと転送先を入力する）
      await page.locator("#domain input").fill(domain)
      await page.locator("#target input").fill(forwardTo)
      await page.locator("#name").fill(name)
      await page.locator("#name").press("Enter")
      const row = page.locator(`[data-address="${address}"]`)
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(page.locator(".toasts")).toContainText("を発行しました")

      // 再読み込みしても、cookie から登録済みと判断され、発行したアドレスが一覧に出る
      await page.reload()
      await expect(page.locator("#credentials")).toHaveCount(0)
      await expect(row).toBeVisible({ timeout: 30_000 })

      // 削除（確認つき）
      await row.locator("[data-delete]").click()
      await row.locator("[data-yes]").click()
      await expect(page.locator(`[data-address="${address}"]`)).toHaveCount(0, { timeout: 30_000 })
      await expect(page.locator(".toasts")).toContainText("メールアドレスを削除しました")
      await page.reload()
      await expect(page.locator(".row").first()).toBeVisible({ timeout: 30_000 })
      expect(await page.locator(".row").count()).toBe(before)
      await expect(page.locator(`[data-address="${address}"]`)).toHaveCount(0)
    } finally {
      // 途中で失敗したときも、検証用アドレスを残さない
      await page.request.delete(`/api/aliases/${encodeURIComponent(address)}`).catch(() => undefined)
    }
  })
})
