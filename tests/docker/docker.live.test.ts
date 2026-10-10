// 検証サーバでのイメージ・Compose・公開経路・再起動のテスト。DOCKER_LIVE=1 のときだけ実行する。
// Proton Pass のセッションの保持（AC-3）は、実際の読み取り専用トークンが環境変数にあるときに確認する。
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

const root = path.resolve(__dirname, "../..")
const DOCKER = process.env.DOCKER ?? "docker"
const PROJECT = "xagtest"
const TAG = "xrea-address-generator:local" // Compose と同じ名前で作り、Compose 側のビルドを省く
const sh = (cmd: string, opts: { allowFail?: boolean; env?: NodeJS.ProcessEnv } = {}): string => {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...opts.env } }).trim()
  } catch (e) {
    if (opts.allowFail) return `__FAILED__${(e as { stderr?: string }).stderr ?? ""}`
    throw e
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const live = process.env.DOCKER_LIVE === "1"

describe.runIf(live)("image", () => {
  beforeAll(() => {
    sh(`${DOCKER} build -q -t ${TAG} .`)
  }, 600_000)

  test("docker-deploy/AC-1: 作成したイメージでProton Pass CLIのバージョンが表示され、ハッシュが一致しないバイナリではビルドが失敗する", () => {
    expect(sh(`${DOCKER} run --rm --entrypoint pass-cli ${TAG} --version`)).toMatch(/^Proton Pass CLI \d+\.\d+\.\d+/)
    expect(sh(`${DOCKER} run --rm --entrypoint id ${TAG} -un`)).toBe("node")
    const bad = sh(`${DOCKER} build -q --build-arg PASS_CLI_SHA256=${"0".repeat(64)} -t xrea-address-generator:badhash .`, { allowFail: true })
    expect(bad.startsWith("__FAILED__")).toBe(true)
    expect(bad).toContain("FAILED") // sha256sum の不一致
  }, 600_000)

  test("docker-deploy/AC-7: 作成したイメージの展開後のサイズが、500メガバイト以下である", () => {
    const size = Number(sh(`${DOCKER} image inspect -f '{{.Size}}' ${TAG}`))
    console.log(`イメージのサイズ: ${Math.round(size / 1024 / 1024)}MB`)
    expect(size).toBeLessThanOrEqual(500 * 1024 * 1024)
  })
})

describe.runIf(live)("compose", () => {
  const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "xag-env-")), "app.env")
  const hasRealProton = !!process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN?.startsWith("pst_")
  const compose = (args: string, allowFail = false) => sh(`${DOCKER} compose -p ${PROJECT} ${args}`, { allowFail, env: { ENV_FILE: envFile, TUNNEL_TOKEN: process.env.TUNNEL_TOKEN ?? "dummy-token-for-test" } })
  const appId = () => compose("ps -q app")
  const health = () => sh(`${DOCKER} inspect -f '{{.State.Health.Status}}' ${appId()}`, { allowFail: true })
  async function waitHealthy(limitMs: number): Promise<number> {
    const start = Date.now()
    while (Date.now() - start < limitMs) {
      if (health() === "healthy") return Date.now() - start
      await sleep(250)
    }
    throw new Error(`死活確認が ${limitMs}ms 以内に成功しませんでした（${health()}）`)
  }
  const inApp = (js: string) => sh(`${DOCKER} exec ${appId()} node -e '${js}'`)
  const protonStatus = () => JSON.parse(inApp(`fetch("http://127.0.0.1:3000/api/proton/status").then(r=>r.text()).then(t=>console.log(t))`)) as { state: string; reloginAt: string | null }
  let startupMs = 0
  let listenBefore = new Set<string>()
  const listenSet = () => new Set(sh("ss -ltnH", { allowFail: true }).split("\n").map(l => l.trim().split(/\s+/)[3] ?? "").filter(Boolean))

  beforeAll(async () => {
    const v = (k: string, dummy: string) => `${k}=${process.env[k] ?? dummy}`
    fs.writeFileSync(
      envFile,
      [v("XREA_ACCOUNT", "dummy"), v("XREA_SERVER_NAME", "dummy"), v("XREA_API_SECRET_KEY", "dummy"), v("PROTON_PASS_PERSONAL_ACCESS_TOKEN", "dummy")].join("\n") + "\n",
      { mode: 0o600 },
    )
    compose("down -v", true)
    listenBefore = listenSet()
    sh(`${DOCKER} build -q -t ${TAG} .`)
    const t0 = Date.now()
    compose("up -d --no-build")
    await waitHealthy(60_000)
    startupMs = Date.now() - t0 // up の開始から死活確認の成功まで
  }, 900_000)

  afterAll(() => {
    compose("down -v", true)
    fs.rmSync(path.dirname(envFile), { recursive: true, force: true })
  }, 120_000)

  test("docker-deploy/AC-8: コンテナの起動から死活確認が成功するまでが、30秒以内である", () => {
    console.log(`起動から死活確認の成功まで: ${startupMs}ms`)
    expect(startupMs).toBeLessThanOrEqual(30_000)
  })

  test("docker-deploy/AC-2: Docker Composeの起動で、アプリとCloudflare Tunnelの2コンテナが稼働する", async () => {
    const services = compose("ps -a --format '{{.Service}}'").split("\n").sort()
    expect(services).toEqual(["app", "cloudflared"])
    expect(health()).toBe("healthy")
    // cloudflared は app の死活確認の成功後に起動される。実際のトンネルへの接続には有効なトークンが必要
    const started = sh(`${DOCKER} inspect -f '{{.State.StartedAt}}' ${compose("ps -a -q cloudflared")}`)
    expect(started).not.toBe("0001-01-01T00:00:00Z")
    if (process.env.TUNNEL_TOKEN) {
      await sleep(5000)
      expect(sh(`${DOCKER} inspect -f '{{.State.Status}}' ${compose("ps -q cloudflared")}`)).toBe("running")
    }
  })

  test("docker-deploy/AC-5: ホストからアプリのポートへ接続できず、トンネルと同じネットワークからは接続できる", () => {
    const fromHost = sh("curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz", { allowFail: true })
    expect(fromHost).not.toBe("200")
    const net = `${PROJECT}_default`
    const fromNetwork = sh(`${DOCKER} run --rm --network ${net} ${TAG} node -e 'fetch("http://app:3000/healthz").then(r=>r.text()).then(t=>console.log(t))'`)
    expect(JSON.parse(fromNetwork)).toEqual({ ok: true })
  }, 120_000)

  test("docker-deploy/AC-9: 稼働中のホストで、アプリに由来する待ち受けポートが0個である", () => {
    const published = sh(`${DOCKER} inspect -f '{{json .NetworkSettings.Ports}}' ${appId()}`)
    const ports = JSON.parse(published) as Record<string, unknown[] | null>
    expect(Object.values(ports).every(v => v === null || v.length === 0)).toBe(true)
    // 検証サーバには別の検証の待ち受けがあるため、Compose の起動前後で増えた待ち受けが無いことを確かめる
    const added = [...listenSet()].filter(a => !listenBefore.has(a))
    expect(added).toEqual([])
  })

  test.runIf(hasRealProton)("docker-deploy/AC-3: アプリのコンテナを作り直した後も、Proton Passのセッションが保持され、再ログインなしで取得できる", async () => {
    // 初回の取得（ログインを含む）の完了を待つ
    for (let i = 0; i < 120 && protonStatus().state !== "ready"; i++) await sleep(1000)
    expect(protonStatus().state).toBe("ready")
    compose("up -d --no-build --force-recreate app")
    await waitHealthy(60_000)
    for (let i = 0; i < 120 && protonStatus().state !== "ready"; i++) await sleep(1000)
    const s = protonStatus()
    expect(s.state).toBe("ready")
    expect(s.reloginAt).toBeNull()
    // 作り直した後のコンテナでは、ログインを実行していない
    const logs = sh(`${DOCKER} logs ${appId()} 2>&1`)
    expect(logs).not.toContain('"cmd":"login"')
    expect(logs).toContain('"cmd":"item list"')
  }, 600_000)

  test("docker-deploy/AC-6: アプリのプロセスを強制終了すると、自動で再起動して死活確認が成功する", async () => {
    const before = sh(`${DOCKER} inspect -f '{{.RestartCount}}' ${appId()}`)
    // コンテナ内からの PID 1 へのシグナルは無視されるため、ホスト側から実プロセスを強制終了する
    const hostPid = sh(`${DOCKER} inspect -f '{{.State.Pid}}' ${appId()}`)
    sh(`kill -9 ${hostPid} 2>/dev/null || sudo -n kill -9 ${hostPid}`)
    await sleep(2000)
    const ms = await waitHealthy(60_000)
    const after = sh(`${DOCKER} inspect -f '{{.RestartCount}}' ${appId()}`)
    console.log(`強制終了から死活確認の成功まで: ${ms + 2000}ms（再起動回数 ${before} → ${after}）`)
    expect(Number(after)).toBeGreaterThan(Number(before))
  }, 120_000)
})
