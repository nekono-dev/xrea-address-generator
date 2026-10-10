import { defineConfig } from "vitest/config"

// 実機（実API・Docker・LXD）を使うテストは、いずれかの *_LIVE=1 のときだけ対象にする。
// 各テストファイルは、自分に対応する変数で実行の可否を判定する
const live = ["XREA_LIVE", "DOCKER_LIVE", "LXD_LIVE"].some(k => process.env[k] === "1")

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: live ? ["**/node_modules/**"] : ["tests/**/*.live.test.ts", "**/node_modules/**"],
  },
})
