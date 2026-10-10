// 公式ドキュメントの取得、基準（スナップショット）の保存、差分検知を行う。
// 使い方: tsx scripts/xrea-docs/fetch.ts <check|snapshot>
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const BASE = "https://apidoc.xrea.com"
export const PAGES = [
  "mail/2017/07/19/mail-list.html",
  "mail/2017/07/19/mail-edit.html",
  "mail/2017/07/19/mail-delete.html",
] as const

export const SNAPSHOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../api/snapshot")

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>
export type Log = (line: string) => void

/** ページ名から基準のファイル名を作る */
export const fileOf = (page: string): string => page.replaceAll("/", "_")

/** 空白の連続を1つにまとめ、比較に影響しない差を取り除く */
export const normalize = (html: string): string => html.replace(/\s+/g, " ").trim()

export const digest = (html: string): string => crypto.createHash("sha256").update(normalize(html)).digest("hex")

/** 全ページを取得する。1ページでも失敗したら、そのページ名を示して例外を送出する */
export async function fetchPages(fetcher: Fetcher = fetch): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const page of PAGES) {
    let res
    try {
      res = await fetcher(`${BASE}/${page}`)
    } catch (e) {
      throw new Error(`取得に失敗しました: ${page}（${(e as Error).message}）`)
    }
    if (!res.ok) throw new Error(`取得に失敗しました: ${page}（HTTP ${res.status}）`)
    out.set(page, await res.text())
  }
  return out
}

export function readSnapshot(dir: string = SNAPSHOT_DIR): Map<string, string> {
  const out = new Map<string, string>()
  for (const page of PAGES) {
    const file = path.join(dir, fileOf(page))
    if (fs.existsSync(file)) out.set(page, fs.readFileSync(file, "utf8"))
  }
  return out
}

/** 基準と内容が異なる（または基準に無い）ページ名を返す */
export function diffAgainstSnapshot(now: Map<string, string>, snapshot: Map<string, string>): string[] {
  return PAGES.filter(page => {
    const a = now.get(page)
    const b = snapshot.get(page)
    return a === undefined || b === undefined || digest(a) !== digest(b)
  })
}

/** 差分検知。差分なしなら 0、差分ありまたは取得失敗なら 1 を返す */
export async function runCheck(opts: { fetcher?: Fetcher; dir?: string; log?: Log } = {}): Promise<number> {
  const log = opts.log ?? console.log
  let now
  try {
    now = await fetchPages(opts.fetcher)
  } catch (e) {
    log((e as Error).message)
    return 1
  }
  const changed = diffAgainstSnapshot(now, readSnapshot(opts.dir))
  if (changed.length === 0) {
    log("差分なし")
    return 0
  }
  for (const page of changed) log(`差分あり: ${page}`)
  return 1
}

/** 基準の保存。全ページの取得に成功したときだけ書き込む */
export async function runSnapshot(opts: { fetcher?: Fetcher; dir?: string; log?: Log } = {}): Promise<number> {
  const log = opts.log ?? console.log
  const dir = opts.dir ?? SNAPSHOT_DIR
  let now
  try {
    now = await fetchPages(opts.fetcher)
  } catch (e) {
    log((e as Error).message)
    return 1
  }
  fs.mkdirSync(dir, { recursive: true })
  for (const [page, html] of now) fs.writeFileSync(path.join(dir, fileOf(page)), html)
  log(`基準を保存しました: ${now.size}ページ`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const mode = process.argv[2]
  if (mode === "check") process.exitCode = await runCheck()
  else if (mode === "snapshot") process.exitCode = await runSnapshot()
  else {
    console.error("使い方: tsx scripts/xrea-docs/fetch.ts <check|snapshot>")
    process.exitCode = 2
  }
}
