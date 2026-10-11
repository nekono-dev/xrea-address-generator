// 秘密値・保持方式・Secure属性の読み込みと検証。
export class ConfigError extends Error {}

export const DEFAULT_DB_PATH = "/var/lib/xrea-address-generator/sessions.db"

export type CredentialConfig = {
  secret: string
  store: "cookie" | "sqlite"
  dbPath: string
  secure: boolean
}

export function loadCredentialConfig(env: Record<string, string | undefined>): CredentialConfig {
  const secret = env.COOKIE_SECRET ?? ""
  if (secret.length < 32) throw new ConfigError("COOKIE_SECRET は32文字以上で設定してください")
  const store = env.CREDENTIAL_STORE || "cookie"
  if (store !== "cookie" && store !== "sqlite") throw new ConfigError("CREDENTIAL_STORE は cookie か sqlite です")
  return {
    secret,
    store,
    dbPath: env.CREDENTIAL_DB_PATH || DEFAULT_DB_PATH,
    secure: env.COOKIE_SECURE !== "0",
  }
}
