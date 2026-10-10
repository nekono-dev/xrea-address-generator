// @vitest-environment happy-dom
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact"
import { useState } from "preact/hooks"
import { afterEach, describe, expect, test } from "vitest"
import { Combobox } from "../../web/src/components/Combobox"
import { Dropdown } from "../../web/src/components/Dropdown"
import { Segmented } from "../../web/src/components/Segmented"
import { Toasts } from "../../web/src/components/Toast"
import { IssueForm } from "../../web/src/components/IssueForm"
import { createStore } from "../../web/src/store"
import { fakeServer } from "./helpers"

afterEach(cleanup)

function DropdownHarness() {
  const [v, setV] = useState("example.com")
  return <Dropdown label="ドメイン" items={["example.com", "example.net", "example.org"]} value={v} onChange={setV} />
}

describe("ドロップダウン", () => {
  test("web-ui/AC-4: ドメインを開くと候補が並び、矢印キーとEnterで選択すると表示が切り替わる", () => {
    const r = render(<DropdownHarness />)
    const btn = r.getByRole("button", { name: "ドメイン" })
    fireEvent.keyDown(btn, { key: "ArrowDown" })
    expect(btn.getAttribute("aria-expanded")).toBe("true")
    expect(r.getAllByRole("option").map(o => o.textContent)).toEqual(["example.com", "example.net", "example.org"])
    fireEvent.keyDown(btn, { key: "ArrowDown" })
    fireEvent.keyDown(btn, { key: "ArrowDown" })
    fireEvent.keyDown(btn, { key: "Enter" })
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    expect(btn.textContent).toBe("example.org")
    expect(r.getAllByRole("option", { hidden: true })[2]!.getAttribute("aria-selected")).toBe("true")
  })

  test("Escape と領域外のクリックで閉じる", () => {
    const r = render(<DropdownHarness />)
    const btn = r.getByRole("button", { name: "ドメイン" })
    fireEvent.click(btn)
    expect(btn.getAttribute("aria-expanded")).toBe("true")
    fireEvent.keyDown(btn, { key: "Escape" })
    expect(btn.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(btn)
    fireEvent.click(document.body)
    expect(btn.getAttribute("aria-expanded")).toBe("false")
  })

  test("ネイティブの select は使わない", () => {
    const r = render(<DropdownHarness />)
    expect(r.container.querySelector("select")).toBeNull()
  })
})

describe("転送先の入力部品", () => {
  test("web-ui/AC-5: 形式不正の転送先で誤りが表示されて発行ボタンが無効になり、候補を選ぶと有効になる", async () => {
    fakeServer()
    const store = createStore()
    store.set({ options: { domains: ["example.com"], forwardTargets: ["me@mail.example", "sub@mail.example"] } })
    const r = render(<IssueForm store={store} />)
    const input = r.getByRole("combobox", { name: "転送先" })
    const issue = r.getByRole("button", { name: "発行" }) as HTMLButtonElement
    expect(issue.disabled).toBe(false)
    fireEvent.input(input, { target: { value: "not-an-address" } })
    expect(r.getByText("メールアドレスの形式で入力してください")).toBeTruthy()
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(issue.disabled).toBe(true)
    // 候補を選ぶ（入力を消して候補を開き、2番目を選ぶ）
    fireEvent.input(input, { target: { value: "" } })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    expect((input as HTMLInputElement).value).toBe("sub@mail.example")
    expect(issue.disabled).toBe(false)
    expect(r.queryByText("メールアドレスの形式で入力してください")).toBeNull()
  })

  test("開いたときは入力済みの値に関係なく全候補を表示し、文字を入力したときだけ絞り込む", () => {
    function H() {
      const [v, setV] = useState("me@mail.example")
      return <Combobox label="転送先" value={v} onInput={setV} candidates={["me@mail.example", "sub@mail.example"]} onEnter={() => undefined} />
    }
    const r = render(<H />)
    const input = r.getByRole("combobox")
    fireEvent.focus(input)
    expect(r.getAllByRole("option")).toHaveLength(2)
    fireEvent.click(r.getByRole("button", { name: "候補を開く" }))
    fireEvent.click(r.getByRole("button", { name: "候補を開く" }))
    expect(r.getAllByRole("option", { hidden: true })).toHaveLength(2)
    fireEvent.input(input, { target: { value: "sub" } })
    expect(r.getAllByRole("option").map(o => o.textContent)).toEqual(["sub@mail.example"])
  })

  test("自由入力の値は候補に無くても保持し、部分一致で候補を絞り込む", () => {
    function H() {
      const [v, setV] = useState("")
      return <Combobox label="転送先" value={v} onInput={setV} candidates={["me@mail.example", "sub@mail.example"]} onEnter={() => undefined} />
    }
    const r = render(<H />)
    const input = r.getByRole("combobox")
    fireEvent.input(input, { target: { value: "sub" } })
    expect(r.getAllByRole("option").map(o => o.textContent)).toEqual(["sub@mail.example"])
    fireEvent.input(input, { target: { value: "free@x.test" } })
    expect((input as HTMLInputElement).value).toBe("free@x.test")
    expect(r.getByText("候補なし（入力した値を使います）")).toBeTruthy()
  })
})

describe("排他選択と通知", () => {
  test("排他選択は押したボタンだけが押下状態になる", () => {
    function H() {
      const [v, setV] = useState<"asc" | "desc">("asc")
      return <Segmented label="並び順" items={[{ value: "asc", label: "A→Z" }, { value: "desc", label: "Z→A" }]} value={v} onChange={setV} />
    }
    const r = render(<H />)
    fireEvent.click(r.getByRole("button", { name: "Z→A" }))
    expect(r.getByRole("button", { name: "Z→A" }).getAttribute("aria-pressed")).toBe("true")
    expect(r.getByRole("button", { name: "A→Z" }).getAttribute("aria-pressed")).toBe("false")
  })

  test("通知は画面内の部品として表示される（標準の通知ダイアログを使わない）", async () => {
    const store = createStore()
    const r = render(<Toasts store={store} />)
    store.toast("コピーしました")
    await waitFor(() => expect(r.getByRole("status").textContent).toContain("コピーしました"))
  })
})
