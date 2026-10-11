// XREAのサーバ名の一覧の読み込みと検証。既定の一覧はビルド時に埋め込まれる。
import { ConfigError } from "../credentials/config"
import defaults from "../../config/xrea-servers.json"

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i

/** `{ "servers": [...] }` の形式。形式が不正なら ConfigError。重複を除き、順序を保つ */
export function parseServers(text: string, source = "サーバ名の一覧"): string[] {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ConfigError(`${source}がJSONではありません`)
  }
  const list = (json as { servers?: unknown } | null)?.servers
  if (!Array.isArray(list) || list.length === 0) throw new ConfigError(`${source}の servers は空でない配列にしてください`)
  for (const v of list) if (typeof v !== "string" || !HOST_RE.test(v)) throw new ConfigError(`${source}に不正なサーバ名があります`)
  return [...new Set(list as string[])]
}

export const DEFAULT_SERVERS: string[] = parseServers(JSON.stringify(defaults), "組み込みのサーバ名の一覧")

/** XREA_SERVERS_FILE があればそのファイルを読み、無ければ組み込みの一覧を返す */
export function loadServers(env: Record<string, string | undefined>, read?: (path: string) => string): string[] {
  const file = (env.XREA_SERVERS_FILE ?? "").trim()
  if (!file) return DEFAULT_SERVERS
  if (!read) throw new ConfigError("この実行環境では XREA_SERVERS_FILE を使えません")
  let text: string
  try {
    text = read(file)
  } catch {
    throw new ConfigError(`XREA_SERVERS_FILE を読めません: ${file}`)
  }
  return parseServers(text, file)
}
