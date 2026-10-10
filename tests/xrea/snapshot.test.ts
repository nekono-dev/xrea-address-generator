import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { BASE, diffAgainstSnapshot, digest, fileOf, PAGES, runCheck, runSnapshot, type Fetcher } from "../../scripts/xrea-docs/fetch"

/** ページ名 -> 本文 の対応から、疑似の取得関数を作る */
const fakeFetcher = (bodies: Record<string, string>, failPage?: string): Fetcher => async url => {
  const page = url.slice(BASE.length + 1)
  if (page === failPage) return { ok: false, status: 503, text: async () => "" }
  return { ok: true, status: 200, text: async () => bodies[page] ?? "" }
}
const bodies = Object.fromEntries(PAGES.map(p => [p, `<p>${p}</p>`]))

function tmpSnapshot(content: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xrea-snap-"))
  for (const [page, html] of Object.entries(content)) fs.writeFileSync(path.join(dir, fileOf(page)), html)
  return dir
}

describe("基準との差分検知", () => {
  test("xrea-client/AC-8: 基準と異なるページがあるとき、そのページ名を表示して終了コード1で終了する", async () => {
    const changed = PAGES[1]
    const dir = tmpSnapshot({ ...bodies, [changed]: "<p>以前の内容</p>" })
    const lines: string[] = []
    const code = await runCheck({ fetcher: fakeFetcher(bodies), dir, log: l => lines.push(l) })
    expect(code).toBe(1)
    expect(lines).toEqual([`差分あり: ${changed}`])
  })

  test("差分が無いときは終了コード0", async () => {
    const dir = tmpSnapshot(bodies)
    const lines: string[] = []
    expect(await runCheck({ fetcher: fakeFetcher(bodies), dir, log: l => lines.push(l) })).toBe(0)
    expect(lines).toEqual(["差分なし"])
  })

  test("空白の連続だけが異なる場合は差分としない", () => {
    expect(digest("<p>a  b\n</p>")).toBe(digest("<p>a b </p>"))
    const now = new Map(PAGES.map(p => [p, `<p> ${p} </p>`]))
    const snap = new Map(PAGES.map(p => [p, `<p>\n${p}\n</p>`]))
    expect(diffAgainstSnapshot(now, snap)).toEqual([])
  })

  test("取得に失敗したときは、ページ名を表示して基準を上書きしない", async () => {
    const dir = tmpSnapshot(bodies)
    const before = fs.readFileSync(path.join(dir, fileOf(PAGES[0])), "utf8")
    const lines: string[] = []
    const code = await runSnapshot({ fetcher: fakeFetcher({ [PAGES[0]]: "<p>新</p>" }, PAGES[2]), dir, log: l => lines.push(l) })
    expect(code).toBe(1)
    expect(lines[0]).toContain(PAGES[2])
    expect(fs.readFileSync(path.join(dir, fileOf(PAGES[0])), "utf8")).toBe(before)
  })
})
