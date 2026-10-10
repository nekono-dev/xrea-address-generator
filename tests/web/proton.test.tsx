// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact"
import { afterEach, describe, expect, test } from "vitest"
import { App } from "../../web/src/App"
import { createStore } from "../../web/src/store"
import { fakeServer, ready } from "./helpers"

afterEach(cleanup)

describe("照合状態の通知", () => {
  test("web-ui/AC-10: 更新ボタンの押下で再取得の要求が送信され、再ログイン中は帯が表示されて完了後に通知される", async () => {
    const server = fakeServer()
    const store = createStore()
    const r = render(<App store={store} pollMs={20} />)
    await waitFor(() => expect(r.container.querySelector("#proton-status")!.textContent).toContain("315件を参照"))
    // 再取得 → 再ログイン中 → 完了（再ログイン時刻つき）
    const sequence = [ready({ state: "relogin" }), ready({ state: "relogin" }), ready({ reloginAt: "2026-10-10T02:00:00.000Z", updatedAt: "2026-10-10T02:00:00.000Z" })]
    server.overrides["GET /api/proton/status"] = () => ({ status: 200, body: sequence.length > 1 ? sequence.shift() : sequence[0] })
    fireEvent.click(r.getByRole("button", { name: "更新" }))
    await waitFor(() => expect(server.requests.some(q => q.method === "POST" && q.url === "/api/proton/refresh")).toBe(true))
    await waitFor(() => expect(r.container.querySelector(".banner")?.textContent).toContain("再ログインしています"))
    await waitFor(() => expect(r.getByRole("status").textContent).toContain("Proton Pass に再ログインしました"))
    expect(r.container.querySelector(".banner")).toBeNull()
    // 完了後は一覧を取り直す（エントリ名の反映）
    expect(server.requests.filter(q => q.method === "GET" && q.url === "/api/aliases").length).toBeGreaterThanOrEqual(2)
  })

  test("初回表示では、過去の再ログインを通知しない", async () => {
    fakeServer({ proton: ready({ reloginAt: "2026-10-09T00:00:00.000Z" }) })
    const r = render(<App store={createStore()} pollMs={20} />)
    await waitFor(() => expect(r.container.querySelectorAll(".row")).toHaveLength(3))
    await new Promise(res => setTimeout(res, 80))
    expect(r.getByRole("status").textContent).not.toContain("再ログインしました")
  })

  test("照合の取得中に開いた場合、完了すると一覧を取り直してエントリ名を表示する", async () => {
    const server = fakeServer({ proton: ready({ state: "loading", updatedAt: null }) })
    const r = render(<App store={createStore()} pollMs={20} />)
    await waitFor(() => expect(r.container.querySelectorAll(".chip.sk").length).toBe(3))
    server.state.proton = ready()
    await waitFor(() => expect(r.container.querySelectorAll(".chip:not(.sk)").length).toBe(3))
  })

  test("照合に失敗した状態では、帯で固定の文言を表示し、更新ボタンを残す", async () => {
    fakeServer({ proton: ready({ state: "error", error: { kind: "token", message: "Proton Passのアクセストークンが無効か、期限切れです" } }) })
    const r = render(<App store={createStore()} pollMs={20} />)
    await waitFor(() => expect(r.container.querySelector(".banner.error")?.textContent).toContain("アクセストークンが無効か、期限切れです"))
    expect(r.getByRole("button", { name: "更新" })).toBeTruthy()
  })
})
