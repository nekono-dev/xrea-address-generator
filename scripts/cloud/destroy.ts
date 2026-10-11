// クラウド配備の一括撤去（deploy.ts の逆）。本アプリが扱う情報を Cloud Run と Cloudflare に残さない。
//   npm run destroy:cloud -- --yes        確認を省いて撤去する（省くと PROJECT_ID の入力を求める）
//   npm run destroy:cloud -- --dry-run    読み取りだけ実行し、変更を伴う操作は表示だけにする
// 何度実行しても同じ結果になる。存在しないものは飛ばす。
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { must, realRunner, GATEWAY_SERVICE, READER_SERVICE, type Runner } from "./deploy"

export type DestroyConfig = { projectId: string; region: string; repo: string; wranglerConfig: string; dryRun: boolean; yes: boolean }

/** Secret Manager の共有シークレットと、運用手順で作る COOKIE_SECRET の控え */
export const SECRETS = ["xrea-internal-token", "xrea-cookie-secret"]

export function loadDestroyConfig(env: NodeJS.ProcessEnv, argv: string[], exists: (p: string) => boolean = existsSync): DestroyConfig {
  if (!env.PROJECT_ID) throw new Error("環境変数 PROJECT_ID（Google Cloud のプロジェクトID）を設定してください")
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error("環境変数 CLOUDFLARE_ACCOUNT_ID（Cloudflare のアカウントID）を設定してください")
  for (const a of argv) if (!["--yes", "--dry-run"].includes(a)) throw new Error(`不明な引数です: ${a}（使えるのは --yes、--dry-run）`)
  return {
    projectId: env.PROJECT_ID,
    region: env.REGION || "asia-northeast1",
    repo: "xrea",
    wranglerConfig: exists("wrangler.jsonc") ? "wrangler.jsonc" : "wrangler.template.jsonc",
    dryRun: argv.includes("--dry-run"),
    yes: argv.includes("--yes"),
  }
}

/** Workers → Cloud Run → Artifact Registry → Secret Manager の順に撤去する。入口（Workers）を先に落とす */
export function destroy(c: DestroyConfig, r: Runner): void {
  r.log("app（Workers）を削除（スクリプト、秘密、画面ファイル）")
  if (r.query({ cmd: "npx", args: ["wrangler", "deployments", "list", "--config", c.wranglerConfig] }).code === 0) {
    must(r.exec({ cmd: "npx", args: ["wrangler", "delete", "--config", c.wranglerConfig, "--force"] }), "Workers の削除")
  } else {
    r.log("Workers は存在しません")
  }

  for (const service of [GATEWAY_SERVICE, READER_SERVICE]) {
    r.log(`${service} を削除`)
    if (r.query({ cmd: "gcloud", args: ["run", "services", "describe", service, "--region", c.region] }).code === 0) {
      must(r.exec({ cmd: "gcloud", args: ["run", "services", "delete", service, "--region", c.region, "--quiet"] }), `${service} の削除`)
    }
  }

  r.log(`Artifact Registry のリポジトリ ${c.repo}（イメージごと）を削除`)
  if (r.query({ cmd: "gcloud", args: ["artifacts", "repositories", "describe", c.repo, `--location=${c.region}`] }).code === 0) {
    must(r.exec({ cmd: "gcloud", args: ["artifacts", "repositories", "delete", c.repo, `--location=${c.region}`, "--quiet"] }), "リポジトリの削除")
  }

  for (const s of SECRETS) {
    r.log(`Secret Manager の ${s} を削除`)
    if (r.query({ cmd: "gcloud", args: ["secrets", "describe", s] }).code === 0) {
      must(r.exec({ cmd: "gcloud", args: ["secrets", "delete", s, "--quiet"] }), `${s} の削除`)
    }
  }
}

/** 手元でビルドしたイメージを消す（失敗しても撤去の成否に影響しない） */
function removeLocalImages(c: DestroyConfig, dryRun: boolean): void {
  const out = spawnSync("docker", ["images", "--format", "{{.Repository}}:{{.Tag}}", `${c.region}-docker.pkg.dev/${c.projectId}/${c.repo}/*`], { encoding: "utf8" })
  const images = (out.stdout ?? "").split("\n").filter(Boolean)
  if (images.length === 0) return
  console.log(`\n==> 手元のイメージを削除: ${images.join(" ")}`)
  if (dryRun) return console.log(`[dry-run] docker image rm ${images.join(" ")}`)
  spawnSync("docker", ["image", "rm", ...images], { stdio: "inherit" })
}

async function confirm(c: DestroyConfig): Promise<boolean> {
  if (c.yes || c.dryRun) return true
  if (!process.stdin.isTTY) return false
  console.log(`プロジェクト ${c.projectId} の xrea-gateway・proton-reader・イメージ・共有シークレットと、Workers（登録済みの認証情報を含む）を削除します。元に戻せません。`)
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question("続けるには PROJECT_ID を入力してください: ")
  rl.close()
  return answer.trim() === c.projectId
}

async function main(argv: string[]): Promise<number> {
  let c: DestroyConfig
  try {
    c = loadDestroyConfig(process.env, argv)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  if (!(await confirm(c))) {
    console.error("確認できなかったため中止しました（非対話で実行するときは --yes を付けてください）")
    return 2
  }
  try {
    destroy(c, realRunner(c.dryRun))
    removeLocalImages(c, c.dryRun)
    console.log("\n撤去しました。Cloud Run のログ（Cloud Logging）は保持期間まで残ります。Cloudflare Access のポリシーと DNS は手動で確認してください。")
    return 0
  } catch (e) {
    console.error(`\n${(e as Error).message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then(code => process.exit(code))
}
