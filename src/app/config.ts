// 環境変数（Workersでは環境の束縛）の読み込みと検証。入力は process.env と同じ形式の文字列の辞書。
import { ConfigError, loadCredentialConfig, type CredentialConfig } from "../credentials/config"
import { MIN_TOKEN_LENGTH } from "../shared/internalAuth"
import { allowsHttp, type HttpPolicy } from "./internalUrl"
import { loadServers } from "./servers"

export { ConfigError }

export type AppConfig = {
  gatewayUrl: string
  internalToken: string
  /** 未設定ならProton Pass連携を使わない */
  readerUrl: string | null
  credentials: CredentialConfig
  /** 登録画面のサーバ名の選択肢 */
  servers: string[]
  bindAddress: string
  port: number
  logLevel: string
}

function url(env: Record<string, string | undefined>, name: string, required: boolean, policy: HttpPolicy): string | null {
  const v = (env[name] ?? "").trim()
  if (!v) {
    if (required) throw new ConfigError(`${name} が未設定です`)
    return null
  }
  try {
    const u = new URL(v)
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error()
    if (!allowsHttp(u, policy)) {
      throw new ConfigError(`${name} は${policy === "all" ? "https" : "https、または内部ネットワークのホストの http"} のURLにしてください`)
    }
  } catch (e) {
    if (e instanceof ConfigError) throw e
    throw new ConfigError(`${name} がURLの形式ではありません`)
  }
  return v.replace(/\/+$/, "")
}

export function loadAppConfig(env: Record<string, string | undefined>, opts: { allowSqlite?: boolean; httpPolicy?: HttpPolicy; readFile?: (path: string) => string } = {}): AppConfig {
  const allowSqlite = opts.allowSqlite ?? true
  const policy = opts.httpPolicy ?? "external"
  const gatewayUrl = url(env, "XREA_GATEWAY_URL", true, policy)!
  const internalToken = env.INTERNAL_TOKEN ?? ""
  if (internalToken.length < MIN_TOKEN_LENGTH) throw new ConfigError(`INTERNAL_TOKEN は${MIN_TOKEN_LENGTH}文字以上で設定してください`)
  const credentials = loadCredentialConfig(env)
  if (credentials.store === "sqlite" && !allowSqlite) throw new ConfigError("この実行環境では CREDENTIAL_STORE=sqlite を使えません")
  const port = Number(env.PORT || 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT が不正です: ${env.PORT}`)
  return {
    gatewayUrl,
    internalToken,
    readerUrl: url(env, "PROTON_READER_URL", false, policy),
    credentials,
    servers: loadServers(env, opts.readFile),
    // トンネルを使わない（TUNNEL_TOKEN が未設定の）ときは、LANから接続できるよう全アドレスで待ち受ける
    bindAddress: env.BIND_ADDRESS || (env.TUNNEL_TOKEN ? "127.0.0.1" : "0.0.0.0"),
    port,
    logLevel: env.LOG_LEVEL || "info",
  }
}
