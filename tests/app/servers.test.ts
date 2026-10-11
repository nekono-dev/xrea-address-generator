import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, test } from "vitest"
import { buildApi } from "../../src/app/api"
import { ConfigError, loadAppConfig } from "../../src/app/config"
import { DEFAULT_SERVERS, parseServers } from "../../src/app/servers"
import { silentLogger } from "../../src/shared/logger"
import { ENV } from "./helpers"

const tmp = (text: string) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "srv-")), "servers.json")
  fs.writeFileSync(f, text)
  return f
}
const read = (p: string) => fs.readFileSync(p, "utf8")
const servers = async (env: Record<string, string>) => {
  const app = await buildApi(loadAppConfig({ ...ENV, ...env }, { readFile: read }), { gateway: async () => new Response(null, { status: 500 }), log: silentLogger })
  return app.request("/api/servers")
}

describe("サーバ名の一覧", () => {
  test("alias-service/AC-19: 登録していない状態で問い合わせが200になり、組み込みの一覧にXREAのログイン画面と同じサーバ名が含まれる", async () => {
    const res = await servers({})
    expect(res.status).toBe(200)
    const list = (await res.json()).servers as string[]
    // XREAのログイン画面（https://cp.xrea.com/account/login/）のサーバの選択肢から取得した内容
    for (const s of ["s1.xrea.com", "s10.xrea.com", "s1010.xrea.com", "g1.xrea.com", "k2.xrea.com", "m4.xrea.com", "s2010.xrea.com"]) expect(list).toContain(s)
    expect(list).not.toContain("s84.xrea.com") // 欠番
    expect(list.length).toBeGreaterThan(300)
    expect(new Set(list).size).toBe(list.length)
    expect(list).toEqual(DEFAULT_SERVERS)
  })

  test("alias-service/AC-20: 設定ファイルを指定するとファイルの内容が返り、形式が不正なときは設定の読み込みが失敗する", async () => {
    const f = tmp(JSON.stringify({ servers: ["s1.xrea.com", "x9.example.net", "s1.xrea.com"] }))
    expect((await (await servers({ XREA_SERVERS_FILE: f })).json()).servers).toEqual(["s1.xrea.com", "x9.example.net"])
    for (const bad of ["{", "{}", '{"servers":[]}', '{"servers":[1]}', '{"servers":["a b"]}', '{"servers":["../x"]}']) {
      expect(() => loadAppConfig({ ...ENV, XREA_SERVERS_FILE: tmp(bad) }, { readFile: read }), bad).toThrow(ConfigError)
    }
    expect(() => loadAppConfig({ ...ENV, XREA_SERVERS_FILE: "/nonexistent/x.json" }, { readFile: read })).toThrow(ConfigError)
    // ファイルを読めない実行環境（Workers）では、指定を拒否する
    expect(() => loadAppConfig({ ...ENV, XREA_SERVERS_FILE: f })).toThrow(ConfigError)
    expect(parseServers('{"servers":["a.b"]}')).toEqual(["a.b"])
  })
})
