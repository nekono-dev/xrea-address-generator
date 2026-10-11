import { expect, test } from "@playwright/test"
import { mockApi } from "./mock"

const fillAll = async (page: import("@playwright/test").Page) => {
  await page.locator('input[name="server"]').fill("s1.xrea.com")
  await page.locator('input[name="username"]').fill("acct")
  await page.locator('input[name="password"]').fill("SECRET-KEY-VALUE")
}

test.describe("登録と切り替え", () => {
  test("web-credentials/AC-1: 未登録の状態でトップページを開くと、登録画面だけが表示され、一覧の要求が送信されない", async ({ page }) => {
    const api = await mockApi(page, { registered: false })
    await page.goto("/")
    await expect(page.locator("#credentials")).toBeVisible()
    await expect(page.locator("#issue")).toHaveCount(0)
    await expect(page.locator(".row")).toHaveCount(0)
    // サーバ名の選択肢の取得は、一覧の要求ではない
    expect(api.requests.map(r => `${r.method} ${r.path}`).filter(r => r !== "GET /api/servers")).toEqual(["GET /api/credentials"])
  })

  test("web-credentials/AC-5: 3項目を入力して登録すると、登録画面が消えて一覧の取得の要求が送信される", async ({ page }) => {
    const api = await mockApi(page, { registered: false })
    await page.goto("/")
    await expect(page.locator("#cred-submit")).toBeDisabled()
    await fillAll(page)
    await expect(page.locator("#cred-submit")).toBeEnabled()
    await page.locator("#cred-submit").click()
    await expect(page.locator("#credentials")).toHaveCount(0)
    await expect(page.locator(".row")).toHaveCount(27)
    const put = api.requests.find(r => r.method === "PUT")!
    expect(put.body).toEqual({ xrea: { account: "acct", serverName: "s1.xrea.com", apiSecretKey: "SECRET-KEY-VALUE" } })
    expect(api.requests.map(r => `${r.method} ${r.path}`)).toEqual(expect.arrayContaining(["GET /api/aliases", "GET /api/options"]))
  })

  test("web-credentials/AC-6: 登録が失敗すると、メッセージが登録画面の中に表示され、入力した値が残る", async ({ page }) => {
    const api = await mockApi(page, { registered: false })
    api.state.putFailure = { status: 400, code: "invalid_credentials", message: "x" }
    await page.goto("/")
    await fillAll(page)
    await page.locator("#cred-submit").click()
    await expect(page.locator(".cred-error")).toHaveText("XREAの認証情報を確認できませんでした")
    await expect(page.locator('input[name="password"]')).toHaveValue("SECRET-KEY-VALUE")
    await expect(page.locator('input[name="server"]')).toHaveValue("s1.xrea.com")
  })

  test("web-credentials/AC-7: 操作中のAPIが登録を求める応答を返すと、期限切れの案内を伴う登録画面に切り替わる", async ({ page }) => {
    const api = await mockApi(page)
    await page.goto("/")
    await expect(page.locator(".row")).toHaveCount(27)
    api.state.registered = false // サーバ側で期限が切れた状態
    await expect(page.locator("#issue")).toBeEnabled()
    await page.locator("#issue").click() // 発行の要求が登録を求められる
    await expect(page.locator("#credentials")).toBeVisible()
    await expect(page.locator(".cred-notice")).toContainText("有効期限が切れました")
    await expect(page.locator("#cred-cancel")).toHaveCount(0)
  })

  test("web-credentials/AC-8: 登録済みで認証情報ボタンを押すと、登録画面が開き、取り消しで主画面に戻る", async ({ page }) => {
    await mockApi(page)
    await page.goto("/")
    await expect(page.locator(".row")).toHaveCount(27)
    await page.locator("#cred-open").click()
    await expect(page.locator("#credentials")).toBeVisible()
    await expect(page.locator(".row")).toHaveCount(0)
    await page.locator("#cred-cancel").click()
    await expect(page.locator("#credentials")).toHaveCount(0)
    await expect(page.locator(".row")).toHaveCount(27)
  })

  test("web-credentials/AC-10: Tabキーだけで、サーバ名から送信まで操作できる", async ({ page }) => {
    const api = await mockApi(page, { registered: false })
    await page.goto("/")
    await page.locator('input[name="server"]').focus()
    await page.keyboard.type("s1.xrea.com")
    await page.keyboard.press("Tab")
    await expect(page.locator('input[name="username"]')).toBeFocused()
    await page.keyboard.type("acct")
    await page.keyboard.press("Tab")
    await expect(page.locator('input[name="password"]')).toBeFocused()
    await page.keyboard.type("key")
    await page.keyboard.press("Tab")
    await expect(page.locator("#cred-submit")).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(page.locator("#cred-proton")).toBeFocused()
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Enter")
    await expect(page.locator("#credentials")).toHaveCount(0)
    expect(api.requests.some(r => r.method === "PUT")).toBe(true)
    expect(api.requests.some(r => r.method === "DIALOG")).toBe(false)
    await expect(page.locator("dialog")).toHaveCount(0)
  })
})

test.describe("寸法", () => {
  test("web-credentials/AC-11: 幅360ピクセルの表示で、文書の横幅が表示幅を超えない", async ({ page }) => {
    await mockApi(page, { registered: false })
    await page.setViewportSize({ width: 360, height: 700 })
    await page.goto("/")
    await fillAll(page)
    await page.locator("#cred-proton").click()
    await page.locator('input[name="proton-token"]').fill("x".repeat(300))
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  })

  test("web-credentials/AC-11: 登録済みの主画面でも、幅360ピクセルで認証情報ボタンが横幅を超えない", async ({ page }) => {
    await mockApi(page)
    await page.setViewportSize({ width: 360, height: 700 })
    await page.goto("/")
    await expect(page.locator(".row")).toHaveCount(27)
    await expect(page.locator("#cred-open")).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360)
  })

  for (const [width, h] of [
    [900, 38],
    [360, 44],
  ] as const) {
    test(`web-credentials/AC-12: 入力欄とボタンの描画後の高さが${h}ピクセルになる（幅${width}）`, async ({ page }) => {
      await mockApi(page, { registered: false })
      await page.setViewportSize({ width, height: 700 })
      await page.goto("/")
      await page.locator("#cred-proton").click()
      const heights = await page.evaluate(() =>
        ["input[name=server]", "input[name=username]", "input[name=password]", "input[name=proton-token]", "#cred-submit"].map(s => Math.round(document.querySelector(s)!.getBoundingClientRect().height)),
      )
      expect(heights).toEqual([h, h, h, h, h])
    })
  }
})

test.describe("タッチ操作", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 900, height: 700 } })
  test("web-credentials/AC-13: タッチ操作の端末として開くと、すべての文字入力欄の文字が16ピクセル以上になる", async ({ page }) => {
    await mockApi(page, { registered: false })
    await page.goto("/")
    await page.locator("#cred-proton").click()
    const sizes = await page.evaluate(() => [...document.querySelectorAll(".cred input")].map(i => parseFloat(getComputedStyle(i).fontSize)))
    expect(sizes).toHaveLength(4)
    for (const s of sizes) expect(s).toBeGreaterThanOrEqual(16)
  })
})

test.describe("サーバ名の選択", () => {
  test("web-credentials/AC-14: サーバ名の欄に「s10」と入力すると、一覧が絞り込まれ、候補を選ぶと欄に入る", async ({ page }) => {
    await mockApi(page, { registered: false })
    await page.goto("/")
    const server = page.locator('input[name="server"]')
    await server.click()
    await expect(page.locator("#cred-server [role=option]")).toHaveCount(4)
    await server.fill("s10")
    await expect(page.locator("#cred-server [role=option]")).toHaveText(["s10.xrea.com", "s100.xrea.com"])
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Enter")
    await expect(server).toHaveValue("s10.xrea.com")
    await page.locator('input[name="username"]').fill("acct")
    await page.locator('input[name="password"]').fill("key")
    await expect(page.locator("#cred-submit")).toBeEnabled()
    await server.fill("s999")
    await expect(page.locator("#cred-submit")).toBeDisabled()
  })
})

test.describe("サーバ名の候補の高さ", () => {
  for (const [width, height] of [
    [900, 700],
    [360, 560],
  ] as const) {
    test(`web-credentials/AC-14: 候補が多くても候補リストが画面の縦幅に収まり、スクロールして末尾まで選べる（${width}x${height}）`, async ({ page }) => {
      const api = await mockApi(page, { registered: false })
      api.state.servers = Array.from({ length: 365 }, (_, i) => `s${i + 1}.xrea.com`)
      await page.setViewportSize({ width, height })
      await page.goto("/")
      await page.locator('input[name="server"]').click()
      const menu = page.locator("#cred-server .dd-menu")
      await expect(menu).toBeVisible()
      const m = await menu.evaluate(e => ({ h: e.getBoundingClientRect().height, sh: e.scrollHeight, bottom: e.getBoundingClientRect().bottom, vh: innerHeight, oy: getComputedStyle(e).overflowY }))
      expect(m.h).toBeLessThanOrEqual(m.vh)
      expect(m.bottom).toBeLessThanOrEqual(m.vh)
      expect(m.sh).toBeGreaterThan(m.h) // 内部でスクロールする
      expect(m.oy).toBe("auto")
      // キーボードで末尾へ移動しても、選択中の候補が見えている位置までスクロールする
      for (let i = 0; i < 60; i++) await page.keyboard.press("ArrowDown")
      expect(await menu.evaluate(e => e.scrollTop)).toBeGreaterThan(0)
      await page.locator("#cred-server .hi").scrollIntoViewIfNeeded()
      await page.keyboard.press("Enter")
      await expect(page.locator('input[name="server"]')).toHaveValue("s60.xrea.com")
    })
  }
})
