// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact"
import { afterEach, describe, expect, test, vi } from "vitest"
import { App } from "../../web/src/App"
import { confirmText } from "../../web/src/components/AliasList"
import { createStore } from "../../web/src/store"
import { alias, fakeServer, ready } from "./helpers"

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const addresses = (c: Element) => [...c.querySelectorAll(".row .ad")].map(e => e.textContent)

async function mount(init?: Parameters<typeof fakeServer>[0]) {
  const server = fakeServer(init)
  const store = createStore()
  const r = render(<App store={store} />)
  await waitFor(() => expect(r.container.querySelectorAll(".row").length).toBeGreaterThan(0))
  return { r, server, store }
}

describe("一覧の表示・絞り込み・並び替え", () => {
  test("web-ui/AC-6: ドメインを選ぶとそのドメインの行だけが残り、降順への切り替えで並びが逆になる", async () => {
    const { r } = await mount({ aliases: [alias("b@example.com"), alias("a@example.com"), alias("c@example.net")] })
    expect(addresses(r.container)).toEqual(["a@example.com", "b@example.com", "c@example.net"])
    const filter = r.getByRole("button", { name: "ドメインで絞り込み" })
    fireEvent.click(filter)
    const filterOptions = [...r.container.querySelectorAll("#filter [role=option]")]
    expect(filterOptions.map(o => o.textContent)).toEqual(["すべてのドメイン", "example.com", "example.net"])
    fireEvent.click(filterOptions.find(o => o.textContent === "example.com")!)
    expect(addresses(r.container)).toEqual(["a@example.com", "b@example.com"])
    expect(r.container.querySelector("#count")!.textContent).toBe("2件")
    fireEvent.click(r.getByRole("button", { name: "Z→A" }))
    expect(addresses(r.container)).toEqual(["b@example.com", "a@example.com"])
  })

  test("web-ui/AC-7: 行にアドレスと転送先とエントリ名が表示され、照合の取得中は読み込み表示が出る", async () => {
    const { r } = await mount()
    const sns = r.container.querySelector('[data-address="sns@example.net"]')!
    expect(sns.querySelector(".ad")!.textContent).toBe("sns@example.net")
    expect(sns.querySelector("small")!.textContent).toBe("→ me@mail.example")
    expect([...sns.querySelectorAll(".chip")].map(c => c.textContent)).toEqual(["Bluesky", "X (Twitter)"])
    expect(r.container.querySelector('[data-address="bank@example.org"] .chips')).toBeNull() // エントリが無い行は省く
    cleanup()
    const loading = await mount({ proton: ready({ state: "loading", updatedAt: null, itemCount: null }) })
    expect(loading.r.container.querySelectorAll(".chip.sk").length).toBe(3)
    expect(loading.r.container.querySelector("#proton-status")!.textContent).toContain("Protonを照合中")
  })
})

describe("Proton Pass連携が無効なとき", () => {
  test("web-ui/AC-24: 連携が無効の応答を受けると、照合の表示と更新ボタンが出ず、状態の確認も繰り返さない", async () => {
    const server = fakeServer({ proton: ready({ state: "disabled", updatedAt: null, itemCount: null }) })
    const r = render(<App store={createStore()} pollMs={10} />)
    await waitFor(() => expect(r.container.querySelectorAll(".row").length).toBeGreaterThan(0))
    await new Promise(res => setTimeout(res, 60))
    expect(r.container.querySelector("#proton-status")).toBeNull()
    expect(r.container.querySelector("#proton-refresh")).toBeNull()
    expect(r.container.querySelector(".pstat")).toBeNull()
    expect(r.container.querySelector(".chip.sk")).toBeNull()
    expect(server.requests.some(q => q.url === "/api/proton/status")).toBe(false)
  })
})

describe("コピーと削除", () => {
  test("web-ui/AC-8: コピーボタンの押下でクリップボードにアドレスが入り、通知が表示される", async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } })
    const { r } = await mount()
    fireEvent.click(r.container.querySelector('[data-address="shop@example.com"] [data-copy]')!)
    await waitFor(() => expect(r.getByRole("status").textContent).toContain("コピーしました"))
    expect(writeText).toHaveBeenCalledWith("shop@example.com")
  })

  test("web-ui/AC-9: 削除ボタンの押下で行内に確認が出て、確認前には削除の要求が送信されず、エントリがある行では確認文にその名前が含まれる", async () => {
    const { r, server } = await mount()
    const row = () => r.container.querySelector('[data-address="sns@example.net"]')!
    fireEvent.click(row().querySelector("[data-delete]")!)
    expect(row().querySelector(".confirm-text")!.textContent).toBe("Proton Passに「Bluesky」「X (Twitter)」があります。メールを削除しますか？")
    expect(server.requests.some(q => q.method === "DELETE")).toBe(false)
    fireEvent.click(row().querySelector("[data-no]")!)
    expect(row().querySelector(".confirm")).toBeNull()
    fireEvent.click(row().querySelector("[data-delete]")!)
    fireEvent.click(row().querySelector("[data-yes]")!)
    await waitFor(() => expect(r.container.querySelector('[data-address="sns@example.net"]')).toBeNull())
    expect(server.requests.filter(q => q.method === "DELETE").map(q => q.url)).toEqual(["/api/aliases/sns%40example.net"])
    expect(confirmText(alias("bank@example.org"))).toBe("メールアドレスを削除しますか？")
  })

  test("削除がエラー応答のときは、サーバのメッセージを通知し、行を残す", async () => {
    const { r, server } = await mount()
    server.overrides["DELETE /api/aliases/:address"] = () => ({ status: 403, body: { error: { code: "forbidden", message: "転送のみのアドレス以外は削除できません" } } })
    const row = r.container.querySelector('[data-address="bank@example.org"]')!
    fireEvent.click(row.querySelector("[data-delete]")!)
    fireEvent.click(row.querySelector("[data-yes]")!)
    await waitFor(() => expect(r.getByRole("status").textContent).toContain("転送のみのアドレス以外は削除できません"))
    expect(r.container.querySelector('[data-address="bank@example.org"]')).not.toBeNull()
  })

  test("一覧の取得に失敗したときは、失敗の表示と再読み込みのボタンを出す", async () => {
    const server = fakeServer()
    server.overrides["GET /api/aliases"] = () => ({ status: 502, body: { error: { code: "upstream_error", message: "認証情報が正しくありません。" } } })
    const r = render(<App store={createStore()} />)
    await waitFor(() => expect(r.container.querySelector("#list")!.textContent).toContain("認証情報が正しくありません。"))
    delete server.overrides["GET /api/aliases"]
    fireEvent.click(r.getByRole("button", { name: "再読み込み" }))
    await waitFor(() => expect(r.container.querySelectorAll(".row")).toHaveLength(3))
  })
})

describe("転送先の変更", () => {
  const row = (c: Element, address: string) => c.querySelector(`[data-address="${address}"]`)!
  const patches = (s: ReturnType<typeof fakeServer>) => s.requests.filter(q => q.method === "PATCH")

  test("web-ui/AC-17: 行の変更ボタンで入力部品が開き、候補を選んで確定すると変更の要求が送信されて行の転送先が切り替わる", async () => {
    const { r, server } = await mount()
    fireEvent.click(row(r.container, "shop@example.com").querySelector("[data-edit]")!)
    const input = r.getByRole("combobox", { name: "shop@example.com の転送先" }) as HTMLInputElement
    expect(input.value).toBe("me@mail.example")
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.focus(input)
    const option = [...row(r.container, "shop@example.com").querySelectorAll("[role=option]")].find(o => o.textContent === "sub@mail.example")!
    fireEvent.mouseDown(option)
    expect(input.value).toBe("sub@mail.example")
    fireEvent.click(row(r.container, "shop@example.com").querySelector("[data-save]")!)
    await waitFor(() => expect(row(r.container, "shop@example.com").querySelector(".fwd")?.textContent).toBe("→ sub@mail.example"))
    expect(patches(server)).toEqual([{ method: "PATCH", url: "/api/aliases/shop%40example.com", body: { forwardTo: "sub@mail.example" } }])
    expect(r.getByRole("status").textContent).toContain("転送先を変更しました")
    // Enter でも確定できる
    fireEvent.click(row(r.container, "bank@example.org").querySelector("[data-edit]")!)
    const input2 = r.getByRole("combobox", { name: "bank@example.org の転送先" })
    fireEvent.input(input2, { target: { value: "new@mail.example" } })
    fireEvent.keyDown(input2, { key: "Enter" })
    await waitFor(() => expect(row(r.container, "bank@example.org").querySelector(".fwd")?.textContent).toBe("→ new@mail.example"))
  })

  test("web-ui/AC-18: 行内の入力部品で形式不正の転送先を入力すると確定が無効になり、やめるで要求を送らずに閉じる", async () => {
    const { r, server } = await mount()
    fireEvent.click(row(r.container, "shop@example.com").querySelector("[data-edit]")!)
    const input = r.getByRole("combobox", { name: "shop@example.com の転送先" })
    fireEvent.input(input, { target: { value: "not-mail" } })
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect((row(r.container, "shop@example.com").querySelector("[data-save]") as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.click(row(r.container, "shop@example.com").querySelector("[data-cancel]")!)
    expect(row(r.container, "shop@example.com").querySelector("[role=combobox]")).toBeNull()
    expect(row(r.container, "shop@example.com").querySelector(".fwd")?.textContent).toBe("→ me@mail.example")
    // 候補が閉じた状態の Escape でも閉じる
    fireEvent.click(row(r.container, "shop@example.com").querySelector("[data-edit]")!)
    const again = r.getByRole("combobox", { name: "shop@example.com の転送先" })
    fireEvent.keyDown(again, { key: "Escape" }) // 候補を閉じる
    fireEvent.keyDown(again, { key: "Escape" }) // 編集を閉じる
    expect(row(r.container, "shop@example.com").querySelector("[role=combobox]")).toBeNull()
    expect(patches(server)).toHaveLength(0)
  })

  test("変更がエラー応答のときは、サーバのメッセージを通知し、入力を保持する", async () => {
    const { r, server } = await mount()
    server.overrides["PATCH /api/aliases/:address"] = () => ({ status: 503, body: { error: { code: "rate_limited", message: "少し待ってから再度お試しください" } } })
    fireEvent.click(row(r.container, "shop@example.com").querySelector("[data-edit]")!)
    const input = r.getByRole("combobox", { name: "shop@example.com の転送先" }) as HTMLInputElement
    fireEvent.input(input, { target: { value: "x@mail.example" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(r.getByRole("status").textContent).toContain("少し待ってから"))
    expect(input.value).toBe("x@mail.example")
    expect(row(r.container, "shop@example.com").querySelector("[role=combobox]")).not.toBeNull()
  })
})

describe("選択した値の復元", () => {
  test("web-ui/AC-21: 選んだ絞り込みと並び順が、再読み込み後も同じ状態で表示される", async () => {
    const first = await mount({ aliases: [alias("b@example.com"), alias("a@example.com"), alias("c@example.net")] })
    fireEvent.click(first.r.getByRole("button", { name: "ドメインで絞り込み" }))
    fireEvent.click([...first.r.container.querySelectorAll("#filter [role=option]")].find(o => o.textContent === "example.com")!)
    fireEvent.click(first.r.getByRole("button", { name: "Z→A" }))
    cleanup()
    // 再読み込み（保存先は残したまま、画面と状態を作り直す）
    const store = createStore()
    const r = render(<App store={store} />)
    await waitFor(() => expect(addresses(r.container)).toEqual(["b@example.com", "a@example.com"]))
    expect(r.getByRole("button", { name: "ドメインで絞り込み" }).textContent).toContain("example.com")
    expect(r.getByRole("button", { name: "Z→A" }).getAttribute("aria-pressed")).toBe("true")
  })
})

