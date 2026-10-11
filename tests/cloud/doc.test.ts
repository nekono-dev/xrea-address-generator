import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"

const doc = readFileSync("docs/cloud-deploy.md", "utf8")
const mermaid = [...doc.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1] ?? "")
const shell = [...doc.matchAll(/```sh\n([\s\S]*?)```/g)]
  .map((m) => m[1] ?? "")
  .join("\n")

describe("クラウド配備の手順書", () => {
  test("cloud-deploy/AC-12: 構成図に4つの構成要素があり、配備の順序の図がある", () => {
    expect(mermaid.length).toBeGreaterThanOrEqual(2)
    const flow = mermaid.find((m) => m.startsWith("flowchart")) ?? ""
    for (const name of [
      "app",
      "xrea-gateway",
      "proton-reader",
      "XREA API",
      "Proton Pass",
    ])
      expect(flow).toContain(name)
    const seq = mermaid.find((m) => m.startsWith("sequenceDiagram")) ?? ""
    const order = [
      "xrea-gateway をデプロイ",
      "proton-reader をデプロイ",
      "wrangler.toml",
      "疎通確認",
    ].map((s) => seq.indexOf(s))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  test("cloud-deploy/AC-13: Cloud Run の手順は最大1と Secret Manager を使い、実値と PORT の指定を含まない", () => {
    const deploys = shell.split("gcloud run deploy").slice(1)
    expect(deploys.length).toBe(2)
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
