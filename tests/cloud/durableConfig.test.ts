import fs from "node:fs"
import path from "node:path"
import ts from "typescript"
import { describe, expect, test } from "vitest"

const read = (f: string) => fs.readFileSync(path.join(__dirname, "../..", f), "utf8")
const parse = (f: string) => ts.parseConfigFileTextToJson(f, read(f)).config as any

describe("Durable Objectの配備の定義", () => {
  test("gateway-durable-object/AC-6: 配備の定義と雛形が、GATEWAY の束縛と、SQLite方式のクラスの移行を含む", () => {
    for (const f of ["wrangler.template.jsonc", "wrangler.jsonc"]) {
      if (!fs.existsSync(path.join(__dirname, "../..", f))) continue // 個人用の定義は無いことがある
      const w = parse(f)
      expect(w.durable_objects.bindings, f).toEqual([{ name: "GATEWAY", class_name: "GatewayTenant" }])
      expect(w.migrations, f).toEqual([{ tag: "v1", new_sqlite_classes: ["GatewayTenant"] }])
    }
    // Worker の入口がクラスを公開している
    expect(read("src/app/worker.ts")).toMatch(/export \{ GatewayTenant \} from/)
  })
})
