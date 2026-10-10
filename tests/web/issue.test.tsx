// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact"
import { afterEach, describe, expect, test } from "vitest"
import { App } from "../../web/src/App"
import { createStore } from "../../web/src/store"
import { fakeServer } from "./helpers"

afterEach(cleanup)

async function mount() {
  const server = fakeServer()
  const store = createStore()
  const r = render(<App store={store} />)
  await waitFor(() => expect(r.container.querySelectorAll(".row")).toHaveLength(3))
  await waitFor(() => expect((r.getByRole("button", { name: "発行" }) as HTMLButtonElement).disabled).toBe(false))
  return { r, store, server, name: r.getByRole("textbox", { name: "エイリアス名" }) as HTMLInputElement }
}
const posts = (s: ReturnType<typeof fakeServer>) => s.requests.filter(q => q.method === "POST" && q.url === "/api/aliases")

describe("発行の操作", () => {
  test("web-ui/AC-2: 名前欄でEnterを押すと発行の要求が1回送信され、変換確定中のEnterでは送信されない", async () => {
    const { server, name } = await mount()
    fireEvent.input(name, { target: { value: "travel" } })
    fireEvent.keyDown(name, { key: "Enter", isComposing: true })
    expect(posts(server)).toHaveLength(0)
    fireEvent.keyDown(name, { key: "Enter" })
    await waitFor(() => expect(posts(server)).toHaveLength(1))
    expect(posts(server)[0]!.body).toEqual({ name: "travel", domain: "example.com", forwardTo: "me@mail.example" })
  })

  test("web-ui/AC-3: 名前が空の発行で、要求の名前が空のまま送信され、応答のアドレスの行が強調表示される", async () => {
    const { r, server, name } = await mount()
    fireEvent.keyDown(name, { key: "Enter" })
    await waitFor(() => expect(posts(server)).toHaveLength(1))
    expect(posts(server)[0]!.body.name).toBeUndefined()
    await waitFor(() => expect(r.container.querySelector('.row.flash[data-address="quiet.river42@example.com"]')).not.toBeNull())
  })

  test("web-ui/AC-11: 発行の要求に409が返ると、応答のメッセージが通知に表示される", async () => {
    const { r, server, name } = await mount()
    server.overrides["POST /api/aliases"] = () => ({ status: 409, body: { error: { code: "conflict", message: "shop@example.com はすでに存在します" } } })
    fireEvent.input(name, { target: { value: "shop" } })
    fireEvent.click(r.getByRole("button", { name: "発行" }))
    await waitFor(() => expect(r.getByRole("status").textContent).toContain("shop@example.com はすでに存在します"))
    expect(name.value).toBe("shop") // 失敗時は入力を保持する
  })

  test("web-ui/AC-15: 発行の成功応答から200ミリ秒以内に、新しい行が一覧に現れる", async () => {
    const { r, server, name } = await mount()
    let respondedAt = 0
    const base = server.overrides["POST /api/aliases"]
    server.overrides["POST /api/aliases"] = req => {
      respondedAt = performance.now()
      const a = { address: `${req.body.name}@${req.body.domain}`, name: req.body.name, domain: req.body.domain, forwardTo: req.body.forwardTo, protonEntries: [] }
      return base ? base(req) : { status: 201, body: { alias: a } }
    }
    fireEvent.input(name, { target: { value: "fast" } })
    fireEvent.keyDown(name, { key: "Enter" })
    await waitFor(() => expect(r.container.querySelector('[data-address="fast@example.com"]')).not.toBeNull(), { interval: 5 })
    expect(performance.now() - respondedAt).toBeLessThan(200)
  })

  test("発行の実行中は発行ボタンを無効にして、二重送信を防ぐ", async () => {
    const { r, server, name } = await mount()
    let release!: () => void
    server.overrides["POST /api/aliases"] = async req => {
      await new Promise<void>(res => (release = res))
      return { status: 201, body: { alias: { address: `${req.body.name}@x`, name: req.body.name, domain: "x", forwardTo: "f", protonEntries: [] } } }
    }
    fireEvent.input(name, { target: { value: "once" } })
    fireEvent.keyDown(name, { key: "Enter" })
    await waitFor(() => expect((r.getByRole("button", { name: "発行" }) as HTMLButtonElement).disabled).toBe(true))
    fireEvent.keyDown(name, { key: "Enter" })
    release()
    await waitFor(() => expect(name.value).toBe(""))
    expect(posts(server)).toHaveLength(1)
  })
})
