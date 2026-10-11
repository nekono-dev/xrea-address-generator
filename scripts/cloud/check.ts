// コンテナ基盤の要件の検査と、配備後の疎通確認。
//   npx tsx scripts/cloud/check.ts platform --max-instances 1 --https true --internal-token true
//   npx tsx scripts/cloud/check.ts probe --app https://... [--reader https://...]
// 秘匿値は出力に含めず、成功と失敗の別だけを報告する。

export type PlatformSpec = { maxInstances: number; https: boolean; hasInternalToken: boolean }

function check(name: string, p: PlatformSpec): string[] {
  const errors: string[] = []
  if (p.maxInstances !== 1) errors.push(`${name}: 最大インスタンス数は1にしてください（現在 ${p.maxInstances}）`)
  if (!p.https) errors.push(`${name}: HTTPSで公開してください`)
  if (!p.hasInternalToken) errors.push(`${name}: INTERNAL_TOKEN を環境変数で設定してください`)
  return errors
}

/** 違反の説明の配列。最大インスタンス数が1以外、HTTPS でない、共有シークレットが無いと違反 */
export const checkReader = (p: PlatformSpec): string[] => check("読み取りサービス", p)

export type Probe = { name: string; ok: boolean; detail: string }
export const PROBE_DEADLINE_MS = 60_000

/** 60秒の締め切りの中で、次を順に確認する */
export async function probe(
  env: { app: string; reader?: string },
  opts: { fetch?: typeof fetch; deadlineMs?: number } = {},
): Promise<Probe[]> {
  const f = opts.fetch ?? fetch
  const signal = AbortSignal.timeout(opts.deadlineMs ?? PROBE_DEADLINE_MS)
  const url = (base: string, p: string) => `${base.replace(/\/+$/, "")}${p}`
  const run = async (name: string, expected: (r: Response) => boolean | Promise<boolean>, u: string, init: RequestInit = {}): Promise<Probe> => {
    try {
      // 転送（Cloudflare Access のログインなど）を辿ると、ログイン画面の 200 を成功と誤判定するため、辿らない
      const r = await f(u, { ...init, signal, redirect: "manual" })
      const redirected = r.status >= 300 && r.status < 400
      const ok = !redirected && (await expected(r))
      return { name, ok, detail: redirected ? `HTTP ${r.status}（転送されました。Cloudflare Access などの認証が前段にあります）` : `HTTP ${r.status}` }
    } catch (e) {
      return { name, ok: false, detail: signal.aborted ? "60秒の締め切りを超えました" : `接続できません（${(e as Error).name}）` }
    }
  }
  const status = (code: number) => (r: Response) => r.status === code
  const bad = { xrea: { account: "probe", serverName: "probe.invalid", apiSecretKey: "probe" } }
  const results: Probe[] = [
    await run("Workers の死活確認", status(200), url(env.app, "/healthz")),
  ]
  if (env.reader) {
    results.push(
      await run("読み取りサービスの死活確認", status(200), url(env.reader, "/health")),
      await run("読み取りサービスは共有シークレットなしを拒否する", status(401), url(env.reader, "/v1/entries")),
    )
  }
  // 誤った認証情報の登録が 400 invalid_credentials になれば、内蔵ゲートウェイ（Durable Object）がXREAへ到達して拒否された応答を受け取っている
  results.push(
    await run(
      "XREAへの到達（誤った認証情報の登録が400になる）",
      async r => r.status === 400 && ((await r.json()) as { error?: { code?: string } }).error?.code === "invalid_credentials" && !r.headers.has("set-cookie"),
      url(env.app, "/api/credentials"),
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(bad) },
    ),
  )
  return results
}

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv
  if (cmd === "platform") {
    const p: PlatformSpec = { maxInstances: Number(arg(rest, "max-instances")), https: arg(rest, "https") === "true", hasInternalToken: arg(rest, "internal-token") === "true" }
    const errors = checkReader(p)
    for (const e of errors) console.error(e)
    console.log(errors.length ? "要件を満たしていません" : "要件を満たしています")
    return errors.length ? 1 : 0
  }
  if (cmd === "probe") {
    const app = arg(rest, "app")
    if (!app) {
      console.error("--app を指定してください")
      return 2
    }
    const results = await probe({ app, reader: arg(rest, "reader") })
    for (const r of results) console.log(`${r.ok ? "成功" : "失敗"}: ${r.name}（${r.detail}）`)
    return results.every(r => r.ok) ? 0 : 1
  }
  console.error("使い方: check.ts platform|probe ...")
  return 2
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then(code => process.exit(code))
}
