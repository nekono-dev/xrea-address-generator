// 外部へ公開するインターフェース。
import { createCliRunner, type CliRunner } from "./cli"
import { CachedReader, type Logger, type ProtonReader } from "./cache"
import { Session } from "./session"

export type { AddressMap } from "./projection"
export type { ProtonReader, ReaderState, Status } from "./cache"
export type { ErrorKind } from "./cli"

export const DEFAULT_SESSION_DIR = "/var/lib/xrea-address-generator/session"

export type ProtonConfig = { token: string; vault: string; sessionDir: string }

/** 環境変数から設定を読む。必須の変数が無ければ変数名を示して例外を送出する */
export function loadProtonConfig(env: NodeJS.ProcessEnv = process.env): ProtonConfig {
  const missing = ["PROTON_PASS_PERSONAL_ACCESS_TOKEN", "PROTON_PASS_VAULT_NAME"].filter(k => !env[k])
  if (missing.length) throw new Error(`必須の環境変数が未設定: ${missing.join(", ")}`)
  return {
    token: env.PROTON_PASS_PERSONAL_ACCESS_TOKEN!,
    vault: env.PROTON_PASS_VAULT_NAME!,
    sessionDir: env.SESSION_DIR || DEFAULT_SESSION_DIR,
  }
}

/** 読み取りの部品を組み立て、起動直後の再取得を開始する */
export function createProtonReader(config: ProtonConfig, opts: { bin?: string; logger?: Logger } = {}): ProtonReader {
  const base = createCliRunner({ token: config.token, sessionDir: config.sessionDir, bin: opts.bin })
  // ログインの実行を記録する（トークンやセッションの内容は出さない）
  const run: CliRunner = async args => {
    const r = await base(args)
    if (args[0] === "login") opts.logger?.info({ cmd: "login", exitCode: 0, durationMs: r.durationMs })
    return r
  }
  const session = new Session(run, config.sessionDir)
  const reader = new CachedReader({ run, session, vault: config.vault, logger: opts.logger })
  void session
    .ensure()
    .catch(() => undefined)
    .then(() => reader.refresh())
  return reader
}
