import { describe, expect, test } from "vitest"
import type { Call, Result, Runner } from "../../scripts/cloud/deploy"
import {
  destroy,
  loadDestroyConfig,
  type DestroyConfig,
} from "../../scripts/cloud/destroy"

const base: DestroyConfig = {
  projectId: "proj",
  region: "asia-northeast1",
  repo: "xrea",
  wranglerConfig: "wrangler.jsonc",
  dryRun: false,
  yes: true,
}

/** existing に含まれる語を持つ describe / list だけが成功する偽の実行環境 */
function fake(existing: string[]) {
  const execs: string[] = []
  const key = (c: Call) => [c.cmd, ...c.args].join(" ")
  const query = (c: Call): Result => ({
    code: existing.some((e) => key(c).includes(e)) ? 0 : 1,
    stdout: "",
  })
  const runner: Runner = {
    query,
    exec: (c) => (execs.push(key(c)), { code: 0, stdout: "" }),
    log: () => {},
  }
  return { runner, execs }
}

describe("クラウドの一括撤去", () => {
  test("cloud-deploy/AC-18: すべてが存在するとき、Workers → サービス → リポジトリ → シークレットの順に削除する", () => {
    const f = fake([
      "deployments list",
      "services describe",
      "repositories describe",
      "secrets describe",
    ])
    destroy(base, f.runner)
    const order = [
      "wrangler delete",
      "services delete xrea-gateway",
      "services delete proton-reader",
      "repositories delete xrea",
      "secrets delete xrea-internal-token",
      "secrets delete xrea-cookie-secret",
    ].map((n) => f.execs.findIndex((k) => k.includes(n)))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test("cloud-deploy/AC-18: 何も残っていなければ削除を行わず、成功する", () => {
    const f = fake([])
    destroy(base, f.runner)
    expect(f.execs).toEqual([])
  })

  test("cloud-deploy/AC-18: 一部だけ存在するときは、存在するものだけを削除する", () => {
    const f = fake(["services describe proton-reader"])
    destroy(base, f.runner)
    expect(f.execs).toHaveLength(1)
    expect(f.execs[0]).toContain("services delete proton-reader")
  })

  test("cloud-deploy/AC-18: 設定は必須の環境変数と既知の引数だけを受け付ける", () => {
    const env = { PROJECT_ID: "p", CLOUDFLARE_ACCOUNT_ID: "a" }
    expect(loadDestroyConfig(env, ["--yes"], () => false)).toMatchObject({
      yes: true,
      dryRun: false,
      wranglerConfig: "wrangler.template.jsonc",
    })
    expect(() => loadDestroyConfig({ CLOUDFLARE_ACCOUNT_ID: "a" }, [])).toThrow(
      "PROJECT_ID",
    )
    expect(() => loadDestroyConfig(env, ["--force"])).toThrow("--force")
  })
})
