import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const doc = readFileSync("docs/cloud-deploy.md", "utf8")
const mermaid = [...doc.matchAll(/```mermaid\n([\s\S]*?)```/g)].map(
  (m) => m[1] ?? "",
)
const shell = [...doc.matchAll(/```sh\n([\s\S]*?)```/g)]
  .map((m) => m[1] ?? "")
  .join("\n")

describe("クラウド配備の手順書", () => {
  test("cloud-deploy/AC-12: 構成図に4つの構成要素があり、配備の順序の図がある", () => {
    expect(mermaid.length).toBeGreaterThanOrEqual(2)
    const flow = mermaid.find((m) => m.startsWith("flowchart")) ?? ""
    for (const name of [
      "app",
      "Durable Object",
      "proton-reader",
      "XREA API",
      "Proton Pass",
    ])
      expect(flow).toContain(name)
    const seq = mermaid.find((m) => m.startsWith("sequenceDiagram")) ?? ""
    const order = [
      "proton-reader をデプロイ",
      "wrangler.jsonc",
      "疎通確認",
    ].map((s) => seq.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test("cloud-deploy/AC-13: Cloud Run の手順は最大1と Secret Manager を使い、実値と PORT の指定を含まない", () => {
    const deploys = shell.split("gcloud run deploy").slice(1)
    expect(deploys.length).toBe(1)
    for (const d of deploys)
      expect(d.split("\n\n")[0]).toContain("--max-instances 1")
    expect(shell).toContain(
      "--set-secrets INTERNAL_TOKEN=xrea-internal-token:latest",
    )
    expect(shell).toContain("--data-file=-")
    expect(shell).not.toMatch(/--set-env-vars[^\n]*PORT/)
    expect(shell).not.toMatch(/INTERNAL_TOKEN=[A-Za-z0-9+/]{32,}/)
    expect(shell).not.toMatch(
      /(COOKIE_SECRET|INTERNAL_TOKEN)=["']?[A-Za-z0-9+/=]{32,}/,
    )
  })
})

describe("配備の手順書の構成", () => {
  test("cloud-deploy/AC-17: 事前準備 → クイックスタート → 手動の手順の順で、クイックスタートは個別のデプロイを含まない", () => {
    const heads = [
      "## 事前準備",
      "## クイックスタート",
      "## 配備手順",
      "## 配備後の作業",
    ].map((h) => doc.indexOf(h))
    expect(heads.every((i) => i >= 0)).toBe(true)
    expect([...heads].sort((a, b) => a - b)).toEqual(heads)
    const quick = doc.slice(heads[1], heads[2])
    expect(quick).toContain("npm run deploy:cloud")
    expect(quick).not.toContain("gcloud run deploy")
    expect(doc.slice(heads[2], heads[3])).toContain("gcloud run deploy")
    expect(quick).not.toMatch(
      /(COOKIE_SECRET|INTERNAL_TOKEN)=["']?[A-Za-z0-9+/=]{32,}/,
    )
  })
})

describe("クラウドの運用の手順書", () => {
  const ops = readFileSync("docs/cloud-operations.md", "utf8")

  test("cloud-deploy/AC-14: cookie方式の固定・秘密値の更新・全利用者の失効・最大インスタンス数1の理由を含む", () => {
    expect(ops).toContain("cookie 方式に固定")
    expect(ops).toContain("CREDENTIAL_STORE=cookie")
    // 更新は、直前の秘密値の設定 → 現行の差し替え → 削除の順
    const prev = ops.indexOf("wrangler secret put COOKIE_SECRET_PREVIOUS")
    const order = [
      prev,
      ops.indexOf("wrangler secret put COOKIE_SECRET\n", prev),
      ops.indexOf("wrangler secret delete COOKIE_SECRET_PREVIOUS", prev),
    ]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(ops).toContain("## 4. 全利用者の失効")
    expect(ops).toContain("直前の秘密値を設定せずに")
    expect(ops).toMatch(/proton-reader[^\n]*\| 1 /)
    expect(ops).toContain("--max-instances 1")
    expect(ops).not.toMatch(
      /(COOKIE_SECRET|INTERNAL_TOKEN)=["']?[A-Za-z0-9+/=]{32,}/,
    )
  })
})
