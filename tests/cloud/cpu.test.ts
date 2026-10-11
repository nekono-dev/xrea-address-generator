import { expect, test } from "vitest"
import { makeApp } from "../app/helpers"

test("cloud-deploy/AC-10: 一覧の要求の処理で、入出力の待ちを除いたCPU時間が10ミリ秒以内である", async () => {
  const { app, register } = await makeApp()
  const headers = { cookie: await register() }
  for (let i = 0; i < 20; i++) await app.request("/api/aliases", { headers }) // 準備運転（JITとキャッシュ）
  const N = 100
  const before = process.cpuUsage()
  for (let i = 0; i < N; i++) await app.request("/api/aliases", { headers })
  const used = process.cpuUsage(before)
  const perRequestMs = (used.user + used.system) / 1000 / N
  console.log(`一覧の要求1件あたりのCPU時間: ${perRequestMs.toFixed(2)}ms`)
  expect(perRequestMs).toBeLessThanOrEqual(10)
})
