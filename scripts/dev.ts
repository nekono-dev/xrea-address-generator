// ローカル開発用に、ゲートウェイ・読み取りサービス・アプリ・Vite開発サーバをまとめて起動する。
// 画面は 0.0.0.0:5173 で待ち受ける（/api はアプリ 3000 番へ転送される）。内部サービスは固定のトークンなので 127.0.0.1 に限る。Ctrl+C で全て終了する。
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

// 開発専用の固定値。本番では使わない
const DEV_SECRET = "dev-only-secret-0123456789abcdef0123456789abcdef"
const env: Record<string, string | undefined> = {
  ...process.env,
  INTERNAL_TOKEN: process.env.INTERNAL_TOKEN ?? DEV_SECRET,
  COOKIE_SECRET: process.env.COOKIE_SECRET ?? DEV_SECRET,
  COOKIE_SECURE: "0", // 開発はhttpなので Secure を付けない
  BIND_ADDRESS: "127.0.0.1",
  SESSION_DIR: process.env.SESSION_DIR ?? ".proton-session",
  XREA_GATEWAY_URL: process.env.XREA_GATEWAY_URL ?? "http://127.0.0.1:8081",
  // Proton Pass連携を使わないときは PROTON_READER_URL= （空）を指定する
  PROTON_READER_URL: process.env.PROTON_READER_URL ?? "http://127.0.0.1:8082",
}

const BIN_DIR = path.resolve(".dev/bin")

/** 公式CLI（pass-cli）が無ければ、配布マニフェストから取得してハッシュを検証し .dev/bin に置く */
async function ensurePassCli(): Promise<void> {
  if (spawnSync("pass-cli", ["--version"], { stdio: "ignore", env }).status === 0) return
  const bin = path.join(BIN_DIR, "pass-cli")
  if (!existsSync(bin)) {
    const os = process.platform === "darwin" ? "macos" : "linux"
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64"
    console.log(`[dev] pass-cli を取得します（${os}/${arch}）`)
    const manifest = (await (await fetch("https://proton.me/download/pass-cli/versions.json")).json()) as { passCliVersions: { urls: Record<string, Record<string, { url: string; hash: string }>> } }
    const t = manifest.passCliVersions.urls[os]?.[arch]
    if (!t) throw new Error(`pass-cli の配布が見つかりません: ${os}/${arch}`)
    const data = Buffer.from(await (await fetch(t.url)).arrayBuffer())
    if (createHash("sha256").update(data).digest("hex") !== t.hash) throw new Error("pass-cli のハッシュが一致しません")
    mkdirSync(BIN_DIR, { recursive: true })
    writeFileSync(bin, data)
    chmodSync(bin, 0o755)
  }
  env.PATH = `${BIN_DIR}${path.delimiter}${env.PATH ?? ""}`
}
if (env.PROTON_READER_URL) await ensurePassCli()

const services: { name: string; cmd: string[]; env?: Record<string, string> }[] = [
  { name: "gateway", cmd: ["tsx", "watch", "src/gateway/main.ts"], env: { PORT: "8081" } },
  { name: "app", cmd: ["tsx", "watch", "src/app/node.ts"], env: { PORT: "3000" } },
  { name: "web", cmd: ["vite", "--host", "0.0.0.0", "--port", "5173", "--strictPort"] },
]
if (env.PROTON_READER_URL) services.push({ name: "reader", cmd: ["tsx", "watch", "src/reader/main.ts"], env: { PORT: "8082" } })

const children: ChildProcess[] = []
for (const s of services) {
  const p = spawn("npx", s.cmd, { env: { ...env, ...s.env }, stdio: ["ignore", "pipe", "pipe"] })
  const out = (d: Buffer) => process.stdout.write(d.toString().replace(/^(?=.)/gm, `[${s.name}] `))
  p.stdout!.on("data", out)
  p.stderr!.on("data", out)
  p.on("exit", code => {
    console.error(`[${s.name}] 終了しました（code=${code}）`)
    stop()
  })
  children.push(p)
}

function stop(): void {
  for (const c of children) c.kill("SIGTERM")
  setTimeout(() => process.exit(0), 500)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
