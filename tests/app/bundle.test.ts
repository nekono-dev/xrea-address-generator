import { gzipSync } from "node:zlib"
import { expect, test } from "vitest"
import { bundleWorker } from "./workerBundle"

test("alias-service/AC-16: Workers向けのビルド成果物の圧縮後のサイズが、1メガバイト以下である", async () => {
  const code = await bundleWorker()
  const size = gzipSync(code).length
  expect(size).toBeLessThanOrEqual(1024 * 1024)
  expect(code).not.toMatch(/from\s*"node:|require\("node:/) // node: の組み込みモジュールを含めない
}, 60_000)
