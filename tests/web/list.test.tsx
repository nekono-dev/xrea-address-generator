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
