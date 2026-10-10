import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import YAML from "yaml"
import { REQUIRED_ENV } from "../../src/server/config"

const root = path.resolve(__dirname, "../..")
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8")
const COMMIT = "0123456789abcdef0123456789abcdef01234567"
const hasShellcheck = spawnSync("sh", ["-c", "command -v shellcheck"]).status === 0

describe("インストーラの生成", () => {
  test("生成スクリプトが参照名・コミット・取得元URLを埋め込み、構文の正しい install.sh を出す", () => {
    const out = execFileSync("sh", [path.join(root, "installer/build-bootstrap.sh"), "main", COMMIT, "https://github.com/nekono-dev/xrea-address-generator.git"], { encoding: "utf8" })
    expect(out).toContain("REF='main'")
    expect(out).toContain(`COMMIT='${COMMIT}'`)
    expect(out).toContain("REPO_URL='https://github.com/nekono-dev/xrea-address-generator.git'")
    expect(out).toContain("DIR=${XREA_ADDRESS_GENERATOR_DIR:-/opt/xrea-address-generator}")
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "inst-")), "install.sh")
    fs.writeFileSync(f, out)
    expect(spawnSync("sh", ["-n", f]).status).toBe(0)
  })

  test("不正なコミットの指定では、何も出力せずに失敗する", () => {
    const r = spawnSync("sh", [path.join(root, "installer/build-bootstrap.sh"), "main", "abc", "https://example.test/r.git"], { encoding: "utf8" })
    expect(r.status).toBe(1)
    expect(r.stdout).toBe("")
  })

  test("ひな形・本体・スキーマに置換漏れのプレースホルダが無く、本体の構文が正しい", () => {
    for (const f of ["installer/bootstrap.sh.tmpl", "installer/main.sh", "installer/config.schema", ".github/workflows/release-installer.yml"]) {
      expect(read(f)).not.toMatch(/(?<!\$)\{\{[A-Z_]+\}\}/)
    }
    expect(spawnSync("sh", ["-n", path.join(root, "installer/main.sh")]).status).toBe(0)
  })

  test.runIf(hasShellcheck)("shellcheck（警告以上）を通る", () => {
    const r = spawnSync("shellcheck", ["-S", "warning", "installer/main.sh", "installer/build-bootstrap.sh"], { cwd: root, encoding: "utf8" })
    expect(r.stdout + r.stderr).toBe("")
    expect(r.status).toBe(0)
  })

  test("設定スキーマの必須キーが、アプリの必須の環境変数と一致する", () => {
    const lines = read("installer/config.schema").split("\n").filter(l => l.trim() && !l.startsWith("#"))
    const rows = lines.map(l => l.split("|"))
    for (const r of rows) {
      expect(r).toHaveLength(4)
      expect(r[0]).toMatch(/^[A-Z][A-Z0-9_]*$/)
      expect(["required", "optional"]).toContain(r[2])
    }
    expect(rows.filter(r => r[2] === "required").map(r => r[0]).sort()).toEqual([...REQUIRED_ENV].sort())
    expect(rows.map(r => r[0])).toEqual(expect.arrayContaining(["TUNNEL_TOKEN", "BIND_ADDRESS", "PORT", "SESSION_DIR", "LOG_LEVEL"]))
  })
})

describe("CIによる配布物の生成", () => {
  const wf = YAML.parse(read(".github/workflows/release-installer.yml"))
  const steps = (job: string) => (wf.jobs[job].steps as { run?: string; uses?: string; name?: string }[]).map(s => `${s.uses ?? ""} ${s.run ?? ""}`).join("\n")

  test("lxc-installer/AC-14: ブランチのプッシュでPre-releaseと成果物が、タグのプッシュでReleaseが、それぞれ生成される", () => {
    expect(wf.on.push.branches).toEqual(["**"])
    expect(wf.on.push.tags).toEqual(["v*"])
    expect(wf.on).toHaveProperty("workflow_dispatch")
    // 生成と成果物の保存（全トリガー共通）
    expect(steps("build")).toContain('sh installer/build-bootstrap.sh "$REF_NAME" "$COMMIT" "$REPO_URL" > installer-dist/install.sh')
    expect(steps("build")).toContain("sha256sum install.sh > install.sh.sha256")
    expect(steps("build")).toContain("actions/upload-artifact")
    // タグは Release、ブランチは Pre-release を作り直す
    expect(wf.jobs["release-tag"].if).toBe("startsWith(github.ref, 'refs/tags/v')")
    expect(steps("release-tag")).toContain("gh release upload")
    expect(wf.jobs["release-branch"].if).toBe("startsWith(github.ref, 'refs/heads/')")
    expect(steps("release-branch")).toContain("gh release delete")
    expect(steps("release-branch")).toContain("--prerelease")
  })

  test("プロジェクト固有の検査（仕様書・型・単体テスト・ビルド・画面のブラウザテスト）を、生成の前に実行する", () => {
    const s = steps("build")
    for (const cmd of ["npm run lint:spec", "npm run typecheck", "npm test", "npm run build", "npx playwright test", "shellcheck -S warning installer/*.sh"]) expect(s).toContain(cmd)
    expect(s.indexOf("npm test")).toBeLessThan(s.indexOf("build-bootstrap.sh"))
  })
})
