// 検証サーバでのイメージ・Compose・公開経路・再起動・権限のテスト。DOCKER_LIVE=1 のときだけ実行する。
// 実際のXREA認証情報（XREA_ACCOUNT・XREA_SERVER_NAME・XREA_API_SECRET_KEY）があるときは登録まで、
// 実際のProton Passトークン（PROTON_PASS_PERSONAL_ACCESS_TOKEN）があるときはセッションの保持まで確認する。
import { execSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, test } from "vitest"

const root = path.resolve(__dirname, "../..")
const DOCKER = process.env.DOCKER ?? "docker"
const PROJECT = "xagtest"
const live = process.env.DOCKER_LIVE === "1"
const sh = (cmd: string, opts: { allowFail?: boolean } = {}): string => {
  try {
    return execSync(cmd, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  } catch (e) {
    if (opts.allowFail) return `__FAILED__${(e as { stderr?: string }).stderr ?? ""}`
    throw e
  }
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const x = process.env
const hasXrea = !!(x.XREA_ACCOUNT && x.XREA_SERVER_NAME && x.XREA_API_SECRET_KEY)
const hasProton = !!x.PROTON_PASS_PERSONAL_ACCESS_TOKEN?.startsWith("pst_")
const LAN_PORT = Number(x.LAN_TEST_PORT ?? 3000) // 検証サーバで3000番が別の用途に使われているときは LAN_TEST_PORT で変える
const SECRET = "s".repeat(40)
const TOKEN = "t".repeat(40)

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xag-env-"))
const envFile = path.join(tmpDir, "test.env")
const writeEnv = (extra: Record<string, string> = {}) =>
  fs.writeFileSync(
    envFile,
    Object.entries({ COOKIE_SECRET: SECRET, INTERNAL_TOKEN: TOKEN, TUNNEL_TOKEN: x.TUNNEL_TOKEN ?? "dummy-token-for-test", COOKIE_SECURE: "0", ...extra })
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  )
const compose = (args: string, files = "-f compose.yaml", allowFail = false) => sh(`${DOCKER} compose -p ${PROJECT} --env-file ${envFile} ${files} ${args}`, { allowFail })
const cid = (service: string) => compose(`ps -q ${service}`)
const health = (service: string) => sh(`${DOCKER} inspect -f '{{.State.Health.Status}}' ${cid(service)}`, { allowFail: true })
async function waitHealthy(services: string[], limitMs: number): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < limitMs) {
    if (services.every(s => health(s) === "healthy")) return Date.now() - start
    await sleep(250)
  }
  throw new Error(`死活確認が ${limitMs}ms 以内に成功しませんでした（${services.map(s => `${s}:${health(s)}`).join(" ")}）`)
}
/** アプリのコンテナの中から、アプリ自身へHTTP要求を送る（ホストへ公開していない構成でも使える） */
const inApp = (js: string) => sh(`${DOCKER} exec ${cid("app")} node -e '${js}'`)
const registerJs = (secureHeaderOut: boolean) =>
  `fetch("http://127.0.0.1:3000/api/credentials",{method:"PUT",headers:{"content-type":"application/json"},body:JSON.stringify({xrea:{account:process.env.A,serverName:process.env.S,apiSecretKey:process.env.K}${hasProton ? ",protonToken:process.env.P" : ""}})}).then(r=>console.log(JSON.stringify({status:r.status,cookie:r.headers.get("set-cookie")})))`.replace("process.env.A", JSON.stringify(x.XREA_ACCOUNT ?? "")).replace("process.env.S", JSON.stringify(x.XREA_SERVER_NAME ?? "")).replace("process.env.K", JSON.stringify(x.XREA_API_SECRET_KEY ?? "")).replace("process.env.P", JSON.stringify(x.PROTON_PASS_PERSONAL_ACCESS_TOKEN ?? "")) +
  (secureHeaderOut ? "" : "")
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }))
const listenSet = () => new Set(sh("ss -ltnH", { allowFail: true }).split("\n").map(l => l.trim().split(/\s+/)[3] ?? "").filter(Boolean))
const killMain = (service: string) => {
  // コンテナ内からの PID 1 へのシグナルは無視されるため、ホスト側から実プロセスを強制終了する
  const hostPid = sh(`${DOCKER} inspect -f '{{.State.Pid}}' ${cid(service)}`)
  sh(`kill -9 ${hostPid} 2>/dev/null || sudo -n kill -9 ${hostPid}`)
}

describe.runIf(live)("image", () => {
  beforeAll(() => {
    writeEnv()
    compose("build", "-f compose.yaml --profile proton")
  }, 900_000)

  test("docker-deploy/AC-1: 読み取りサービスのイメージで公式CLIのバージョンが表示され、アプリのイメージに含まれず、ハッシュ不一致ではビルドが失敗する", () => {
    expect(sh(`${DOCKER} run --rm --entrypoint pass-cli xrea-address-generator-reader:local --version`)).toMatch(/^Proton Pass CLI \d+\.\d+\.\d+/)
    expect(sh(`${DOCKER} run --rm --entrypoint sh xrea-address-generator:local -c 'command -v pass-cli || echo none'`)).toBe("none")
    const bad = sh(`${DOCKER} build -q --target reader --build-arg PASS_CLI_SHA256=${"0".repeat(64)} -t xrea-address-generator:badhash .`, { allowFail: true })
    expect(bad.startsWith("__FAILED__")).toBe(true)
    expect(bad).toContain("FAILED") // sha256sum の不一致
  }, 600_000)

  test("docker-deploy/AC-13: アプリのイメージの展開後のサイズが、300メガバイト以下である", () => {
    const size = Number(sh(`${DOCKER} image inspect -f '{{.Size}}' xrea-address-generator:local`))
    console.log(`アプリのイメージのサイズ: ${Math.round(size / 1024 / 1024)}MB`)
    expect(size).toBeLessThanOrEqual(300 * 1024 * 1024)
  })

  test("docker-deploy/AC-14: 読み取りサービスのイメージの展開後のサイズが、500メガバイト以下である", () => {
    const size = Number(sh(`${DOCKER} image inspect -f '{{.Size}}' xrea-address-generator-reader:local`))
    console.log(`読み取りサービスのイメージのサイズ: ${Math.round(size / 1024 / 1024)}MB`)
    expect(size).toBeLessThanOrEqual(500 * 1024 * 1024)
  })
})

describe.runIf(live)("compose", () => {
  let startupMs = 0
  let listenBefore = new Set<string>()

  beforeAll(async () => {
    writeEnv()
    compose("down -v", "-f compose.yaml --profile proton", true)
    listenBefore = listenSet()
    const t0 = Date.now()
    compose("up -d --no-build")
    await waitHealthy(["app", "xrea-gateway"], 60_000)
    startupMs = Date.now() - t0 // up の開始から死活確認の成功まで
  }, 900_000)
  afterAll(() => {
    compose("down -v", "-f compose.yaml --profile proton", true)
  }, 120_000)

  test("docker-deploy/AC-15: コンテナの起動から全コンテナの死活確認が成功するまでが、30秒以内である", () => {
    console.log(`起動から死活確認の成功まで: ${startupMs}ms`)
    expect(startupMs).toBeLessThanOrEqual(30_000)
  })

  test("docker-deploy/AC-2: 読み取りサービスを選ばない起動で、アプリ・ゲートウェイ・Cloudflare Tunnelの3コンテナが稼働する", () => {
    expect(compose("ps -a --format '{{.Service}}'").split("\n").sort()).toEqual(["app", "cloudflared", "xrea-gateway"])
  })

  test("docker-deploy/AC-7: ホストの外部アドレスからアプリのポートへ接続できず、同じネットワークからは接続できる", () => {
    expect(sh("curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/healthz", { allowFail: true })).not.toBe("200")
    const net = `${PROJECT}_default`
    const out = sh(`${DOCKER} run --rm --network ${net} xrea-address-generator:local node -e 'fetch("http://app:3000/healthz").then(r=>r.text()).then(t=>console.log(t))'`)
    expect(JSON.parse(out)).toEqual({ ok: true })
  }, 120_000)

  test("docker-deploy/AC-6: ホストの外部アドレスからゲートウェイのポートへ接続できず、アプリのコンテナからは接続できる", () => {
    expect(sh("curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/healthz", { allowFail: true })).not.toBe("200")
    expect(JSON.parse(inApp(`fetch("http://xrea-gateway:8081/healthz").then(r=>r.text()).then(t=>console.log(t))`))).toEqual({ ok: true })
    // 共有シークレットなしの /v1 は拒否される
    expect(inApp(`fetch("http://xrea-gateway:8081/v1/aliases").then(r=>console.log(r.status))`)).toBe("401")
  })

  test("docker-deploy/AC-16: 稼働中のホストで、アプリに由来する待ち受けポートが0個である", () => {
    for (const s of ["app", "xrea-gateway"]) {
      const ports = JSON.parse(sh(`${DOCKER} inspect -f '{{json .NetworkSettings.Ports}}' ${cid(s)}`)) as Record<string, unknown[] | null>
      expect(Object.values(ports).every(v => v === null || v.length === 0), s).toBe(true)
    }
    // 検証サーバには別の検証の待ち受けがあるため、Compose の起動前後で増えた待ち受けが無いことを確かめる
    expect([...listenSet()].filter(a => !listenBefore.has(a))).toEqual([])
  })

  test("docker-deploy/AC-11: ゲートウェイが非特権ユーザーで動き、ルートファイルシステムへの書き込みが失敗する", () => {
    const g = cid("xrea-gateway")
    expect(sh(`${DOCKER} exec ${g} id -u`)).not.toBe("0")
    expect(sh(`${DOCKER} exec ${g} sh -c 'touch /should-fail 2>&1 || echo denied'`)).toContain("denied")
    expect(sh(`${DOCKER} exec ${g} sh -c 'touch /tmp/ok && echo ok'`)).toBe("ok")
    const cfg = JSON.parse(sh(`${DOCKER} inspect -f '{{json .HostConfig}}' ${g}`))
    expect(cfg.ReadonlyRootfs).toBe(true)
    expect(cfg.CapDrop).toEqual(["ALL"])
    expect(cfg.SecurityOpt).toContain("no-new-privileges:true")
  })

  test("docker-deploy/AC-8: アプリとゲートウェイのプロセスを強制終了すると、自動で再起動して死活確認が成功する", async () => {
    for (const s of ["app", "xrea-gateway"]) {
      const before = Number(sh(`${DOCKER} inspect -f '{{.RestartCount}}' ${cid(s)}`))
      killMain(s)
      await sleep(2000)
      await waitHealthy([s], 60_000)
      expect(Number(sh(`${DOCKER} inspect -f '{{.RestartCount}}' ${cid(s)}`)), s).toBeGreaterThan(before)
    }
  }, 180_000)

  test("docker-deploy/AC-17: 設定ファイルのサーバ名を書き換えてアプリを再起動すると、サーバ名の一覧の応答が書き換えた内容になる", async () => {
    const list = () => JSON.parse(inApp(`fetch("http://127.0.0.1:3000/api/servers").then(r=>r.text()).then(t=>console.log(t))`)).servers as string[]
    expect(list()).toContain("s1.xrea.com")
    expect(list().length).toBeGreaterThan(300)
    // 書き換えた設定ファイルを重ねて、アプリのコンテナだけを作り直す（イメージは作り直さない）
    const custom = path.join(tmpDir, "servers.json")
    fs.writeFileSync(custom, JSON.stringify({ servers: ["x1.example.net", "x2.example.net"] }))
    writeEnv({ XREA_SERVERS_CONFIG: custom })
    compose("up -d --no-build --force-recreate app")
    await waitHealthy(["app"], 60_000)
    expect(list()).toEqual(["x1.example.net", "x2.example.net"])
  }, 120_000)

  test.runIf(hasXrea)("docker-deploy/AC-12: 環境変数ファイルにSecure属性を外す指定があっても、トンネルを使う構成のアプリが Secure 付きのcookieを発行する", () => {
    const r = JSON.parse(inApp(registerJs(true)))
    expect(r.status).toBe(204)
    expect(r.cookie).toContain("; Secure")
    expect(r.cookie).toContain("HttpOnly")
  }, 60_000)
})

describe.runIf(live)("compose (LAN)", () => {
  const files = "-f compose.yaml -f compose.lan.yaml"
  beforeAll(async () => {
    writeEnv({ TUNNEL_TOKEN: "", APP_PORT: String(LAN_PORT) })
    compose("down -v", `${files} --profile proton`, true)
    compose("up -d --no-build", files)
    await waitHealthy(["app", "xrea-gateway"], 60_000)
  }, 600_000)
  afterAll(() => {
    compose("down -v", `${files} --profile proton`, true)
  }, 120_000)

  test("docker-deploy/AC-3: トンネルのトークンが空の起動で、Cloudflare Tunnelのコンテナが0個になる", () => {
    expect(compose("ps -a --format '{{.Service}}'", files).split("\n").sort()).toEqual(["app", "xrea-gateway"])
  })

  test("docker-deploy/AC-9: LAN用の追加定義でアプリのポートだけが公開され、HTTPの接続でcookieが保持される", () => {
    expect(sh(`curl -s -m 3 http://127.0.0.1:${LAN_PORT}/healthz`)).toBe('{"ok":true}')
    expect(sh("curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/healthz", { allowFail: true })).not.toBe("200")
    const ports = JSON.parse(sh(`${DOCKER} inspect -f '{{json .NetworkSettings.Ports}}' ${cid("xrea-gateway")}`)) as Record<string, unknown[] | null>
    expect(Object.values(ports).every(v => v === null || v.length === 0)).toBe(true)
    if (!hasXrea) return
    const r = JSON.parse(inApp(registerJs(false)))
    expect(r.status).toBe(204)
    expect(r.cookie).not.toContain("Secure") // HTTPでもブラウザが保持できる
  }, 60_000)
})

describe.runIf(live && hasProton)("proton", () => {
  const files = "-f compose.yaml"
  const status = () => JSON.parse(inApp(`fetch("http://127.0.0.1:3000/api/proton/status",{headers:{cookie:process.env.C}}).then(r=>r.text()).then(t=>console.log(t))`.replace("process.env.C", JSON.stringify(cookie)))) as { state: string; reloginAt: string | null }
  let cookie = ""
  beforeAll(async () => {
    writeEnv({ COMPOSE_PROFILES: "proton", PROTON_READER_URL: "http://proton-reader:8082" })
    compose("down -v", `${files} --profile proton`, true)
    compose("up -d --no-build", files)
    await waitHealthy(["app", "xrea-gateway", "proton-reader"], 90_000)
  }, 900_000)
  afterAll(() => {
    compose("down -v", `${files} --profile proton`, true)
  }, 120_000)

  test.runIf(hasXrea)("docker-deploy/AC-4: 読み取りサービスのコンテナを作り直した後も、Proton Passのセッションが保持され、再ログインなしで取得できる", async () => {
    expect(compose("ps -a --format '{{.Service}}'", files).split("\n").sort()).toEqual(["app", "cloudflared", "proton-reader", "xrea-gateway"])
    const r = JSON.parse(inApp(registerJs(true)))
    expect(r.status).toBe(204)
    cookie = r.cookie.split(";")[0]
    for (let i = 0; i < 120 && status().state !== "ready"; i++) await sleep(1000)
    expect(status().state).toBe("ready")
    compose("up -d --no-build --force-recreate proton-reader", files)
    await waitHealthy(["proton-reader"], 60_000)
    for (let i = 0; i < 120 && status().state !== "ready"; i++) await sleep(1000)
    expect(status().state).toBe("ready")
    expect(status().reloginAt).toBeNull()
    const logs = sh(`${DOCKER} logs ${cid("proton-reader")} 2>&1`)
    expect(logs).not.toContain('"cmd":"login"') // 作り直した後のコンテナでは、ログインを実行していない
    expect(logs).toContain('"cmd":"item list"')
  }, 600_000)
})
