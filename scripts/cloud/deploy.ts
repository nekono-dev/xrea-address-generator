// クラウド配備の一括実行（Cloud Run の proton-reader と、Workers の app。XREAゲートウェイは app に内蔵）。
//   npm run deploy:cloud                  すべてを配備する
//   npm run deploy:cloud -- --no-reader   proton-reader を配備しない（Google Cloud は使わない）
//   npm run deploy:cloud -- --dry-run     読み取りだけ実行し、変更を伴う操作は表示だけにする
// 何度実行しても同じ結果になる。イメージのタグは変えず、既存のサービスとイメージを先に削除してから入れ直す。
// 秘匿値は引数に載せず、標準入力だけで渡す。出力にも含めない。
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"

export type DeployConfig = {
  projectId: string
  region: string
  tag: string
  /** Artifact Registry のリポジトリ名 */
  repo: string
  /** Secret Manager の共有シークレット名 */
  secret: string
  /** proton-reader を配備するか */
  reader: boolean
  dryRun: boolean
  /** 疎通確認に使う app のURL（省略すると疎通確認を飛ばす） */
  appUrl?: string
  /** 使う wrangler の定義 */
  wranglerConfig: string
}

export type Result = { code: number; stdout: string }
export type Call = { cmd: string; args: string[]; input?: string }

/** 外部コマンドの実行を差し替えられるようにする（テスト用）。query は読み取り、exec は変更を伴う操作 */
export type Runner = {
  query(c: Call): Result
  exec(c: Call): Result
  log(msg: string): void
}

export const READER_SERVICE = "proton-reader"

export function loadConfig(env: NodeJS.ProcessEnv, argv: string[], exists: (p: string) => boolean = existsSync): DeployConfig {
  for (const a of argv) if (!["--no-reader", "--dry-run"].includes(a)) throw new Error(`不明な引数です: ${a}（使えるのは --no-reader、--dry-run）`)
  const reader = !argv.includes("--no-reader")
  const projectId = env.PROJECT_ID ?? ""
  if (reader && !projectId) throw new Error("環境変数 PROJECT_ID（Google Cloud のプロジェクトID）を設定してください（読み取りサービスを配備しないときは不要です）")
  if (!env.CLOUDFLARE_ACCOUNT_ID) throw new Error("環境変数 CLOUDFLARE_ACCOUNT_ID（Cloudflare のアカウントID）を設定してください")
  return {
    projectId,
    region: env.REGION || "asia-northeast1",
    tag: env.IMAGE_TAG || "v1",
    repo: "xrea",
    secret: "xrea-internal-token",
    reader,
    dryRun: argv.includes("--dry-run"),
    appUrl: env.APP_URL || undefined,
    wranglerConfig: exists("wrangler.jsonc") ? "wrangler.jsonc" : "wrangler.template.jsonc",
  }
}

const imageOf = (c: DeployConfig, name: "app" | "reader") => `${c.region}-docker.pkg.dev/${c.projectId}/${c.repo}/${name}:${c.tag}`

export const must = (r: Result, what: string): Result => {
  if (r.code !== 0) throw new Error(`${what} に失敗しました（終了コード ${r.code}）`)
  return r
}

/** 共有シークレットを Secret Manager に用意する。既にあれば作り直さない（作り直すとWorkersとの不一致になる） */
function ensureInternalToken(c: DeployConfig, r: Runner): void {
  if (r.query({ cmd: "gcloud", args: ["secrets", "describe", c.secret] }).code === 0) {
    r.log(`Secret Manager の ${c.secret} は作成済みです`)
  } else {
    r.log(`Secret Manager に ${c.secret} を作成します`)
    must(r.exec({ cmd: "gcloud", args: ["secrets", "create", c.secret, "--data-file=-"], input: randomBytes(48).toString("base64") }), "共有シークレットの作成")
  }
  // 実行用サービスアカウントへの読み取りの許可（付与済みでも成功する）
  const number = must(r.query({ cmd: "gcloud", args: ["projects", "describe", c.projectId, "--format=value(projectNumber)"] }), "プロジェクト番号の取得").stdout.trim()
  must(
    r.exec({
      cmd: "gcloud",
      args: ["secrets", "add-iam-policy-binding", c.secret, `--member=serviceAccount:${number}-compute@developer.gserviceaccount.com`, "--role=roles/secretmanager.secretAccessor", "--quiet"],
    }),
    "共有シークレットの読み取り許可",
  )
}

function prepareGcp(c: DeployConfig, r: Runner): void {
  r.log("Google Cloud の準備（API・Artifact Registry・Secret Manager）")
  must(r.exec({ cmd: "gcloud", args: ["services", "enable", "run.googleapis.com", "artifactregistry.googleapis.com", "secretmanager.googleapis.com"] }), "API の有効化")
  if (r.query({ cmd: "gcloud", args: ["artifacts", "repositories", "describe", c.repo, `--location=${c.region}`] }).code !== 0) {
    must(r.exec({ cmd: "gcloud", args: ["artifacts", "repositories", "create", c.repo, "--repository-format=docker", `--location=${c.region}`] }), "リポジトリの作成")
  }
  must(r.exec({ cmd: "gcloud", args: ["auth", "configure-docker", `${c.region}-docker.pkg.dev`, "--quiet"] }), "Docker の認証設定")
  ensureInternalToken(c, r)
}

/**
 * コンテナ1つを、タグを変えずに入れ直す。
 * ビルド → 既存のサービスを削除 → 既存のイメージを削除 → push → デプロイ。
 * 停止の時間を短くするため、時間のかかるビルドは削除の前に済ませる。
 * @returns サービスのURL
 */
function redeployContainer(c: DeployConfig, r: Runner, o: { service: string; target: "app" | "reader"; extra: string[] }): string {
  const image = imageOf(c, o.target)
  r.log(`${o.service}: ビルド（${image}）`)
  must(r.exec({ cmd: "docker", args: ["build", "--platform", "linux/amd64", "--target", o.target, "-t", image, "."] }), `${o.service} のビルド`)

  if (r.query({ cmd: "gcloud", args: ["run", "services", "describe", o.service, "--region", c.region] }).code === 0) {
    r.log(`${o.service}: 既存のサービスを削除`)
    must(r.exec({ cmd: "gcloud", args: ["run", "services", "delete", o.service, "--region", c.region, "--quiet"] }), `${o.service} の削除`)
  }
  if (r.query({ cmd: "gcloud", args: ["artifacts", "docker", "images", "describe", image] }).code === 0) {
    r.log(`${o.service}: 既存のイメージを削除`)
    must(r.exec({ cmd: "gcloud", args: ["artifacts", "docker", "images", "delete", image, "--delete-tags", "--quiet"] }), `${o.service} のイメージの削除`)
  }

  r.log(`${o.service}: push とデプロイ`)
  must(r.exec({ cmd: "docker", args: ["push", image] }), `${o.service} の push`)
  must(
    r.exec({
      cmd: "gcloud",
      args: [
        "run", "deploy", o.service, "--image", image, "--region", c.region,
        ...o.extra,
        "--max-instances", "1", "--min-instances", "0",
        "--allow-unauthenticated",
        "--set-secrets", `INTERNAL_TOKEN=${c.secret}:latest`,
        "--quiet",
      ],
    }),
    `${o.service} のデプロイ`,
  )
  if (c.dryRun) return `https://${o.service}.example.invalid`
  return must(r.query({ cmd: "gcloud", args: ["run", "services", "describe", o.service, "--region", c.region, "--format=value(status.url)"] }), `${o.service} のURLの取得`).stdout.trim()
}

/** 設定済みの Workers の秘密の名前 */
function secretNames(c: DeployConfig, r: Runner): string[] {
  const res = r.query({ cmd: "npx", args: ["wrangler", "secret", "list", "--config", c.wranglerConfig] })
  if (res.code !== 0) return []
  try {
    return (JSON.parse(res.stdout) as { name: string }[]).map(s => s.name)
  } catch {
    return []
  }
}

function deployWorkers(c: DeployConfig, r: Runner, urls: { reader?: string }): void {
  r.log(`app: ビルドと配備（定義: ${c.wranglerConfig}）`)
  must(r.exec({ cmd: "npm", args: ["run", "build:worker"] }), "Workers のビルド")
  must(r.exec({ cmd: "npm", args: ["run", "build:web"] }), "画面のビルド")

  // INTERNAL_TOKEN は読み取りサービスを使うときだけ、Secret Manager の値を標準入力で渡す（毎回同じ値になる）
  if (urls.reader) {
    const token = c.dryRun ? "" : must(r.query({ cmd: "gcloud", args: ["secrets", "versions", "access", "latest", `--secret=${c.secret}`] }), "共有シークレットの取得").stdout
    must(r.exec({ cmd: "npx", args: ["wrangler", "secret", "put", "INTERNAL_TOKEN", "--config", c.wranglerConfig], input: token }), "INTERNAL_TOKEN の設定")
  }

  // COOKIE_SECRET を作り直すと登録済みの認証情報がすべて失効するため、未設定のときだけ作る
  if (secretNames(c, r).includes("COOKIE_SECRET")) {
    r.log("COOKIE_SECRET は設定済みです（変更しません）")
  } else {
    r.log("COOKIE_SECRET を新しく設定します。Workers の秘密は読み戻せないため、運用手順に従って控えを Secret Manager に置いてください")
    must(r.exec({ cmd: "npx", args: ["wrangler", "secret", "put", "COOKIE_SECRET", "--config", c.wranglerConfig], input: randomBytes(48).toString("base64") }), "COOKIE_SECRET の設定")
  }

  // URL は --var で上書きし、wrangler.jsonc を書き換えない
  must(
    r.exec({
      cmd: "npx",
      args: ["wrangler", "deploy", "--config", c.wranglerConfig, "--var", `PROTON_READER_URL:${urls.reader ?? ""}`],
    }),
    "Workers のデプロイ",
  )
}

/** 一括で配備する。Cloud Run のURLは配備後に決まるため、コンテナ → Workers の順に進める。読み取りサービスを配備しないときは Google Cloud に触れない */
export function deploy(c: DeployConfig, r: Runner): { reader?: string } {
  let reader: string | undefined
  if (c.reader) {
    prepareGcp(c, r)
    reader = redeployContainer(c, r, { service: READER_SERVICE, target: "reader", extra: [] })
  }
  deployWorkers(c, r, { reader })
  return { reader }
}

/** gcloud の呼び出しに --project を付ける。gcloud の既定のプロジェクトに頼ると、PROJECT_ID と違うプロジェクトを操作しうるため */
export function scoped(c: Call, projectId: string): Call {
  return c.cmd === "gcloud" && projectId ? { ...c, args: [...c.args, "--project", projectId] } : c
}

/** 変更を伴う操作の実行（dry-run のときは表示だけ）。projectId があるとき、すべての gcloud をそのプロジェクトへ向ける */
export function realRunner(dryRun: boolean, projectId = ""): Runner {
  const run = (c: Call, capture: boolean): Result => {
    const p = spawnSync(c.cmd, c.args, { input: c.input, encoding: "utf8", stdio: [c.input !== undefined ? "pipe" : "inherit", capture ? "pipe" : "inherit", "inherit"] })
    return { code: p.status ?? 1, stdout: p.stdout ?? "" }
  }
  return {
    query: c => run(scoped(c, projectId), true),
    exec: raw => {
      const c = scoped(raw, projectId)
      if (dryRun) {
        console.log(`[dry-run] ${c.cmd} ${c.args.join(" ")}${c.input !== undefined ? "  （標準入力で秘匿値を渡す）" : ""}`)
        return { code: 0, stdout: "" }
      }
      return run(c, false)
    },
    log: m => console.log(`\n==> ${m}`),
  }
}

async function main(argv: string[]): Promise<number> {
  let c: DeployConfig
  try {
    c = loadConfig(process.env, argv)
  } catch (e) {
    console.error((e as Error).message)
    return 2
  }
  try {
    const urls = deploy(c, realRunner(c.dryRun, c.projectId))
    if (urls.reader) console.log(`読み取りサービス: ${urls.reader}`)
    if (c.dryRun) return 0
    if (!c.appUrl) {
      console.log("\nAPP_URL が未設定のため疎通確認を飛ばしました。app のURLを指定して次を実行してください:")
      console.log(`  npx tsx scripts/cloud/check.ts probe --app \$APP_URL${urls.reader ? ` --reader ${urls.reader}` : ""}`)
      return 0
    }
    const { probe } = await import("./check")
    const results = await probe({ app: c.appUrl, reader: urls.reader })
    for (const p of results) console.log(`${p.ok ? "成功" : "失敗"}: ${p.name}（${p.detail}）`)
    return results.every(p => p.ok) ? 0 : 1
  } catch (e) {
    console.error(`\n${(e as Error).message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then(code => process.exit(code))
}
