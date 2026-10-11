import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { CachedReader, DisabledReader, TTL_MS, type Status } from "../../src/proton/cache"
import { CliError, FIXED_MESSAGES, type CliRunner } from "../../src/proton/cli"
import { createProtonReader, loadProtonConfig } from "../../src/proton/index"
import { Session } from "../../src/proton/session"
import { vaultsJson, withVaults } from "./helpers"

const fixture = fs.readFileSync(path.join(__dirname, "../fixtures/proton-items.json"), "utf8")
const silent = { info: () => undefined, warn: () => undefined }

/** アイテム数を指定して、取得結果の文字列を作る */
const itemsJson = (n: number, tag = "") =>
  JSON.stringify({
    items: Array.from({ length: n }, (_, i) => ({
      state: "Active",
      content: { title: `title${tag}-${i}`, content: { Login: { username: `user${i}@example.com`, email: "", password: "pw" } } },
    })),
  })

function setup(opts: { run?: CliRunner; now?: () => number } = {}) {
  let calls = 0
  const run: CliRunner = withVaults(
    opts.run ??
      (async args => {
        if (args[0] === "item") calls++
        return { stdout: fixture, durationMs: 1 }
      }),
  )
  const reader = new CachedReader({ run, session: new Session(run, "/tmp/unused"), now: opts.now, logger: silent })
  return { reader, calls: () => calls }
}

describe("キャッシュ", () => {
  test("proton-pass-reader/AC-7: 有効期間内の2回目の取得で、公式CLIが呼び出されない", async () => {
    const s = setup()
    await s.reader.refresh()
    expect(s.calls()).toBe(1)
    s.reader.getMap()
    s.reader.getMap()
    expect(s.calls()).toBe(1)
  })

  test("proton-pass-reader/AC-13: 600秒が経過した後の取得で、再取得が開始される", async () => {
    expect(TTL_MS).toBe(600_000)
    let t = 0
    const s = setup({ now: () => t })
    await s.reader.refresh()
    t = TTL_MS - 1
    s.reader.getMap()
    expect(s.calls()).toBe(1)
    t = TTL_MS
    s.reader.getMap()
    await s.reader.refresh() // 開始済みの再取得に合流して完了を待つ
    expect(s.calls()).toBe(2)
  })

  test("proton-pass-reader/AC-8: 再取得の実行中に取得した対応表が、再取得前の内容になる", async () => {
    let release!: () => void
    let round = 0
    const run: CliRunner = async () => {
      round++
      if (round === 1) return { stdout: itemsJson(1, "old"), durationMs: 1 }
      await new Promise<void>(r => (release = r))
      return { stdout: itemsJson(1, "new"), durationMs: 1 }
    }
    const { reader } = setup({ run })
    await reader.refresh()
    const p = reader.refresh()
    await new Promise(r => setTimeout(r, 0)) // Vault一覧の取得を終え、アイテムの取得で待機するまで進める
    expect(reader.getStatus().state).toBe("loading")
    expect(reader.getMap().get("user0@example.com")).toEqual(["titleold-0"])
    release()
    await p
    expect(reader.getMap().get("user0@example.com")).toEqual(["titlenew-0"])
  })

  test("再取得の要求が重なっても、公式CLIの同時実行は1件に保たれる", async () => {
    const s = setup()
    await Promise.all([s.reader.refresh(), s.reader.refresh(), s.reader.refresh()])
    expect(s.calls()).toBe(1)
  })
})

describe("状態と再ログイン", () => {
  test("proton-pass-reader/AC-9: セッション失効の後に再ログインと再取得が行われ、再ログイン中を経て準備完了になり、時刻が記録される", async () => {
    const seen: string[] = []
    let first = true
    let reader!: CachedReader
    const run: CliRunner = async args => {
      if (args[0] === "login") {
        seen.push(`login:${reader.getStatus().state}`)
        return { stdout: "", durationMs: 1 }
      }
      if (first) {
        first = false
        throw new CliError("unknown", "セッションがありません", true)
      }
      return { stdout: fixture, durationMs: 1 }
    }
    const wrapped = withVaults(run)
    reader = new CachedReader({ run: wrapped, session: new Session(wrapped, fs.mkdtempSync("/tmp/proton-")), logger: silent })
    await reader.refresh()
    expect(seen).toEqual(["login:relogin"])
    const s: Status = reader.getStatus()
    expect(s.state).toBe("ready")
    expect(s.reloginAt).not.toBeNull()
    expect(s.reloginAt).toBe(s.updatedAt)
  })

  test("proton-pass-reader/AC-10: 再取得中の状態取得は取得中を返し、完了後は最終更新時刻と参照件数を返す", async () => {
    let release!: () => void
    const run: CliRunner = async () => {
      await new Promise<void>(r => (release = r))
      return { stdout: fixture, durationMs: 1 }
    }
    const { reader } = setup({ run })
    expect(reader.getStatus()).toMatchObject({ state: "loading", updatedAt: null, itemCount: null })
    const p = reader.refresh()
    await new Promise(r => setTimeout(r, 0))
    expect(reader.getStatus().state).toBe("loading")
    release()
    await p
    const s = reader.getStatus()
    expect(s.state).toBe("ready")
    expect(s.itemCount).toBe(6)
    expect(Date.parse(s.updatedAt!)).not.toBeNaN()
    expect(s.error).toBeNull()
  })

  test("proton-pass-reader/AC-14: 応答しない公式CLIが打ち切られた後、状態がエラーになり直前の対応表を保持する", async () => {
    let round = 0
    const run: CliRunner = async () => {
      if (round++ === 0) return { stdout: fixture, durationMs: 1 }
      throw new CliError("timeout", "Proton Pass CLIが60秒以内に応答しませんでした")
    }
    const { reader } = setup({ run })
    await reader.refresh()
    await reader.refresh()
    const s = reader.getStatus()
    expect(s.state).toBe("error")
    expect(s.error).toEqual({ kind: "timeout", message: "Proton Pass CLIが60秒以内に応答しませんでした" })
    expect(reader.getMap().size).toBe(2)
  })

  test("再ログインにも失敗したとき、状態は error になり直前の対応表を保持する", async () => {
    let round = 0
    const run: CliRunner = async args => {
      if (args[0] === "login") throw new CliError("token", "Proton Passのアクセストークンが無効か、期限切れです")
      if (round++ === 0) return { stdout: fixture, durationMs: 1 }
      throw new CliError("unknown", "セッションがありません", true)
    }
    const { reader } = setup({ run })
    await reader.refresh()
    await reader.refresh()
    expect(reader.getStatus()).toMatchObject({ state: "error", error: { kind: "token" } })
    expect(reader.getMap().size).toBe(2)
  })
})

describe("性能", () => {
  test("proton-pass-reader/AC-11: 300件のアイテムを持つ一覧の再取得が、30秒以内に完了する", async () => {
    const json = itemsJson(300)
    const { reader } = setup({ run: async () => ({ stdout: json, durationMs: 1 }) })
    const start = performance.now()
    await reader.refresh()
    expect(performance.now() - start).toBeLessThan(30_000)
    expect(reader.getMap().size).toBe(300)
  })

  test("proton-pass-reader/AC-12: キャッシュが有効なときの対応表の取得が、50ミリ秒以内に完了する", async () => {
    const { reader } = setup({ run: async () => ({ stdout: itemsJson(300), durationMs: 1 }) })
    await reader.refresh()
    const start = performance.now()
    const map = reader.getMap()
    expect(performance.now() - start).toBeLessThan(50)
    expect(map.size).toBe(300)
  })
})

describe("Vaultの探索と連携の無効化", () => {
  test("proton-pass-reader/AC-15: トークンで参照できる複数のVaultのアイテムが、1つの対応表にまとまる", async () => {
    const calls: string[][] = []
    const run: CliRunner = async args => {
      calls.push(args)
      const i = args.indexOf("--share-id")
      return { stdout: i < 0 ? vaultsJson(3) : itemsJson(1, args[i + 1]), durationMs: 1 }
    }
    const session = new Session(run, "/tmp/unused")
    const reader = new CachedReader({ run, session, logger: silent })
    await reader.refresh()
    expect(calls[0]).toEqual(["vault", "list", "--output", "json"])
    expect(calls.slice(1).map(a => a[a.indexOf("--share-id") + 1])).toEqual(["s0", "s1", "s2"])
    expect(calls.every(a => !a.includes("--vault-name"))).toBe(true)
    // 3つのVaultが同じアドレスを持つので、エントリ名が昇順で3件並ぶ
    expect(reader.getMap().get("user0@example.com")).toEqual(["titles0-0", "titles1-0", "titles2-0"])
    expect(reader.getStatus()).toMatchObject({ state: "ready", itemCount: 3 })
  })

  test("参照できるVaultが無いとき、空の対応表で準備完了になる", async () => {
    const run: CliRunner = async () => ({ stdout: vaultsJson(0), durationMs: 1 })
    const reader = new CachedReader({ run, session: new Session(run, "/tmp/unused"), logger: silent })
    await reader.refresh()
    expect(reader.getMap().size).toBe(0)
    expect(reader.getStatus()).toMatchObject({ state: "ready", itemCount: 0 })
  })

  test("proton-pass-reader/AC-16: アクセストークンが未設定なら連携が無効になり、公式CLIが起動されない", async () => {
    expect(loadProtonConfig({})).toBeNull()
    expect(loadProtonConfig({ PROTON_PASS_PERSONAL_ACCESS_TOKEN: "" })).toBeNull()
    expect(loadProtonConfig({ PROTON_PASS_PERSONAL_ACCESS_TOKEN: "t" })).toEqual({ token: "t", sessionDir: "/var/lib/xrea-address-generator/session" })
    const bin = path.join(fs.mkdtempSync("/tmp/proton-bin-"), "pass-cli")
    fs.writeFileSync(`${bin}.called`, "no")
    fs.writeFileSync(bin, `#!/bin/sh\necho yes > ${bin}.called\n`, { mode: 0o755 })
    const reader = createProtonReader(null, { bin })
    expect(reader).toBeInstanceOf(DisabledReader)
    await reader.refresh()
    expect(reader.getMap().size).toBe(0)
    expect(reader.getStatus()).toEqual({ state: "disabled", updatedAt: null, reloginAt: null, itemCount: null, error: null })
    await new Promise(r => setTimeout(r, 50))
    expect(fs.readFileSync(`${bin}.called`, "utf8").trim()).toBe("no")
  })
})

describe("取得に失敗した後", () => {
  test("proton-pass-reader/AC-17: 取得に失敗した後は有効期間が過ぎても自動で再取得せず、無効なトークンでは差し替えを求める文言になる", async () => {
    let t = 0
    let round = 0
    const run: CliRunner = async args => {
      if (args[0] === "login") throw new CliError("token", FIXED_MESSAGES.token)
      if (round++ === 0) return { stdout: fixture, durationMs: 1 }
      throw new CliError("unknown", "セッションがありません", true)
    }
    const { reader } = setup({ run, now: () => t })
    await reader.refresh()
    t = TTL_MS
    await reader.refresh() // 失敗する
    expect(reader.getStatus().state).toBe("error")
    expect(reader.getStatus().error!.message).toContain("トークンを差し替えて")
    const before = round
    t = TTL_MS * 5
    reader.getMap()
    reader.getMap()
    await new Promise(r => setTimeout(r, 20))
    expect(round).toBe(before) // 公式CLIは呼び出されない
    expect(reader.getStatus().state).toBe("error")
  })
})
