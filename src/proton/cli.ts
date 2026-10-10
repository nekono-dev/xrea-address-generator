// 公式CLI（pass-cli）の実行。許可リスト・環境変数の限定・打ち切りを備える。
import { execFile } from "node:child_process"

export const ALLOWED = [["login"], ["info"], ["item", "list"]] as const
export const TIMEOUT_MS = 60_000
const MAX_BUFFER = 64 * 1024 * 1024

export type ErrorKind = "token" | "permission" | "timeout" | "cli" | "unknown"

export class ForbiddenCommandError extends Error {
  constructor(command: string) {
    super(`許可されていないサブコマンドです: ${command}`)
    this.name = "ForbiddenCommandError"
  }
}

/** 公式CLIの失敗。標準エラーの全文は保持せず、種別と固定文言だけを持つ */
export class CliError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    /** セッションなし・失効による失敗（再ログインで回復できる） */
    readonly sessionExpired = false,
  ) {
    super(message)
    this.name = "CliError"
  }
}

export const FIXED_MESSAGES: Record<ErrorKind | "vault", string> = {
  token: "Proton Passのアクセストークンが無効か、期限切れです",
  permission: "Proton Passのアクセストークンに権限がありません",
  timeout: "Proton Pass CLIが60秒以内に応答しませんでした",
  cli: "Proton Pass CLIの実行に失敗しました",
  vault: "指定したVaultが見つかりません",
  unknown: "Proton Passの取得に失敗しました",
}

/** 標準エラーの内容から失敗の種別を判定する（実機で確認した文言による） */
export function classify(stderr: string): CliError {
  if (stderr.includes("requires an authenticated client")) return new CliError("unknown", "セッションがありません", true)
  if (stderr.includes("invalid, expired or has been deleted") || stderr.includes("Failed to parse personal access token"))
    return new CliError("token", FIXED_MESSAGES.token)
  if (stderr.includes("NotAllowed")) return new CliError("permission", FIXED_MESSAGES.permission)
  if (stderr.includes("Could not find vault")) return new CliError("cli", FIXED_MESSAGES.vault)
  return new CliError("unknown", FIXED_MESSAGES.unknown)
}

export type CliSettings = { token: string; sessionDir: string; bin?: string; timeoutMs?: number; baseEnv?: NodeJS.ProcessEnv }
export type CliRunner = (args: string[]) => Promise<{ stdout: string; durationMs: number }>

/** 公式CLIへ渡す環境変数は固定の集合のみ（アプリの他の秘匿値を渡さない） */
export function cliEnv(s: CliSettings): NodeJS.ProcessEnv {
  const base = s.baseEnv ?? process.env
  return {
    PATH: base.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: base.HOME ?? "/tmp",
    PROTON_PASS_PERSONAL_ACCESS_TOKEN: s.token,
    PROTON_PASS_KEY_PROVIDER: "fs",
    PROTON_PASS_SESSION_DIR: s.sessionDir,
    PROTON_PASS_DISABLE_TELEMETRY: "1",
    PROTON_PASS_NO_UPDATE_CHECK: "1",
  }
}

export const isAllowed = (args: readonly string[]): boolean => ALLOWED.some(a => a.every((w, i) => args[i] === w))

export function createCliRunner(s: CliSettings): CliRunner {
  const timeoutMs = s.timeoutMs ?? TIMEOUT_MS
  return args => {
    if (!isAllowed(args)) return Promise.reject(new ForbiddenCommandError(args[0] ?? ""))
    const start = performance.now()
    return new Promise((resolve, reject) => {
      execFile(
        s.bin ?? "pass-cli",
        args,
        { env: cliEnv(s), timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_BUFFER, encoding: "utf8" },
        (err, stdout, stderr) => {
          const durationMs = Math.round(performance.now() - start)
          if (!err) return resolve({ stdout, durationMs })
          const e = err as NodeJS.ErrnoException & { killed?: boolean }
          if (e.killed || durationMs >= timeoutMs) return reject(new CliError("timeout", FIXED_MESSAGES.timeout))
          if (e.code === "ENOENT") return reject(new CliError("cli", "Proton Pass CLIが見つかりません"))
          reject(classify(String(stderr)))
        },
      )
    })
  }
}
