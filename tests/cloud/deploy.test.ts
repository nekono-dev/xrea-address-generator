import { describe, expect, test } from "vitest"
import {
  deploy,
  loadConfig,
  type Call,
  type DeployConfig,
  type Result,
  type Runner,
} from "../../scripts/cloud/deploy"

const base: DeployConfig = {
  projectId: "proj",
  region: "asia-northeast1",
  tag: "v1",
  repo: "xrea",
  secret: "xrea-internal-token",
  reader: true,
  dryRun: false,
  wranglerConfig: "wrangler.jsonc",
}

/** 呼び出しを記録する偽の実行環境。exists が真のコマンド（先頭の語の並び）は、読み取りが成功する */
function fake(existing: string[] = [], workerSecrets: string[] = []) {
  const calls: (Call & { kind: "query" | "exec" })[] = []
  const key = (c: Call) => [c.cmd, ...c.args].join(" ")
  const answer = (c: Call): Result => {
    const k = key(c)
    if (k.includes("projects describe")) return { code: 0, stdout: "123\n" }
    if (k.includes("secret list"))
      return {
        code: 0,
        stdout: JSON.stringify(workerSecrets.map((name) => ({ name }))),
      }
    if (k.includes("secrets versions access"))
      return { code: 0, stdout: "TOKEN-FROM-SECRET-MANAGER" }
    if (k.includes("--format=value(status.url)"))
      return { code: 0, stdout: `https://${c.args[3]}.run.app\n` }
    if (/describe/.test(k))
      return { code: existing.some((e) => k.includes(e)) ? 0 : 1, stdout: "" }
    return { code: 0, stdout: "" }
  }
  const runner: Runner = {
    query: (c) => (calls.push({ ...c, kind: "query" }), answer(c)),
    exec: (c) => (calls.push({ ...c, kind: "exec" }), answer(c)),
    log: () => {},
  }
  const execs = () => calls.filter((c) => c.kind === "exec").map(key)
  const idx = (needle: string) => execs().findIndex((k) => k.includes(needle))
  return { runner, calls, execs, idx }
}

describe("クラウドの一括配備", () => {
  test("cloud-deploy/AC-15: 初回は削除を行わず、読み取りサービスのコンテナ → Workers の順に配備する", () => {
    const f = fake()
    const urls = deploy(base, f.runner)
    expect(
      f
        .execs()
        .some(
          (k) => k.includes("services delete") || k.includes("images delete"),
        ),
    ).toBe(false)
    expect(urls).toEqual({ reader: "https://proton-reader.run.app" })
    // ゲートウェイは Workers に内蔵されるため、コンテナを作らない
    expect(f.execs().some((k) => k.includes("xrea-gateway") || k.includes("--target app"))).toBe(false)
    const order = [
      "--target reader",
      "run deploy proton-reader",
      "wrangler deploy",
    ].map(f.idx)
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    const wd = f.execs()[f.idx("wrangler deploy")] ?? ""
    expect(wd).not.toContain("XREA_GATEWAY_URL")
    expect(wd).toContain(
      "--var PROTON_READER_URL:https://proton-reader.run.app",
    )
  })

  test("cloud-deploy/AC-15: 再実行では、同じタグのままサービス → イメージの順に削除してから push とデプロイを行う", () => {
    const f = fake([
      "services describe proton-reader",
      "images describe asia-northeast1-docker.pkg.dev/proj/xrea/reader:v1",
    ])
    deploy(base, f.runner)
    const order = [
      "--target reader",
      "services delete proton-reader",
      "images delete asia-northeast1-docker.pkg.dev/proj/xrea/reader:v1",
      "docker push",
      "run deploy proton-reader",
    ].map(f.idx)
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // タグは変えない
    expect(f.execs().some((k) => k.includes(":v2"))).toBe(false)
    expect(
      f
        .execs()
        .filter(
          (k) => k.includes("images delete") && k.includes("--delete-tags"),
        ),
    ).toHaveLength(1)
  })

  test("cloud-deploy/AC-15: --no-reader では読み取りサービスを配備せず、Google Cloud に触れずに URL を空にして Workers を配備する", () => {
    const f = fake()
    expect(deploy({ ...base, reader: false, projectId: "" }, f.runner).reader).toBeUndefined()
    expect(f.calls.some((c) => c.cmd === "gcloud" || c.cmd === "docker")).toBe(false)
    expect(f.execs().some((k) => k.includes("secret put INTERNAL_TOKEN"))).toBe(false)
    expect(f.execs()[f.idx("wrangler deploy")]).toContain(
      "--var PROTON_READER_URL:",
    )
  })

  test("cloud-deploy/AC-16: COOKIE_SECRET は設定済みなら変更せず、共有シークレットは作成済みなら作り直さない", () => {
    const f = fake(["secrets describe xrea-internal-token"], ["COOKIE_SECRET"])
    deploy(base, f.runner)
    expect(f.execs().some((k) => k.includes("secrets create"))).toBe(false)
    expect(f.execs().some((k) => k.includes("secret put COOKIE_SECRET"))).toBe(
      false,
    )
    expect(f.execs().some((k) => k.includes("secret put INTERNAL_TOKEN"))).toBe(
      true,
    )

    const g = fake()
    deploy(base, g.runner)
    expect(g.execs().some((k) => k.includes("secrets create"))).toBe(true)
    expect(g.execs().some((k) => k.includes("secret put COOKIE_SECRET"))).toBe(
      true,
    )
  })

  test("cloud-deploy/AC-16: 秘匿値はコマンドの引数に現れず、標準入力だけで渡される", () => {
    const f = fake()
    deploy(base, f.runner)
    for (const c of f.calls)
      for (const a of c.args) expect(a).not.toMatch(/[A-Za-z0-9+/=]{32,}/)
    const puts = f.calls.filter(
      (c) =>
        c.args.includes("put") ||
        (c.args.includes("create") && c.args.includes("secrets")),
    )
    expect(puts.length).toBeGreaterThanOrEqual(3)
    for (const c of puts.filter(
      (c) => c.cmd === "gcloud" || c.args.includes("put"),
    ))
      expect(c.input).toBeTruthy()
    expect(
      f.calls.find(
        (c) => c.args.includes("INTERNAL_TOKEN") && c.args.includes("put"),
      )?.input,
    ).toBe("TOKEN-FROM-SECRET-MANAGER")
  })

  test("cloud-deploy/AC-15: 設定は環境変数と引数から決まり、必須の値が無ければ失敗する", () => {
    const env = { PROJECT_ID: "p", CLOUDFLARE_ACCOUNT_ID: "a" }
    expect(loadConfig(env, [], () => false)).toMatchObject({
      region: "asia-northeast1",
      tag: "v1",
      reader: true,
      dryRun: false,
      wranglerConfig: "wrangler.template.jsonc",
    })
    expect(
      loadConfig(
        { ...env, REGION: "us-central1", IMAGE_TAG: "v9" },
        ["--no-reader", "--dry-run"],
        () => true,
      ),
    ).toMatchObject({
      region: "us-central1",
      tag: "v9",
      reader: false,
      dryRun: true,
      wranglerConfig: "wrangler.jsonc",
    })
    expect(() => loadConfig({ CLOUDFLARE_ACCOUNT_ID: "a" }, [])).toThrow(
      "PROJECT_ID",
    )
    // 読み取りサービスを配備しないときは PROJECT_ID が要らない
    expect(loadConfig({ CLOUDFLARE_ACCOUNT_ID: "a" }, ["--no-reader"])).toMatchObject({ reader: false, projectId: "" })
    expect(() => loadConfig({ PROJECT_ID: "p" }, [])).toThrow(
      "CLOUDFLARE_ACCOUNT_ID",
    )
    expect(() => loadConfig(env, ["--bogus"])).toThrow("--bogus")
  })
})
