// 環境変数の読み込みと検証。
import type { ProtonConfig } from "../proton/index"
import { loadProtonConfig } from "../proton/index"
import type { XreaConfig } from "../xrea/client"

export const REQUIRED_ENV = [
  "XREA_ACCOUNT",
  "XREA_SERVER_NAME",
  "XREA_API_SECRET_KEY",
] as const

export type AppConfig = {
  xrea: XreaConfig
  /** Proton Pass連携の設定。アクセストークンが未設定なら null（連携を無効にする） */
  proton: ProtonConfig | null
  bindAddress: string
  port: number
  logLevel: string
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const missing = REQUIRED_ENV.filter(k => !env[k])
  if (missing.length) throw new ConfigError(`必須の環境変数が未設定: ${missing.join(", ")}`)
  const port = Number(env.PORT || 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT が不正です: ${env.PORT}`)
  return {
    xrea: { account: env.XREA_ACCOUNT!, serverName: env.XREA_SERVER_NAME!, apiSecretKey: env.XREA_API_SECRET_KEY! },
    proton: loadProtonConfig(env),
    // トンネルを使わない（TUNNEL_TOKEN が未設定の）ときは、LANから接続できるよう全アドレスで待ち受ける
    bindAddress: env.BIND_ADDRESS || (env.TUNNEL_TOKEN ? "127.0.0.1" : "0.0.0.0"),
    port,
    logLevel: env.LOG_LEVEL || "info",
  }
}
