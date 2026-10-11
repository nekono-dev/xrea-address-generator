// 配備した実環境に対するブラウザテスト。LIVE_APP_URL に対象のURLを指定する（画面はビルド・配信しない）。
import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "live.spec.ts",
  reporter: "list",
  use: { ...devices["Desktop Chrome"], viewport: { width: 900, height: 700 }, serviceWorkers: "block" },
})
