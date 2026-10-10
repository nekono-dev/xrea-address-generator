import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { CachedReader, type Logger } from "../../src/proton/cache"
import { project } from "../../src/proton/projection"
import { Session } from "../../src/proton/session"

const fixture = fs.readFileSync(path.join(__dirname, "../fixtures/proton-items.json"), "utf8")

describe("対応表への変換", () => {
  test("proton-pass-reader/AC-2: ログイン以外の種別とゴミ箱のアイテムを含む一覧から、有効なログインアイテムだけが反映される", () => {
    const { map, itemCount } = project(fixture)
    expect(itemCount).toBe(6)
    expect([...map.keys()].sort()).toEqual(["shop@example.com", "sns@example.com"])
    expect(map.has("trash@example.com")).toBe(false)
    const titles = [...map.values()].flat()
    expect(titles).not.toContain("メモ帳")
    expect(titles).not.toContain("Protonのエイリアス")
  })

  test("proton-pass-reader/AC-3: ユーザー名に大文字を含むアイテムが、小文字のアドレスで現れる", () => {
    const { map } = project(fixture)
    expect(map.get("sns@example.com")).toContain("X (Twitter)") // メールアドレスが SNS@Example.com のアイテム
  })

  test("proton-pass-reader/AC-4: 同一アドレスの2件のアイテムのエントリ名が、昇順で並んで保持される", () => {
    const { map } = project(fixture)
    expect(map.get("sns@example.com")).toEqual(["Bluesky", "X (Twitter)"])
    // ユーザー名とメールアドレスが同じアイテムは1回だけ数える
    expect(map.get("sns@example.com")!.filter(t => t === "Bluesky")).toHaveLength(1)
  })

  test("proton-pass-reader/AC-5: パスワードを含む取得結果の処理後、対応表とログの出力にそのパスワード文字列が含まれない", async () => {
    const lines: string[] = []
    const logger: Logger = { info: o => lines.push(JSON.stringify(o)), warn: o => lines.push(JSON.stringify(o)) }
    const run = async () => ({ stdout: fixture, durationMs: 5 })
    const reader = new CachedReader({ run, session: new Session(run, "/tmp/unused"), vault: "v", logger })
    await reader.refresh()
    const dumped = JSON.stringify([...reader.getMap()]) + JSON.stringify(reader.getStatus()) + lines.join("\n")
    for (const secret of ["FIXTURE-SECRET", "FIXTURE-NOTE", "FIXTURE-TOTP", "https://i1.example"]) expect(dumped).not.toContain(secret)
    expect(lines.join("\n")).toContain('"itemCount":6')
  })
})
