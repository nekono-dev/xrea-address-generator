import { defineConfig, devices } from "@playwright/test"

export default defineConfig({
  testDir: "tests/e2e",
  reporter: "list",
  // Service Worker の確認は PWA のテストだけで許可し、それ以外では登録させない（API の疑似応答を確実に効かせるため）
  use: { baseURL: "http://127.0.0.1:4173", ...devices["Desktop Chrome"], viewport: { width: 900, height: 700 }, serviceWorkers: "block" },
  // ビルドした画面を配信し、APIは各テストで疑似の応答に差し替える
  webServer: {
    command: "npm run build:web && npx vite preview --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
