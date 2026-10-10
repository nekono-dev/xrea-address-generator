import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { REQUIRED_ENV } from "../../src/server/config"

const root = path.resolve(__dirname, "../..")
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8")
const keys = (text: string) => text.split("\n").filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split("=")[0])

describe("環境変数の記入例", () => {
  test("docker-deploy/AC-4: 記入例が必須の環境変数を3個すべてと、任意の環境変数を含む", () => {
    const example = keys(read(".env.example"))
    expect(REQUIRED_ENV).toHaveLength(3)
    for (const k of [...REQUIRED_ENV, "PROTON_PASS_PERSONAL_ACCESS_TOKEN", "TUNNEL_TOKEN"]) expect(example).toContain(k)
    expect(example).not.toContain("PROTON_PASS_VAULT_NAME")
  })

  test("記入例に秘匿値を書き込まず、実際の値を入れたファイルをイメージとリポジトリに含めない", () => {
    const example = read(".env.example")
    for (const k of ["XREA_API_SECRET_KEY", "PROTON_PASS_PERSONAL_ACCESS_TOKEN", "TUNNEL_TOKEN"]) expect(example).toMatch(new RegExp(`^${k}=$`, "m"))
    expect(read(".dockerignore").split("\n")).toContain(".env")
    expect(read(".gitignore").split("\n")).toContain(".env")
  })

  test("Composeはホストへポートを公開せず、永続ボリュームはセッションの保存先1つだけ", () => {
    const compose = read("compose.yaml")
    expect(compose).not.toMatch(/^\s*ports:/m)
    expect(compose.match(/^\s+- [\w-]+:\/var\/lib\/xrea-address-generator\/session$/gm)).toHaveLength(1)
  })

  test("docker-deploy/AC-10: TUNNEL_TOKEN が空ならトンネルのコンテナを起動せず、LAN用の定義でアプリのポートを公開する", () => {
    const compose = read("compose.yaml")
    expect(compose).toMatch(/replicas: 0\$\{TUNNEL_TOKEN:\+1\}/)
    const lan = read("compose.lan.yaml")
    expect(lan).toMatch(/^\s+ports:\n\s+- 3000:3000$/m)
    expect(lan).not.toMatch(/cloudflared/)
  })
})
