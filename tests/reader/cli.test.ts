import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { classify, cliEnv, CliError, createCliRunner, ForbiddenCommandError, isAllowed } from "../../src/reader/cli"
import { Session } from "../../src/reader/session"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "proton-cli-"))

/** 呼び出しを記録する疑似の公式CLI（シェルスクリプト）を作る */
function fakeBin(body: string): { bin: string; log: string } {
  const dir = tmp()
  const log = path.join(dir, "calls.log")
  const bin = path.join(dir, "pass-cli")
  fs.writeFileSync(bin, `#!/bin/sh\necho "$*" >> "${log}"\nenv >> "${log}.env"\n${body}\n`, { mode: 0o755 })
  return { bin, log }
}

describe("公式CLIの実行", () => {
  test("proton-pass-reader/AC-5: 許可されていないサブコマンドの実行要求が拒否され、公式CLIは起動されない", async () => {
    const f = fakeBin("exit 0")
    const run = createCliRunner({ token: "t", sessionDir: tmp(), bin: f.bin })
    for (const args of [["item", "create", "login"], ["item", "delete"], ["item", "update"], ["vault", "create"], ["vault", "delete"], ["logout"], ["item"], ["vault"]]) {
      await expect(run(args)).rejects.toBeInstanceOf(ForbiddenCommandError)
    }
    expect(fs.existsSync(f.log)).toBe(false)
    expect(isAllowed(["item", "list", "--share-id", "s"])).toBe(true)
    expect(isAllowed(["vault", "list", "--output", "json"])).toBe(true)
  })

  test("公式CLIへ渡す環境変数は固定の集合のみで、他の秘匿値を渡さない", async () => {
    const f = fakeBin("exit 0")
    const sessionDir = tmp()
    const run = createCliRunner({ token: "pst_x::y", sessionDir, bin: f.bin, baseEnv: { PATH: process.env.PATH, HOME: "/h", XREA_API_SECRET_KEY: "LEAK" } })
    await run(["info"])
    const env = fs.readFileSync(`${f.log}.env`, "utf8")
    expect(env).toContain("PROTON_PASS_PERSONAL_ACCESS_TOKEN=pst_x::y")
    expect(env).toContain(`PROTON_PASS_SESSION_DIR=${sessionDir}`)
    expect(env).toContain("PROTON_PASS_KEY_PROVIDER=fs")
    expect(env).not.toContain("LEAK")
    expect(Object.keys(cliEnv({ token: "t", sessionDir: "/s", baseEnv: {} })).sort()).toEqual(
      ["HOME", "PATH", "PROTON_PASS_DISABLE_TELEMETRY", "PROTON_PASS_KEY_PROVIDER", "PROTON_PASS_NO_UPDATE_CHECK", "PROTON_PASS_PERSONAL_ACCESS_TOKEN", "PROTON_PASS_SESSION_DIR"].sort(),
    )
  })

  test("応答しない公式CLIは打ち切られ、kind=timeout の失敗になる", async () => {
    const f = fakeBin("sleep 5")
    const run = createCliRunner({ token: "t", sessionDir: tmp(), bin: f.bin, timeoutMs: 200 })
    const start = performance.now()
    const err = await run(["info"]).catch(e => e)
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).kind).toBe("timeout")
    expect(performance.now() - start).toBeLessThan(2000)
  })

  test("実機で確認した標準エラーの文言から、失敗の種別を判定する", () => {
    expect(classify("Error: This operation requires an authenticated client").sessionExpired).toBe(true)
    expect(classify("1: This personal access token is invalid, expired or has been deleted.").kind).toBe("token")
    expect(classify("0: Failed to parse personal access token token").kind).toBe("token")
    expect(classify("Could not perform operation. Reason: NotAllowed").kind).toBe("permission")
    expect(classify("something else").kind).toBe("unknown")
    // 標準エラーの全文はメッセージに含めない
    expect(classify("secret-detail NotAllowed").message).not.toContain("secret-detail")
  })
})

describe("ログインと再ログイン", () => {
  test("proton-pass-reader/AC-1: 環境変数のトークンでログインし、セッションの保存先を指定のディレクトリに作る", async () => {
    const f = fakeBin('[ "$1" = login ] && touch "$PROTON_PASS_SESSION_DIR/session" ; exit 0')
    const sessionDir = path.join(tmp(), "session")
    const run = createCliRunner({ token: "pst_token::key", sessionDir, bin: f.bin })
    await new Session(run, sessionDir).login()
    expect(fs.statSync(sessionDir).mode & 0o777).toBe(0o700)
    expect(fs.existsSync(path.join(sessionDir, "session"))).toBe(true)
    expect(fs.readFileSync(`${f.log}.env`, "utf8")).toContain("PROTON_PASS_PERSONAL_ACCESS_TOKEN=pst_token::key")
  })

  test("セッション失効のときだけ再ログインし、処理を1回だけ再試行する", async () => {
    const calls: string[] = []
    let n = 0
    const run = async (args: string[]) => {
      calls.push(args.join(" "))
      return { stdout: "", durationMs: 0 }
    }
    const session = new Session(run, tmp())
    let relogins = 0
    const result = await session.withSession(
      async () => {
        if (n++ === 0) throw new CliError("unknown", "セッションがありません", true)
        return "ok"
      },
      () => relogins++,
    )
    expect(result).toBe("ok")
    expect(relogins).toBe(1)
    expect(calls).toEqual(["login"])
    // セッション以外の失敗では再ログインしない
    await expect(session.withSession(async () => Promise.reject(new CliError("token", "x")), () => relogins++)).rejects.toThrow("x")
    expect(relogins).toBe(1)
  })
})

describe.runIf(process.env.PROTON_LIVE === "1")("実際の公式CLI", () => {
  test("proton-pass-reader/AC-1: 環境変数のトークンでログインでき、セッションが指定のディレクトリに保存される", async () => {
    const sessionDir = path.join(tmp(), "session")
    const run = createCliRunner({ token: process.env.PROTON_PASS_PERSONAL_ACCESS_TOKEN!, sessionDir })
    await new Session(run, sessionDir).login()
    expect(fs.readdirSync(sessionDir).length).toBeGreaterThan(0)
    await expect(run(["info"])).resolves.toBeDefined()
  }, 60_000)
})
