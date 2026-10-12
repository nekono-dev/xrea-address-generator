// 環境変数の読み込みと検証。
import { MIN_TOKEN_LENGTH } from "../shared/internalAuth"

export class ConfigError extends Error {}

export const DEFAULT_SESSION_DIR = "/var/lib/xrea-alias-dashboard/session"

export type ReaderConfig = { internalToken: string; sessionDir: string; maxTenants: number; port: number; bindAddress: string; logLevel: string }

export function loadReaderConfig(env: Record<string, string | undefined>): ReaderConfig {
  const internalToken = env.INTERNAL_TOKEN ?? ""
  if (internalToken.length < MIN_TOKEN_LENGTH) throw new ConfigError(`INTERNAL_TOKEN は${MIN_TOKEN_LENGTH}文字以上で設定してください`)
  const int = (name: string, def: number, min: number, max: number) => {
    const v = Number(env[name] || def)
    if (!Number.isInteger(v) || v < min || v > max) throw new ConfigError(`${name} が不正です: ${env[name]}`)
    return v
  }
  return {
    internalToken,
    sessionDir: env.SESSION_DIR || DEFAULT_SESSION_DIR,
    maxTenants: int("MAX_TENANTS", 20, 1, 1000),
    port: int("PORT", 8082, 1, 65535),
    bindAddress: env.BIND_ADDRESS || "0.0.0.0",
    logLevel: env.LOG_LEVEL || "info",
  }
}
