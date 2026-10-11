import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { loadAppConfig } from "../../src/app/config"

const root = path.resolve(__dirname, "../..")
const read = (f: string) => fs.readFileSync(path.join(root, f), "utf8")
const keys = (text: string) => text.split("\n").filter(l => /^[A-Z_]+=/.test(l)).map(l => l.split("=")[0])
const hasCompose = spawnSync("docker", ["compose", "version"]).status === 0

/** 環境変数ファイルを指定して docker compose config を実行する（デーモンには接続しない） */
function composeConfig(vars: Record<string, string>, files = ["compose.yaml"]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xag-cfg-"))
  const env = path.join(dir, "test.env")
  fs.writeFileSync(env, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n")
  const args = ["compose", "--env-file", env, ...files.flatMap(f => ["-f", f]), "config", "--format", "json"]
  const r = spawnSync("docker", args, { cwd: root, encoding: "utf8" })
  return { ok: r.status === 0, stderr: r.stderr, json: r.status === 0 ? JSON.parse(r.stdout) : null }
}
const SECRETS = { COOKIE_SECRET: "a".repeat(40), INTERNAL_TOKEN: "b".repeat(40) }

describe("環境変数の記入例", () => {
  test("docker-deploy/AC-5: 記入例が必須の環境変数をすべて含み、任意の環境変数も空の値で並ぶ", () => {
    const example = read(".env.example")
    const names = keys(example)
    for (const k of ["COOKIE_SECRET"]) expect(names).toContain(k)
    for (const k of ["INTERNAL_TOKEN", "CREDENTIAL_STORE", "COMPOSE_PROFILES", "PROTON_READER_URL", "TUNNEL_TOKEN", "LOG_LEVEL", "APP_PORT", "XREA_SERVERS_CONFIG"]) expect(example).toMatch(new RegExp(`^${k}=$`, "m"))
    // 旧方式の変数を残さない
    for (const k of ["XREA_ACCOUNT", "XREA_API_SECRET_KEY", "PROTON_PASS_PERSONAL_ACCESS_TOKEN", "XREA_GATEWAY_URL"]) expect(names).not.toContain(k)
  })

  test("記入例に秘匿値を書き込まず、実際の値を入れたファイルをイメージとリポジトリに含めない", () => {
    const example = read(".env.example")
    for (const k of ["COOKIE_SECRET", "INTERNAL_TOKEN", "TUNNEL_TOKEN"]) expect(example).toMatch(new RegExp(`^${k}=$`, "m"))
    expect(read(".dockerignore").split("\n")).toContain(".env")
    expect(read(".gitignore").split("\n")).toContain(".env")
  })
})

describe("Composeの定義", () => {
  test("docker-deploy/AC-6: compose.yaml のどのサービスもホストへポートを公開しない", () => {
    expect(read("compose.yaml")).not.toMatch(/^\s*ports:/m)
    if (!hasCompose) return
    const c = composeConfig(SECRETS)
    expect(c.ok, c.stderr).toBe(true)
    for (const s of Object.values<any>(c.json.services)) expect(s.ports ?? []).toEqual([])
  })

  test("docker-deploy/AC-3: TUNNEL_TOKEN が空ならトンネルのコンテナの数が0になり、あれば1になる", () => {
    expect(read("compose.yaml")).toMatch(/replicas: 0\$\{TUNNEL_TOKEN:\+1\}/)
    if (!hasCompose) return
    expect(composeConfig(SECRETS).json.services.cloudflared.deploy.replicas).toBe(0)
    expect(composeConfig({ ...SECRETS, TUNNEL_TOKEN: "tok" }).json.services.cloudflared.deploy.replicas).toBe(1)
  })

  test("docker-deploy/AC-2: 読み取りサービスは proton のプロファイルを選んだときだけ起動する", () => {
    expect(read("compose.yaml")).toMatch(/proton-reader:[\s\S]*?profiles: \[proton\]/)
    if (!hasCompose) return
    expect(Object.keys(composeConfig(SECRETS).json.services).sort()).toEqual(["app", "cloudflared"])
    expect(Object.keys(composeConfig({ ...SECRETS, COMPOSE_PROFILES: "proton" }).json.services).sort()).toEqual(["app", "cloudflared", "proton-reader"])
  })

  test("docker-deploy/AC-10: 秘密値が空のときComposeの起動が変数名を示して失敗し、読み取りサービスを選んで共有シークレットが空のときアプリが変数名を示して失敗する", () => {
    expect(read("compose.yaml")).toMatch(/\$\{COOKIE_SECRET:\?[^}]+\}/)
    // 共有シークレットは読み取りサービスを使うときだけ必須で、不足はアプリの設定の読み込みが拒否する
    expect(() => loadAppConfig({ COOKIE_SECRET: "a".repeat(40), PROTON_READER_URL: "http://proton-reader:8082" })).toThrow("INTERNAL_TOKEN")
    expect(() => loadAppConfig({ COOKIE_SECRET: "a".repeat(40) })).not.toThrow()
    if (!hasCompose) return
    const a = composeConfig({ ...SECRETS, COOKIE_SECRET: "" })
    expect(a.ok).toBe(false)
    expect(a.stderr).toContain("COOKIE_SECRET")
  })

  test("docker-deploy/AC-9: LAN用の追加定義がアプリのポートだけを公開し、cookieの Secure を外す", () => {
    const lan = read("compose.lan.yaml")
    expect(lan).toMatch(/^\s+ports:\n\s+- \$\{APP_PORT:-3000\}:3000$/m)
    expect(lan).not.toMatch(/proton-reader|cloudflared/)
    if (!hasCompose) return
    const c = composeConfig(SECRETS, ["compose.yaml", "compose.lan.yaml"])
    expect(c.ok, c.stderr).toBe(true)
    const published = Object.entries<any>(c.json.services).filter(([, s]) => (s.ports ?? []).length > 0)
    expect(published.map(([n, s]) => [n, s.ports.map((p: any) => String(p.published))])).toEqual([["app", ["3000"]]])
    expect(c.json.services.app.environment.COOKIE_SECURE).toBe("0")
  })

  test("docker-deploy/AC-12: 環境変数ファイルにSecure属性を外す指定があっても、トンネルを使う構成のアプリは Secure を固定する", () => {
    if (!hasCompose) return expect(read("compose.yaml")).toMatch(/COOKIE_SECURE: "1"/)
    const c = composeConfig({ ...SECRETS, COOKIE_SECURE: "0", TUNNEL_TOKEN: "tok" })
    expect(c.json.services.app.environment.COOKIE_SECURE).toBe("1")
  })

  test("docker-deploy/AC-11: アプリと読み取りサービスに、読み取り専用のルート・権限の放棄・一時領域を設定する", () => {
    if (!hasCompose) return
    const c = composeConfig({ ...SECRETS, COMPOSE_PROFILES: "proton" })
    for (const name of ["app", "proton-reader"]) {
      const s = c.json.services[name]
      expect(s.read_only, name).toBe(true)
      expect(s.cap_drop, name).toEqual(["ALL"])
      expect(s.security_opt, name).toContain("no-new-privileges:true")
      expect(s.tmpfs, name).toEqual(["/tmp"])
    }
  })

  test("docker-deploy/AC-8: 各サービスに死活確認と自動再起動が設定される", () => {
    if (!hasCompose) return
    const c = composeConfig({ ...SECRETS, COMPOSE_PROFILES: "proton" })
    for (const name of ["app", "proton-reader"]) {
      const s = c.json.services[name]
      expect(s.restart, name).toBe("unless-stopped")
      expect(s.healthcheck.retries, name).toBe(3)
      expect(s.healthcheck.test.join(" "), name).toContain("/healthz")
    }
  })

  test("読み取りサービスには、アプリの秘密値を渡さない", () => {
    if (!hasCompose) return
    const c = composeConfig({ ...SECRETS, COMPOSE_PROFILES: "proton" })
    expect(Object.keys(c.json.services["proton-reader"].environment)).not.toContain("COOKIE_SECRET")
    expect(execFileSync("git", ["check-ignore", ".env"], { cwd: root, encoding: "utf8" }).trim()).toBe(".env")
  })
})
