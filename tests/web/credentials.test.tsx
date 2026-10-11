// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact"
import { afterEach, describe, expect, test, vi } from "vitest"
import { App } from "../../web/src/App"
import { canRegister } from "../../web/src/credentials"
import { createStore } from "../../web/src/store"
import { fakeServer } from "./helpers"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const missing = { status: 200, body: { registered: false } }
const input = (c: Element, name: string) => c.querySelector(`input[name="${name}"]`) as HTMLInputElement
const type = (c: Element, name: string, value: string) => fireEvent.input(input(c, name), { target: { value } })
const fill = (c: Element) => {
  type(c, "server", "s1.xrea.com")
  type(c, "username", "acct")
  type(c, "password", "SECRET-KEY-VALUE")
}
const submitBtn = (c: Element) => c.querySelector("#cred-submit") as HTMLButtonElement

async function mountMissing() {
  const server = fakeServer()
  server.overrides["GET /api/credentials"] = () => missing
  const store = createStore()
  const r = render(<App store={store} />)
  await waitFor(() => expect(r.container.querySelector("#credentials")).not.toBeNull())
  return { r, server, store }
}

describe("状態", () => {
  test("web-credentials/AC-1: 未登録の応答を受けると登録画面だけが表示され、一覧と発行フォームの要求が送信されない", async () => {
    const { r, server } = await mountMissing()
    expect(r.container.querySelector("#issue")).toBeNull()
    expect(r.container.querySelector(".row")).toBeNull()
    expect(server.requests.map(q => `${q.method} ${q.url}`)).toEqual(["GET /api/credentials"])
  })

  test("登録状態を問い合わせている間は何も描画しない", async () => {
    const server = fakeServer()
    server.overrides["GET /api/credentials"] = () => new Promise(() => undefined)
    const r = render(<App store={createStore()} />)
    await new Promise(res => setTimeout(res, 20))
    expect(r.container.innerHTML).toBe("")
  })

  test("登録状態の問い合わせが失敗すると、登録画面に通信の失敗が表示される", async () => {
    const server = fakeServer()
    server.overrides["GET /api/credentials"] = () => {
      throw new TypeError("offline")
    }
    const r = render(<App store={createStore()} />)
    await waitFor(() => expect(r.container.querySelector("#credentials")).not.toBeNull())
    expect(r.container.querySelector(".cred-error")!.textContent).toBe("サーバへ接続できません")
  })

  test("web-credentials/AC-7: 一覧の取得が認証情報の登録を求める応答を返すと、期限切れの案内を伴う登録画面に切り替わる", async () => {
    const server = fakeServer()
    server.overrides["GET /api/aliases"] = () => ({ status: 401, body: { error: { code: "credentials_required", message: "認証情報を登録してください" } } })
    const store = createStore()
    const r = render(<App store={store} />)
    await waitFor(() => expect(r.container.querySelector("#credentials")).not.toBeNull())
    expect(r.container.querySelector(".cred-notice")!.textContent).toContain("有効期限が切れました")
    expect(store.get().credential).toBe("expired")
    expect(r.container.querySelector("#cred-cancel")).toBeNull() // 期限切れでは取り消せない
  })
})

describe("パネル", () => {
  test("web-credentials/AC-2: 3項目のいずれかが空のとき登録ボタンが無効で、すべて入力すると有効になる", async () => {
    const { r } = await mountMissing()
    expect(submitBtn(r.container).disabled).toBe(true)
    type(r.container, "server", "s1.xrea.com")
    type(r.container, "username", "acct")
    expect(submitBtn(r.container).disabled).toBe(true)
    type(r.container, "password", "  ")
    expect(submitBtn(r.container).disabled).toBe(true)
    type(r.container, "password", "key")
    expect(submitBtn(r.container).disabled).toBe(false)
    expect(canRegister("a", "b", "")).toBe(false)
  })

  test("web-credentials/AC-3: アカウントの欄がusername、シークレットキーの欄がcurrent-passwordを持ち、フォームの中にそれ以外のパスワード欄がない", async () => {
    const { r } = await mountMissing()
    const form = r.container.querySelector("form")!
    expect(input(form, "username").getAttribute("autocomplete")).toBe("username")
    expect(input(form, "password").getAttribute("autocomplete")).toBe("current-password")
    expect([...form.querySelectorAll("input")].map(i => i.name)).toEqual(["username", "password"])
    expect(form.querySelectorAll("input[type=password]")).toHaveLength(1)
    expect(form.querySelector('button[type="submit"]')).not.toBeNull()
    fireEvent.click(r.container.querySelector("#cred-proton")!)
    expect(form.querySelectorAll("input[type=password]")).toHaveLength(1) // トークンの欄はフォームの外
  })

  test("web-credentials/AC-4: 初期状態でトークンの欄がなく、連携ボタンの押下後に欄が追加され、空のままでも登録の要求が送信される", async () => {
    const { r, server } = await mountMissing()
    server.overrides["PUT /api/credentials"] = () => ({ status: 204 })
    expect(input(r.container, "proton-token")).toBeNull()
    fireEvent.click(r.container.querySelector("#cred-proton")!)
    expect(input(r.container, "proton-token")).not.toBeNull()
    expect(r.container.querySelector("#cred-proton")).toBeNull()
    fill(r.container)
    fireEvent.click(submitBtn(r.container))
    await waitFor(() => expect(server.requests.some(q => q.method === "PUT")).toBe(true))
    expect(server.requests.find(q => q.method === "PUT")!.body).toEqual({ xrea: { account: "acct", serverName: "s1.xrea.com", apiSecretKey: "SECRET-KEY-VALUE" } })
  })

  test("トークンを入力すると、登録の要求に protonToken が載る。トークンの欄でEnterを押しても送信される", async () => {
    const { r, server } = await mountMissing()
    server.overrides["PUT /api/credentials"] = () => ({ status: 204 })
    fireEvent.click(r.container.querySelector("#cred-proton")!)
    fill(r.container)
    type(r.container, "proton-token", " pat-value ")
    fireEvent.keyDown(input(r.container, "proton-token"), { key: "Enter" })
    await waitFor(() => expect(server.requests.some(q => q.method === "PUT")).toBe(true))
    expect(server.requests.find(q => q.method === "PUT")!.body.protonToken).toBe("pat-value")
  })

  test("web-credentials/AC-5: 登録の要求が成功すると、登録画面が消えて一覧と候補の取得の要求が送信される", async () => {
    const { r, server } = await mountMissing()
    server.overrides["PUT /api/credentials"] = () => ({ status: 204 })
    fill(r.container)
    fireEvent.submit(r.container.querySelector("form")!)
    await waitFor(() => expect(r.container.querySelector("#credentials")).toBeNull())
    await waitFor(() => expect(r.container.querySelectorAll(".row").length).toBeGreaterThan(0))
    const urls = server.requests.map(q => `${q.method} ${q.url}`)
    expect(urls).toContain("GET /api/aliases")
    expect(urls).toContain("GET /api/options")
  })

  test("web-credentials/AC-6: 400の応答のメッセージが登録画面の中に表示され、入力した値が残る", async () => {
    const { r, server } = await mountMissing()
    server.overrides["PUT /api/credentials"] = () => ({ status: 400, body: { error: { code: "validation_error", message: "account は必須です" } } })
    fill(r.container)
    fireEvent.submit(r.container.querySelector("form")!)
    await waitFor(() => expect(r.container.querySelector(".cred-error")).not.toBeNull())
    expect(r.container.querySelector(".cred-error")!.textContent).toBe("account は必須です")
    expect(input(r.container, "server").value).toBe("s1.xrea.com")
    expect(input(r.container, "username").value).toBe("acct")
    expect(input(r.container, "password").value).toBe("SECRET-KEY-VALUE")
    // 認証情報の誤りは固定の文言
    server.overrides["PUT /api/credentials"] = () => ({ status: 400, body: { error: { code: "invalid_credentials", message: "x" } } })
    fireEvent.submit(r.container.querySelector("form")!)
    await waitFor(() => expect(r.container.querySelector(".cred-error")!.textContent).toBe("XREAの認証情報を確認できませんでした"))
    // 通信の失敗
    server.overrides["PUT /api/credentials"] = () => {
      throw new TypeError("offline")
    }
    fireEvent.submit(r.container.querySelector("form")!)
    await waitFor(() => expect(r.container.querySelector(".cred-error")!.textContent).toBe("サーバへ接続できません"))
  })

  test("送信中は登録ボタンが無効になり、二重に送信されない", async () => {
    const { r, server } = await mountMissing()
    let release!: () => void
    server.overrides["PUT /api/credentials"] = () => new Promise(res => (release = () => res({ status: 204 })))
    fill(r.container)
    fireEvent.submit(r.container.querySelector("form")!)
    await waitFor(() => expect(submitBtn(r.container).disabled).toBe(true))
    fireEvent.submit(r.container.querySelector("form")!)
    expect(server.requests.filter(q => q.method === "PUT")).toHaveLength(1)
    release()
  })

  test("web-credentials/AC-9: 登録の操作の前後で、ブラウザの保存領域に入力した値が含まれない", async () => {
    const { r, server } = await mountMissing()
    server.overrides["PUT /api/credentials"] = () => ({ status: 204 })
    fill(r.container)
    fireEvent.click(r.container.querySelector("#cred-proton")!)
    type(r.container, "proton-token", "PROTON-PAT-VALUE")
    fireEvent.submit(r.container.querySelector("form")!)
    await waitFor(() => expect(r.container.querySelector("#credentials")).toBeNull())
    const dump = JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage })
    for (const v of ["SECRET-KEY-VALUE", "PROTON-PAT-VALUE", "acct", "s1.xrea.com"]) expect(dump).not.toContain(v)
    expect(location.href).not.toContain("SECRET")
  })

  test("web-credentials/AC-10: 登録画面にダイアログ要素と標準ダイアログの呼び出しがない", async () => {
    const alert = vi.fn()
    vi.stubGlobal("alert", alert)
    vi.stubGlobal("confirm", alert)
    vi.stubGlobal("prompt", alert)
    const { r, server } = await mountMissing()
    server.overrides["PUT /api/credentials"] = () => ({ status: 400, body: { error: { code: "validation_error", message: "x" } } })
    fill(r.container)
    fireEvent.submit(r.container.querySelector("form")!)
    await waitFor(() => expect(r.container.querySelector(".cred-error")).not.toBeNull())
    expect(r.container.querySelector("dialog, [role=dialog], [role=alertdialog]")).toBeNull()
    expect(alert).not.toHaveBeenCalled()
    expect(r.container.querySelector("#credentials")!.closest("main")).not.toBeNull()
  })
})

describe("置き換えと取り消し", () => {
  test("web-credentials/AC-8: 登録済みの状態でヘッダのボタンを押すと登録画面が開き、取り消しで主画面に戻る", async () => {
    fakeServer()
    const r = render(<App store={createStore()} />)
    await waitFor(() => expect(r.container.querySelectorAll(".row").length).toBeGreaterThan(0))
    fireEvent.click(r.container.querySelector("#cred-open")!)
    expect(r.container.querySelector("#credentials")).not.toBeNull()
    expect(r.container.querySelector(".cred-notice")).toBeNull()
    type(r.container, "username", "typed")
    fireEvent.click(r.container.querySelector("#cred-cancel")!)
    await waitFor(() => expect(r.container.querySelector("#credentials")).toBeNull())
    expect(r.container.querySelectorAll(".row").length).toBeGreaterThan(0)
    fireEvent.click(r.container.querySelector("#cred-open")!)
    expect(input(r.container, "username").value).toBe("") // 取り消し時の入力値は破棄する
  })
})
