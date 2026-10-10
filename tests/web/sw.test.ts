import { afterEach, describe, expect, test, vi } from "vitest"
import { isShell, NAV_TIMEOUT_MS, networkFirst, referencedAssets, route, staleAssets } from "../../web/src/sw/core"

const ORIGIN = "https://alias.example"
const html = (body = "") => new Response(`<!doctype html>${body}`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
/** 転送の応答（navigation の fetch は redirect: manual のため opaqueredirect になる） */
const opaqueRedirect = () => {
  const r = new Response(null, { status: 200 })
  Object.defineProperty(r, "type", { value: "opaqueredirect" })
  Object.defineProperty(r, "status", { value: 0 })
  return r
}

afterEach(() => vi.useRealTimers())

describe("要求の振り分け", () => {
  const r = (path: string, method = "GET", mode = "cors", origin = ORIGIN) => route(new URL(path, origin), method, mode, ORIGIN)

  test("web-pwa/AC-4: APIと死活確認とService Worker自身の要求は横取りせず、通常の通信に任せる", () => {
    expect(r("/api/aliases")).toBe("network")
    expect(r("/api/aliases/a%40b.c", "PATCH")).toBe("network")
    expect(r("/api/options", "GET", "navigate")).toBe("network")
    expect(r("/healthz")).toBe("network")
    expect(r("/sw.js")).toBe("network")
    expect(r("/", "POST", "navigate")).toBe("network")
    expect(r("/x.js", "GET", "cors", "https://other.example")).toBe("network")
  })

  test("画面の遷移・版を含む画面ファイル・その他のファイルを振り分ける", () => {
    expect(r("/", "GET", "navigate")).toBe("navigate")
    expect(r("/some/route", "GET", "navigate")).toBe("navigate")
    expect(r("/assets/main-abc.js")).toBe("asset")
    expect(r("/icons/icon-192.png")).toBe("static")
    expect(r("/manifest.webmanifest")).toBe("static")
  })
})

describe("参照ファイルの抽出と削除の対象", () => {
  const page = '<script type="module" crossorigin src="/assets/main-new.js"></script><link rel="stylesheet" crossorigin href="/assets/main-new.css"><link rel="icon" href="/icons/icon-192.png">'

  test("入口が参照する /assets/ のパスだけを抽出する", () => {
    expect(referencedAssets(page)).toEqual(["/assets/main-new.js", "/assets/main-new.css"])
  })

  test("web-pwa/AC-6: 新しい版の入口から参照されない画面ファイルが、削除の対象になる", () => {
    const cached = ["/", "/assets/main-old.js", "/assets/main-new.js", "/assets/main-old.css", "/assets/main-new.css", "/icons/icon-192.png"]
    expect(staleAssets(cached, page)).toEqual(["/assets/main-old.js", "/assets/main-old.css"])
  })
})

describe("通信優先の取得", () => {
  test("200 の HTML だけを入口として保存する", () => {
    expect(isShell(html())).toBe(true)
    expect(isShell(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }))).toBe(false)
    expect(isShell(new Response("x", { status: 403, headers: { "content-type": "text/html" } }))).toBe(false)
    expect(isShell(opaqueRedirect())).toBe(false)
  })

  test("通信が成功すれば通信の応答を返し、入口として保存する", async () => {
    const saved: string[] = []
    const res = await networkFirst({ fetch: async () => html("new"), cached: async () => html("old"), save: async r => void saved.push(await r.text()) })
    expect(await res.text()).toContain("new")
    expect(saved).toEqual(["<!doctype html>new"])
  })

  test("web-pwa/AC-5: 入口の要求が外部への転送の応答を返すと、保存した画面ではなく転送の応答がそのまま返る", async () => {
    const save = vi.fn(async () => undefined)
    const redirect = opaqueRedirect()
    const res = await networkFirst({ fetch: async () => redirect, cached: async () => html("old"), save })
    expect(res).toBe(redirect)
    expect(save).not.toHaveBeenCalled()
    // 認証の要求（401・403）も保存せずにそのまま返す
    const denied = new Response("denied", { status: 403, headers: { "content-type": "text/html" } })
    expect(await networkFirst({ fetch: async () => denied, cached: async () => html("old"), save })).toBe(denied)
    expect(save).not.toHaveBeenCalled()
  })

  test("通信に失敗したときは保存した入口を返し、保存が無ければ失敗をそのまま返す", async () => {
    const fail = async () => {
      throw new TypeError("Failed to fetch")
    }
    expect(await (await networkFirst({ fetch: fail, cached: async () => html("old"), save: async () => undefined })).text()).toContain("old")
    await expect(networkFirst({ fetch: fail, cached: async () => undefined, save: async () => undefined })).rejects.toThrow("Failed to fetch")
  })

  test("web-pwa/AC-9: 画面の入口の応答が3秒を超えて返らないとき、3秒時点で保存した入口が返り、後から届いた応答で保存を更新する", async () => {
    vi.useFakeTimers()
    let resolveNet!: (r: Response) => void
    const saved: string[] = []
    const p = networkFirst({
      fetch: () => new Promise<Response>(r => (resolveNet = r)),
      cached: async () => html("old"),
      save: async r => void saved.push(await r.text()),
    })
    let settled: Response | undefined
    void p.then(r => (settled = r))
    await vi.advanceTimersByTimeAsync(NAV_TIMEOUT_MS - 1)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(await settled!.text()).toContain("old")
    resolveNet(html("late"))
    await vi.runAllTimersAsync()
    expect(saved).toEqual(["<!doctype html>late"])
  })
})
