import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { Miniflare } from "miniflare"
import ts from "typescript"
import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { createReaderApp } from "../../src/reader/app"
import { CliError, type CliRunner } from "../../src/reader/cli"
import { Tenants } from "../../src/reader/tenants"
import { silentLogger } from "../../src/shared/logger"
import { vaultsJson } from "../reader/helpers"
import { bundleWorker } from "../app/workerBundle"
import { ENV, makeApp } from "../app/helpers"

const read = (f: string) =>
  fs.readFileSync(path.join(__dirname, "../..", f), "utf8")
// 配布用の雛形（wrangler.template.jsonc）を JSONC（コメント付きJSON）として読む。個人用の wrangler.jsonc は gitignore 済み
const wrangler = ts.parseConfigFileTextToJson(
  "wrangler.template.jsonc",
  read("wrangler.template.jsonc"),
).config as any

describe("配備の定義", () => {
  test("cloud-deploy/AC-1: 配備の定義が読み込め、スクリプトと画面ファイルの出力先が含まれる", () => {
    expect(wrangler.name).toBe("xrea-address-generator")
    expect(wrangler.main).toBe("dist/worker/index.js")
    expect(wrangler.preview_urls).toBe(false) // プレビューURLと workers.dev は無効で配備する
    expect(wrangler.workers_dev).toBe(false)
    expect(wrangler.assets).toMatchObject({
      directory: "dist/web",
      binding: "ASSETS",
      not_found_handling: "none",
    })
    expect(wrangler.assets.run_worker_first).toEqual(["/api/*", "/healthz"])
    // ビルドの npm スクリプトが、定義の出力先に書き出す
    const scripts = JSON.parse(read("package.json")).scripts
    expect(scripts["build:worker"]).toContain("--outfile=dist/worker/index.js")
    expect(read("vite.config.ts")).toContain('outDir: "../dist/web"')
  })

  test("cloud-deploy/AC-2: 変数と秘密の一覧が必要な設定をすべて含み、秘匿値の実値を含まない", () => {
    expect(Object.keys(wrangler.vars).sort()).toEqual([
      "CREDENTIAL_STORE",
      "PROTON_READER_URL",
      "XREA_GATEWAY_URL",
    ])
    expect(wrangler.vars.CREDENTIAL_STORE).toBe("cookie")
    const text = read("wrangler.template.jsonc")
    // 秘密は定義の外で設定する。名前は案内の注記にだけ現れ、値の代入はない
    expect(text).toMatch(/wrangler secret put/)
    expect(text).not.toMatch(/^\s*(COOKIE_SECRET|INTERNAL_TOKEN)\s*=/m)
    expect(wrangler.vars.XREA_GATEWAY_URL).toBe("")
    // 変数と秘密を合わせて、アプリの必須設定（URL・COOKIE_SECRET・INTERNAL_TOKEN）が揃う
    const provided = {
      ...wrangler.vars,
      XREA_GATEWAY_URL: "https://gw.example.net",
      COOKIE_SECRET: "c".repeat(32),
      INTERNAL_TOKEN: "i".repeat(32),
    }
    return import("../../src/app/config").then(({ loadAppConfig }) =>
      expect(() =>
        loadAppConfig(provided, { allowSqlite: false }),
      ).not.toThrow(),
    )
  })

  test("cloud-deploy/AC-7: 配備の手順書が手動の実行だけで構成され、リポジトリの定義と手順書に秘匿値の実値が含まれない", () => {
    expect(
      fs.existsSync(path.join(__dirname, "../../.github/workflows/deploy.yml")),
    ).toBe(false)
    const doc = read("docs/cloud-deploy.md")
    expect(doc).toContain("npx wrangler secret put COOKIE_SECRET")
    expect(doc).toContain("リポジトリ・チャット・シェルの履歴・ログに残さない")
    const all = [
      doc,
      read("wrangler.template.jsonc"),
      read(".env.example"),
    ].join("\n")
    expect(all).not.toMatch(/pst_[A-Za-z0-9]/) // Proton Pass のトークン
    expect(all).not.toMatch(/^(COOKIE_SECRET|INTERNAL_TOKEN)=.+/m)
    // 疎通確認の出力にも、渡した値が出ない
    return import("../../scripts/cloud/check").then(async ({ probe }) => {
      const fetchStub = (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch
      const out = JSON.stringify(
        await probe(
          {
            app: "https://a.example",
            gateway: "https://SECRETHOST-XYZ.example",
          },
          { fetch: fetchStub },
        ),
      )
      expect(out).not.toContain("SECRETHOST-XYZ")
    })
  })

  test("cloud-deploy/AC-9: ビルドした成果物の圧縮後のサイズが、1メガバイト以下である", async () => {
    expect(gzipSync(await bundleWorker()).length).toBeLessThanOrEqual(
      1024 * 1024,
    )
  }, 60_000)
})

describe("読み取りサービスを配備しない構成", () => {
  test("cloud-deploy/AC-4: 読み取りサービスのURLを空にした構成で、アプリが読み取りサービスを呼び出さずに一覧を返す", async () => {
    const { app, register, seen } = await makeApp({
      env: { PROTON_READER_URL: "" },
    })
    const res = await app.request("/api/aliases", {
      headers: { cookie: await register() },
    })
    expect(res.status).toBe(200)
    expect((await res.json()).proton.state).toBe("disabled")
    expect(seen.reader).toEqual([])
  })
})

describe("読み取りサービスを配備するとき", () => {
  test("cloud-deploy/AC-5: 共有シークレットなしの要求が401になり、一時領域のセッションを失っても再ログインで取得が再開する", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "reader-tmp-"))
    const items = JSON.stringify({
      items: [
        {
          state: "Active",
          content: {
            title: "Shop",
            content: {
              Login: { username: "a@example.com", email: "", password: "PW" },
            },
          },
        },
      ],
    })
    // セッション（保存先の .session）が無いときは失効として失敗し、login で作られる
    const makeRunner =
      (_t: string, dir: string): CliRunner =>
      async (args) => {
        const marker = path.join(dir, ".session")
        if (args[0] === "login") {
          fs.mkdirSync(dir, { recursive: true })
          fs.writeFileSync(marker, "x")
          return { stdout: "", durationMs: 1 }
        }
        if (!fs.existsSync(marker))
          throw new CliError("unknown", "セッションがありません", true)
        return {
          stdout:
            args[0] === "vault"
              ? vaultsJson(1)
              : args[0] === "info"
                ? ""
                : items,
          durationMs: 1,
        }
      }
    const tenants = new Tenants(20, base, { logger: silentLogger, makeRunner })
    const app = createReaderApp({
      tenants,
      internalToken: "i".repeat(32),
      logger: silentLogger,
    })
    const headers = {
      authorization: `Bearer ${"i".repeat(32)}`,
      "x-proton-token": "pat",
    }
    expect(
      (
        await app.request("/v1/entries", {
          headers: { "x-proton-token": "pat" },
        })
      ).status,
    ).toBe(401)
    const settle = () => new Promise((r) => setTimeout(r, 50))
    const entries = async () =>
      (await app.request("/v1/entries", { headers })).json() as Promise<any>
    await entries()
    await settle()
    expect((await entries()).status.state).toBe("ready")
    // 再作成でセッションの保存先が失われた状況
    fs.rmSync(base, { recursive: true, force: true })
    expect(
      (await app.request("/v1/refresh", { method: "POST", headers })).status,
    ).toBe(202)
    await settle()
    const after = await entries()
    expect(after.status.state).toBe("ready")
    expect(after.status.reloginAt).not.toBeNull()
    expect(after.entries).toEqual({ "a@example.com": ["Shop"] })
  })
})

describe("画面ファイルのキャッシュの指示", () => {
  let mf: Miniflare
  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assets-"))
    fs.writeFileSync(
      path.join(dir, "index.html"),
      "<!doctype html><title>入口</title>",
    )
    fs.writeFileSync(path.join(dir, "sw.js"), "//sw")
    fs.writeFileSync(path.join(dir, "manifest.webmanifest"), "{}")
    fs.mkdirSync(path.join(dir, "assets"))
    fs.writeFileSync(
      path.join(dir, "assets", "main-abc123.js"),
      "console.log(1)",
    )
    fs.copyFileSync(
      path.join(__dirname, "../../web/public/_headers"),
      path.join(dir, "_headers"),
    )
    mf = new Miniflare({
      workers: [
        {
          modules: true,
          script: await bundleWorker(),
          compatibilityDate: "2026-08-01",
          bindings: ENV,
          assets: {
            directory: dir,
            binding: "ASSETS",
            routerConfig: {
              has_user_worker: true,
              static_routing: { user_worker: wrangler.assets.run_worker_first },
            },
            assetConfig: {
              not_found_handling: wrangler.assets.not_found_handling,
            },
          },
        },
      ],
    })
    await mf.ready
  }, 60_000)
  afterAll(async () => {
    await mf?.dispose()
  })

  test("cloud-deploy/AC-8: 配備した画面ファイルの応答ヘッダが、版を含むファイルに1年のキャッシュを、入口に毎回の検証を指示する", async () => {
    const cc = async (p: string) =>
      (await mf.dispatchFetch(`http://app.test${p}`)).headers.get(
        "cache-control",
      )
    expect(await cc("/assets/main-abc123.js")).toBe(
      "public, max-age=31536000, immutable",
    )
    for (const p of ["/", "/index.html", "/sw.js", "/manifest.webmanifest"])
      expect(await cc(p), p).toBe("no-cache")
  }, 30_000)
})
