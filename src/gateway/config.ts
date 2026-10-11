// 環境変数の読み込みと検証。
import { MIN_TOKEN_LENGTH } from "../shared/internalAuth"

export class ConfigError extends Error {}

export type GatewayConfig = { internalToken: string; port: number; bindAddress: string; logLevel: string }

export function loadGatewayConfig(env: Record<string, string | undefined>): GatewayConfig {
  const internalToken = env.INTERNAL_TOKEN ?? ""
  if (internalToken.length < MIN_TOKEN_LENGTH) throw new ConfigError(`INTERNAL_TOKEN は${MIN_TOKEN_LENGTH}文字以上で設定してください`)
  const port = Number(env.PORT || 8081)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`PORT が不正です: ${env.PORT}`)
  return { internalToken, port, bindAddress: env.BIND_ADDRESS || "0.0.0.0", logLevel: env.LOG_LEVEL || "info" }
}
